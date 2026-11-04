/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  ANALYZE_FOCUS,
  ANALYZE_FRAME_BUDGET,
  ANALYZE_JOB_SECONDS,
  ANALYZE_MAX_SECONDS,
  ANALYZE_SECTION_LIMIT,
  ANALYZE_STATUS_WAIT_SECONDS,
  DapiError,
  isDapiError,
} from "@diffusionstudio/dapi";
import {
  assembleSections,
  chooseFrames,
  limitationsFor,
  placeFrames,
  promptHits,
  promptKeywords,
  readAudioEvents,
  sectionBounds,
  suggestChecks,
} from "../lib/analyze-pack";
import { analyzeDeps } from "../lib/analyze-media";

import type { AnalyzeDepth, AnalyzeFocus, ContextJob, ToolArgs, ToolResult } from "@diffusionstudio/dapi";
import type { SpeechSegment } from "@desktop/speech-types";
import type { AnalyzeDeps, AnalyzeMedia } from "../lib/analyze-media";
import type { AudioEventItem, PromptHit, Span, VisualSampleLike, Word } from "../lib/analyze-pack";
import type { ToolContext, ToolHandler } from "../handler";

type Result = ToolResult<"analyze">;
type State = Result["state"];
type SpeechOrigin = NonNullable<Result["speech"]>["origin"];
type VisualOrigin = NonNullable<Result["visual"]>["origin"];
type EventsState = NonNullable<Result["audio"]>["events"]["state"];

/** Scene detection scans at 2 fps; past this the scan costs more than it tells, and frames are spaced evenly. */
const SCENE_SCAN_MAX_SECONDS = 1800;
/** The audio add-on's timeline runs for windows up to this long. */
const EVENTS_MAX_SECONDS = 1800;
/** A long window's start waits this long, so a cached or quick analysis still answers in one call. */
const START_WAIT_MS = 15_000;
/** Ended jobs stay listed this long (context shows them), and are forgotten after `FORGET_MS`. */
const RECENT_MS = 10 * 60_000;
const FORGET_MS = 30 * 60_000;
const MAX_JOBS = 50;
const CACHE_VERSION = "analyze-v1";
const SUMMARY_CHARS = 1200;
const MAX_SILENCES = 100;

type Request = { path: string; from: number; to: number; depth: AnalyzeDepth; focus: Set<AnalyzeFocus>; keywords: string[]; prompt?: string };

type Job = {
  id: string;
  key: string;
  path: string;
  state: State;
  phase: string;
  fraction: number | null;
  controller: AbortController;
  done: Promise<void>;
  result?: Result;
  failure?: unknown;
  createdAt: number;
  endedAt?: number;
};

type Run = { signal: AbortSignal; report(phase: Phase): void; assertCurrent(): void };

/** About how far through the whole analysis each step starts, for progress. */
const PHASES = { cache: 0.01, speech: 0.03, silences: 0.45, visual: 0.55, scenes: 0.6, audio: 0.75, frames: 0.9 } as const;
type Phase = keyof typeof PHASES;

export type AnalyzerOptions = { startWaitMs?: number; statusWaitMs?: number; now?: () => number };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const ended = (state: State) => state === "done" || state === "failed" || state === "canceled";

/** Words of the window, in order, from transcript segments in source seconds. */
function windowWords(segments: readonly SpeechSegment[], from: number, to: number): Word[] {
  return segments
    .flatMap((segment) => segment.words)
    .filter((word) => word.text.trim() && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > from && word.start < to)
    .map((word) => ({ text: word.text, start: round(Math.max(from, word.start)), end: round(Math.min(to, word.end)) }))
    .sort((a, b) => a.start - b.start);
}

// Cache values come back from disk: each is checked before it is trusted.
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readWords(value: unknown): Word[] | undefined {
  if (!Array.isArray(value) || value.length > 100_000) return undefined;
  const words: Word[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const { text, start, end } = item as Record<string, unknown>;
    if (typeof text !== "string" || !isNumber(start) || !isNumber(end) || end < start) return undefined;
    words.push({ text, start, end });
  }
  return words;
}

function readSpans(value: unknown): Span[] | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  return value.every((item) => item && typeof item === "object" && isNumber(item.start) && isNumber(item.end))
    ? value.map((item) => ({ start: item.start as number, end: item.end as number }))
    : undefined;
}

function readScenes(value: unknown): number[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const times = (value as { times?: unknown }).times;
  return Array.isArray(times) && times.length <= 1000 && times.every(isNumber) ? times : undefined;
}

function readEvents(value: unknown): { items: AudioEventItem[]; summary: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { items, summary } = value as { items?: unknown; summary?: unknown };
  if (!Array.isArray(items) || items.length > 200 || typeof summary !== "string") return undefined;
  const valid = items.every((item) => item && typeof item === "object" && isNumber(item.start) && Array.isArray(item.labels) && item.labels.every((label: unknown) => typeof label === "string"));
  return valid ? { items: items as AudioEventItem[], summary } : undefined;
}

function shorten(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Gathers the evidence for one window and lays it out. Each costly step is
 * checkpointed in the analysis cache (when the file is local and a project is
 * open), so a repeat call, or one after a restart, reuses what was done.
 */
async function runAnalysis(request: Request, item: AnalyzeMedia, deps: AnalyzeDeps, run: Run): Promise<Result> {
  const { from, to, depth, focus, keywords } = request;
  const { signal, report } = run;
  const rethrowAbort = (error: unknown) => {
    if (signal.aborted) throw signal.reason ?? error;
  };
  const sight = focus.has("visual") || focus.has("text");

  report("cache");
  let cache: Awaited<ReturnType<AnalyzeDeps["cache"]>> = null;
  try {
    cache = await deps.cache(item, `${CACHE_VERSION}:${round(from)}:${round(to)}`, signal);
  } catch (error) {
    rethrowAbort(error);
  }
  let cached = false;
  const recall = <T,>(chunk: string, read: (value: unknown) => T | undefined): T | undefined => {
    const stored = cache?.cached[chunk];
    const value = stored === undefined ? undefined : read(stored);
    if (value !== undefined) cached = true;
    return value;
  };
  const remember = async (chunk: string, value: unknown) => {
    try {
      await cache?.put(chunk, value);
    } catch (error) {
      rethrowAbort(error);
    }
  };

  // Speech: the footage index's transcript when the file has one, else Whisper over the window.
  let words: Word[] | null = null;
  let speechOrigin: SpeechOrigin = item.audio ? "skipped" : "none";
  let speechNote: string | undefined;
  if (focus.has("speech") && item.audio) {
    report("speech");
    let indexed: SpeechSegment[] | null = null;
    try {
      indexed = await deps.indexedSpeech(item, signal);
    } catch (error) {
      rethrowAbort(error);
    }
    if (indexed) {
      words = windowWords(indexed, from, to);
      speechOrigin = "footage-index";
    } else {
      const saved = recall("speech", readWords);
      if (saved) {
        words = saved;
        speechOrigin = "transcribed";
      } else {
        try {
          words = windowWords(await deps.transcribe(item, { start: from, end: to }, signal, run.assertCurrent), from, to);
          speechOrigin = "transcribed";
          await remember("speech", words);
        } catch (error) {
          rethrowAbort(error);
          if (/no speech/i.test(message(error))) {
            words = [];
            speechOrigin = "transcribed";
            await remember("speech", words);
          } else {
            speechOrigin = "failed";
            speechNote = message(error);
          }
        }
      }
    }
    if (words && !words.length) speechNote ??= "No recognizable speech in this window. That does not prove it is silent.";
  }

  // Silences, which say whether a section is quiet.
  let silences: Span[] | null = null;
  if ((focus.has("audio") || focus.has("speech")) && item.audio) {
    report("silences");
    silences = recall("silences", readSpans) ?? null;
    if (!silences) {
      try {
        silences = (await deps.silences(item, { start: from, end: to }, signal)).filter((span) => span.end > from && span.start < to);
        await remember("silences", silences);
      } catch (error) {
        rethrowAbort(error);
      }
    }
  }

  // The visual index's labels, text and people, when the file has been indexed.
  let samples: VisualSampleLike[] | null = null;
  let sampleInterval: number | undefined;
  let visualOrigin: VisualOrigin = item.video ? "skipped" : "none";
  if (sight && item.video) {
    report("visual");
    let indexed: Awaited<ReturnType<AnalyzeDeps["visualSamples"]>> = null;
    try {
      indexed = await deps.visualSamples(item, signal);
    } catch (error) {
      rethrowAbort(error);
    }
    if (indexed) {
      sampleInterval = indexed.sampleInterval;
      samples = indexed.samples
        .filter((sample) => sample.time >= from && sample.time < to)
        .map((sample) => ({
          time: sample.time,
          labels: focus.has("visual") ? sample.labels : [],
          text: focus.has("text") ? sample.text : [],
          people: focus.has("visual") ? sample.people : 0,
        }));
      visualOrigin = "visual-index";
    } else visualOrigin = "frames-only";
  }

  // Where the footage settles into a new look: section cuts and the frames' first choice.
  const budget = ANALYZE_FRAME_BUDGET[depth];
  let scenes: number[] = [];
  let frameSelection: "scene-change" | "even" | "none" = "none";
  if (sight && item.video) {
    frameSelection = "even";
    const chunk = `scenes-${depth}`;
    const saved = recall(chunk, readScenes);
    if (saved) {
      scenes = saved;
      frameSelection = "scene-change";
    } else if (to - from <= SCENE_SCAN_MAX_SECONDS) {
      report("scenes");
      try {
        const found = await deps.scenes(item, { start: from, end: to }, budget, signal);
        if (found) {
          scenes = found.filter((time) => time >= from && time < to).map((time) => round(time));
          frameSelection = "scene-change";
          await remember(chunk, { times: scenes });
        }
      } catch (error) {
        rethrowAbort(error);
      }
    }
  }

  // Sound events, only from an add-on that is ready; otherwise its install starts and this pack goes without.
  let events: AudioEventItem[] | null = null;
  let eventsState: EventsState = "skipped";
  let eventsNote: string | undefined;
  let eventsSummary: string | undefined;
  if (focus.has("audio") && item.audio) {
    const saved = recall("events", readEvents);
    if (saved) {
      events = saved.items;
      eventsSummary = saved.summary || undefined;
      eventsState = "included";
    } else if (to - from > EVENTS_MAX_SECONDS) {
      eventsNote = "Sound events are gathered for windows up to 30 minutes; analyze a shorter window with focus audio for them.";
    } else {
      report("audio");
      const status = await deps.earshot.status().catch(() => null);
      if (!status) {
        eventsState = "unavailable";
        eventsNote = "Sound events need the audio add-on, which this build does not have.";
      } else if (status.state === "ready") {
        try {
          const reply = await deps.earshot.events(item, { start: from, end: to }, signal);
          events = readAudioEvents(reply.result, from, to);
          eventsSummary = reply.summary ? shorten(reply.summary, SUMMARY_CHARS) : undefined;
          eventsState = "included";
          await remember("events", { items: events, summary: eventsSummary ?? "" });
        } catch (error) {
          rethrowAbort(error);
          eventsState = "failed";
          eventsNote = `Sound events could not be gathered: ${message(error)}`;
        }
      } else if (status.unsupported) {
        eventsState = "unavailable";
        eventsNote = `Sound events need the audio add-on, which can't run on this Mac${status.error ? ` (${status.error})` : ""}.`;
      } else if (status.state === "installing") {
        eventsState = "installing";
        eventsNote = "The audio add-on is still installing in the background; sound events will be available on a later call.";
      } else if (status.state === "removing") {
        eventsState = "unavailable";
        eventsNote = "The audio add-on is being removed in Settings, so this pack has no sound events.";
      } else {
        // Never waited on: the install runs in the background and a later call gets the events.
        void deps.earshot.install().catch(() => {});
        eventsState = "installing";
        eventsNote = "The audio add-on (about 2.4 GB) started installing in the background; sound events will be available on a later call.";
      }
    }
  }

  // The prompt's words, matched against what was gathered: ranking only.
  const hits: PromptHit[] = promptHits(keywords, words ?? [], samples);
  if (keywords.length && request.prompt && samples && focus.has("visual")) {
    try {
      hits.push(...(await deps.describe(item, request.prompt, signal)));
    } catch (error) {
      rethrowAbort(error);
    }
  }

  report("frames");
  const bounds = sectionBounds(from, to, scenes, ANALYZE_SECTION_LIMIT[depth]);
  const picked = sight && item.video ? chooseFrames({ from, to, budget, scenes, prompt: hits, bounds }) : [];
  const placed = placeFrames(picked);
  let images: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  let sheetNote: string | undefined;
  if (placed.length) {
    try {
      images = await deps.sheets(item, placed, signal);
    } catch (error) {
      rethrowAbort(error);
      sheetNote = `The frames could not be drawn: ${message(error)}`;
    }
  }
  const drawn = images.length ? placed : [];
  const sections = assembleSections({ bounds, words, silences, samples, events, frames: drawn, keywords });
  const frames = drawn.map((frame) => ({ ...frame, timecode: deps.timecode(frame.time, item.frameRate) }));
  const sheets = images.map((image, index) => {
    const cells = frames.filter((frame) => frame.sheet === index);
    const first = cells[0]!, last = cells.at(-1)!;
    return {
      index,
      timecode: first.timecode === last.timecode ? first.timecode : `${first.timecode}-${last.timecode}`,
      start: first.time,
      end: last.time,
      cells: cells.length,
      bytes: image.bytes,
      mimeType: image.mimeType,
    };
  });

  const limitations = limitationsFor({
    video: item.video && sight,
    frames: frames.length,
    length: to - from,
    frameSelection,
    speech: speechOrigin,
    visual: visualOrigin,
    events: eventsState,
    eventsNote,
    keywords: keywords.length,
  });
  if (speechOrigin === "failed" && speechNote) limitations.push(`Speech could not be gathered: ${speechNote}`);
  if (sheetNote) limitations.push(sheetNote);

  return {
    state: "done",
    method: "local-evidence",
    source: {
      path: request.path,
      duration: item.duration,
      start: from,
      end: to,
      video: item.video,
      audio: item.audio,
      ...(item.width ? { width: item.width, height: item.height } : {}),
      ...(item.frameRate ? { frameRate: item.frameRate } : {}),
    },
    depth,
    focus: ANALYZE_FOCUS.filter((name) => focus.has(name)),
    ...(keywords.length ? { promptKeywords: keywords } : {}),
    speech: { origin: speechOrigin, words: words?.length ?? 0, ...(speechNote ? { note: speechNote } : {}) },
    visual: { origin: visualOrigin, samples: samples?.length ?? 0, ...(sampleInterval ? { sampleInterval } : {}), frameSelection: frames.length ? frameSelection : "none" },
    ...(item.audio
      ? {
          audio: {
            silences: (silences ?? []).slice(0, MAX_SILENCES).map((span) => ({ start: round(span.start), end: round(span.end) })),
            events: {
              state: eventsState,
              ...(eventsNote ? { note: eventsNote } : {}),
              ...(eventsSummary ? { summary: eventsSummary } : {}),
              ...(events ? { items: events } : {}),
            },
          },
        }
      : {}),
    sections,
    frames,
    sheets,
    suggestedChecks: suggestChecks({
      path: request.path,
      from,
      to,
      video: item.video && sight,
      sections,
      frames: drawn,
      speech: speechOrigin,
      visual: visualOrigin,
      library: item.library,
      events: eventsState,
    }),
    limitations,
    cached,
  };
}

/**
 * The analyze tool over `deps`: short windows answer in the call, long ones
 * become jobs that `status` follows. Jobs run one at a time (speech and frame
 * decoding share the machine), live in the page, and are listed for context.
 */
export function createAnalyzer(deps: AnalyzeDeps, options: AnalyzerOptions = {}) {
  const startWaitMs = options.startWaitMs ?? START_WAIT_MS;
  const statusWaitMs = options.statusWaitMs ?? ANALYZE_STATUS_WAIT_SECONDS * 1000;
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  let queue: Promise<void> = Promise.resolve();

  const forget = () => {
    for (const [id, job] of jobs) if (job.endedAt !== undefined && now() - job.endedAt > FORGET_MS) jobs.delete(id);
    while (jobs.size > MAX_JOBS) {
      const oldest = [...jobs.values()].filter((job) => job.endedAt !== undefined).sort((a, b) => a.endedAt! - b.endedAt!)[0];
      if (!oldest) break;
      jobs.delete(oldest.id);
    }
  };

  const finish = (job: Job, state: State, failure?: unknown) => {
    if (ended(job.state)) return;
    job.state = state;
    job.failure = failure;
    job.endedAt = now();
  };

  function answer(job: Job): Result {
    if (job.state === "done" && job.result) return { ...job.result, jobId: job.id };
    if (job.state === "failed" || job.state === "canceled") {
      return { state: job.state, jobId: job.id, method: "local-evidence", ...(job.failure !== undefined ? { error: message(job.failure) } : {}) };
    }
    return { state: job.state, jobId: job.id, method: "local-evidence", progress: { phase: job.phase, fraction: job.fraction } };
  }

  /** Waits for the job to end, up to `ms`, or until the caller goes away. */
  async function settle(job: Job, ms: number, signal: AbortSignal): Promise<void> {
    if (ended(job.state) || ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      job.done,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
      new Promise<void>((resolve) => { onAbort = resolve; signal.addEventListener("abort", onAbort, { once: true }); }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }

  async function start(args: ToolArgs<"analyze">, ctx: ToolContext): Promise<Result> {
    const session = ctx.session();
    const dir = session?.project.dir() ?? null;
    // Only a project's analysis writes into it (its cache, its footage index): without one, nothing to guard.
    const assertCurrent = () => {
      if (session && (ctx.session() !== session || session.project.dir() !== dir)) {
        throw new DapiError("no-project", "The open project changed while analyzing. Open the intended project and analyze again.");
      }
    };
    const path = args.path!;
    const item = await deps.inspect(ctx, path);
    ctx.signal.throwIfAborted();
    assertCurrent();
    if (!item.local) throw new DapiError("invalid-input", "analyze reads local media. Download the video first (media_download or web_media_download), then analyze its library path.");
    if (!item.video && !item.audio) throw new DapiError("wrong-kind", "This file has neither a video nor an audio track to analyze.");
    const from = args.start ?? 0;
    const to = Math.min(args.end ?? item.duration, item.duration);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= to) {
      throw new DapiError("invalid-input", `Choose a nonempty window inside this file (it is ${round(item.duration, 2)} s long).`);
    }
    if (to - from > ANALYZE_MAX_SECONDS) throw new DapiError("invalid-input", "analyze covers up to two hours per call; pass a start/end window.");
    const focus = new Set<AnalyzeFocus>(args.focus?.length ? args.focus : ANALYZE_FOCUS);
    const request: Request = { path, from, to, depth: args.depth ?? "standard", focus, keywords: promptKeywords(args.prompt), ...(args.prompt?.trim() ? { prompt: args.prompt.trim() } : {}) };
    const key = JSON.stringify([dir, item.id, item.source, from, to, request.depth, [...focus].sort(), request.keywords]);

    forget();
    let job = [...jobs.values()].find((existing) => existing.key === key && !ended(existing.state));
    if (!job) {
      const created: Job = {
        id: `analyze-${crypto.randomUUID()}`,
        key,
        path,
        state: "queued",
        phase: "queued",
        fraction: null,
        controller: new AbortController(),
        done: Promise.resolve(),
        createdAt: now(),
      };
      const signal = created.controller.signal;
      const report = (phase: Phase) => {
        if (ended(created.state)) return;
        created.phase = phase;
        created.fraction = PHASES[phase];
      };
      const previous = queue;
      created.done = (async () => {
        await previous;
        if (ended(created.state)) return;
        created.state = "running";
        try {
          const result = await runAnalysis(request, item, deps, { signal, report, assertCurrent: () => { signal.throwIfAborted(); assertCurrent(); } });
          signal.throwIfAborted();
          created.result = result;
          finish(created, "done");
        } catch (error) {
          if (signal.aborted) finish(created, "canceled", signal.reason ?? error);
          else finish(created, "failed", error);
        }
      })();
      queue = created.done;
      jobs.set(created.id, created);
      job = created;
    }

    const current = job;
    if (to - from <= ANALYZE_JOB_SECONDS) {
      // A short window answers in the call; the caller going away stops it.
      const stop = () => current.controller.abort(new DapiError("canceled", "The analyze call was canceled."));
      ctx.signal.addEventListener("abort", stop, { once: true });
      try {
        await current.done;
      } finally {
        ctx.signal.removeEventListener("abort", stop);
      }
      if (current.state === "failed" || current.state === "canceled") {
        const failure = current.failure;
        throw isDapiError(failure) || failure instanceof Error ? failure : new Error(message(failure));
      }
      return answer(current);
    }
    await settle(current, startWaitMs, ctx.signal);
    return answer(current);
  }

  function find(id: string): Job {
    const job = jobs.get(id);
    if (!job) {
      throw new DapiError("not-found", `No analyze job ${id}. Jobs live in the app until it reloads; start the analysis again, and the steps it finished are reused from the cache.`);
    }
    return job;
  }

  const analyze: ToolHandler<"analyze"> = async (args, ctx) => {
    switch (args.action ?? "start") {
      case "status": {
        const job = find(args.jobId!);
        await settle(job, statusWaitMs, ctx.signal);
        return answer(job);
      }
      case "cancel": {
        const job = find(args.jobId!);
        if (!ended(job.state)) {
          job.controller.abort(new DapiError("canceled", "Canceled."));
          finish(job, "canceled", new DapiError("canceled", "Canceled."));
        }
        return answer(job);
      }
      default:
        return start(args, ctx);
    }
  };

  /** Running jobs and ones that ended recently, newest first, for context. */
  function rows(): ContextJob[] {
    forget();
    return [...jobs.values()]
      .filter((job) => job.endedAt === undefined || now() - job.endedAt <= RECENT_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => ({
        id: job.id,
        kind: "analyze" as const,
        model: "local-evidence",
        state: job.state,
        ...(ended(job.state) ? {} : { phase: job.phase }),
        progress: job.state === "done" ? 1 : job.fraction,
        path: job.path,
        ...(job.state === "failed" || job.state === "canceled" ? { error: message(job.failure) } : {}),
      }));
  }

  return { analyze, rows };
}

const analyzer = createAnalyzer(analyzeDeps);

/** A timestamped evidence pack for a whole file, for the calling agent to interpret. */
export const analyze = analyzer.analyze;

/** analyze's jobs, for context. */
export const analyzeJobRows = analyzer.rows;
