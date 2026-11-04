/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What `analyze` reads media with in the app: the same parts the single-pass
// tools use (the footage index and local Whisper, the waveform's silences,
// the visual index, auto frame selection, contact sheets), plus the analysis
// cache and the audio add-on's status, install and timeline in main. The
// handler takes these as dependencies so its tests can use fakes.

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { formatTimecode, getAssetFile, getLibrary, stampTimestampLabel, waveformAsset } from "@diffusionstudio/runtime";
import { planSheet } from "@diffusionstudio/encoder";
import { isUrlSource } from "@diffusionstudio/assets";
import { DapiError } from "@diffusionstudio/dapi";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { requestFootage } from "@/lib/footage-cache";
import { transcribeSource } from "@/lib/source-transcription";
import { pickInformativeTimes } from "./frame-triage";
import { requireAssetType, resolveAsset } from "./assets";
import { editorSession } from "../session";
import { sheetSizes } from "./analyze-pack";

import type { Asset } from "@diffusionstudio/assets";
import type { DapiErrorCode } from "@diffusionstudio/dapi";
import type { ToolContext } from "../handler";
import type { PlacedFrame, PromptHit, Span, VisualSampleLike } from "./analyze-pack";
import type { SpeechSegment } from "@desktop/speech-types";

type Media = Extract<Asset, { type: "AUDIO" | "VIDEO" }>;

/** The file being analyzed, as the handler sees it. */
export type AnalyzeMedia = {
  /** The path the caller gave. */
  path: string;
  id: string;
  /** Where the bytes are: project-relative for the library's own files, else absolute. */
  source: string;
  duration: number;
  video: boolean;
  audio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  /** In the open project's library (not a transient file resolved in place). */
  library: boolean;
  /** A file on this Mac, not a URL. */
  local: boolean;
  /** The open project's folder, when one is. */
  dir: string | null;
  /** The resolved asset, for the media readers; the handler never looks inside. */
  asset: unknown;
};

/** Checkpoints of one analysis window, under the project's analysis cache. */
export type AnalyzeCache = { cached: Record<string, unknown>; put(chunk: string, value: unknown): Promise<void> };

export type AnalyzeEarshot = {
  /** The add-on's state, or null when this build has none. */
  status(): Promise<{ state: string; unsupported?: boolean; error?: string } | null>;
  /** Starts (or joins) its install and returns at once. */
  install(): Promise<void>;
  events(media: AnalyzeMedia, window: Span, signal: AbortSignal): Promise<{ summary: string; result: Record<string, unknown> }>;
};

export type AnalyzeDeps = {
  inspect(ctx: ToolContext, path: string): Promise<AnalyzeMedia>;
  cache(media: AnalyzeMedia, key: string, signal: AbortSignal): Promise<AnalyzeCache | null>;
  /** The footage index's saved transcript of the whole file, or null when it has none. */
  indexedSpeech(media: AnalyzeMedia, signal: AbortSignal): Promise<SpeechSegment[] | null>;
  transcribe(media: AnalyzeMedia, window: Span, signal: AbortSignal, assertCurrent: () => void): Promise<SpeechSegment[]>;
  silences(media: AnalyzeMedia, window: Span, signal: AbortSignal): Promise<Span[]>;
  /** The visual index's samples of the file, or null when it is not indexed. */
  visualSamples(media: AnalyzeMedia, signal: AbortSignal): Promise<{ samples: VisualSampleLike[]; sampleInterval: number } | null>;
  /** Times the footage settles into a new look, at most `max`; null when they cannot be found here (no WebGPU). */
  scenes(media: AnalyzeMedia, window: Span, max: number, signal: AbortSignal): Promise<number[] | null>;
  /** Description-mode matches for the prompt (local CLIP) when the file has a description index; empty otherwise. */
  describe(media: AnalyzeMedia, prompt: string, signal: AbortSignal): Promise<PromptHit[]>;
  /** The contact sheets, one image per sheet of the placed frames. */
  sheets(media: AnalyzeMedia, frames: readonly PlacedFrame[], signal: AbortSignal): Promise<Array<{ bytes: Uint8Array; mimeType: string }>>;
  timecode(time: number, frameRate: number | undefined): string;
  earshot: AnalyzeEarshot;
};

const isRemote = (source: string) => isUrlSource(source) || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("\\\\");

const media = (value: AnalyzeMedia): Media => value.asset as Media;

/** Sheets are drawn no larger than this, so each stays well under the inline limit as a JPEG. */
const SHEET_MAX = { width: 1600, height: 1000 };
const INLINE_MAX_BYTES = 1 << 20;

async function inspect(ctx: ToolContext, path: string): Promise<AnalyzeMedia> {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["AUDIO", "VIDEO"], "a video or audio file");
  const session = ctx.session();
  const library = !!session && !asset.transient && getLibrary(session.world).list().some((item) => item.id === asset.id);
  let video = asset.type === "VIDEO", audio = asset.type === "AUDIO";
  if (asset.type === "VIDEO") {
    // A video's audio track is what speech and silences need; probe it rather than trust the extension.
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await getAssetFile(asset)) });
    try {
      video = !!(await input.getPrimaryVideoTrack());
      audio = !!(await input.getPrimaryAudioTrack());
    } catch {
      audio = true;
    } finally {
      input.dispose();
    }
  }
  return {
    path,
    id: asset.id,
    source: asset.source,
    duration: asset.duration,
    video,
    audio,
    ...(asset.type === "VIDEO" ? { width: asset.width, height: asset.height, frameRate: asset.frameRate } : {}),
    library,
    local: !isRemote(asset.source),
    dir: session?.project.dir() ?? null,
    asset,
  };
}

async function cache(value: AnalyzeMedia, key: string, signal: AbortSignal): Promise<AnalyzeCache | null> {
  if (!value.dir || !value.local) return null;
  const request = { dir: value.dir, key, sources: [value.source] };
  const call = async <T,>(run: (id: string) => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const cancel = () => void mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_CANCEL, { id }).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try { return await run(id); } finally { signal.removeEventListener("abort", cancel); }
  };
  const got = await call((id) => mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_GET, { ...request, id }));
  return {
    cached: got.chunks,
    put: (chunk, stored) => call((id) => mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_PUT, { ...request, id, fingerprint: got.fingerprint, chunk, value: stored })),
  };
}

async function indexedSpeech(value: AnalyzeMedia, signal: AbortSignal): Promise<SpeechSegment[] | null> {
  if (!value.dir || !value.library || !value.local) return null;
  const result = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_GET, { dir: value.dir, source: value.source, duration: value.duration }, signal);
  return result.transcript;
}

function transcribe(value: AnalyzeMedia, window: Span, signal: AbortSignal, assertCurrent: () => void): Promise<SpeechSegment[]> {
  return transcribeSource(media(value), { signal, dir: value.dir ?? undefined, assertCurrent, window });
}

async function silences(value: AnalyzeMedia, window: Span, signal: AbortSignal): Promise<Span[]> {
  signal.throwIfAborted();
  const rendered = await waveformAsset(media(value), { start: window.start, end: window.end });
  signal.throwIfAborted();
  return rendered.silences;
}

async function visualSamples(value: AnalyzeMedia, signal: AbortSignal): Promise<{ samples: VisualSampleLike[]; sampleInterval: number } | null> {
  if (!value.dir || !value.library || !value.local || !value.video) return null;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await getAssetFile(media(value))) });
  let sourceStart = 0;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    sourceStart = Math.max(0, (await track.getFirstTimestamp()) ?? 0);
  } finally {
    input.dispose();
  }
  signal.throwIfAborted();
  const result = await mainBridge.call(MAIN_CHANNELS.VISUAL_GET, { dir: value.dir, source: value.source, duration: value.duration, sourceStart });
  signal.throwIfAborted();
  return result.analysis ? { samples: result.analysis.samples, sampleInterval: result.analysis.sampleInterval } : null;
}

async function scenes(value: AnalyzeMedia, window: Span, max: number, signal: AbortSignal): Promise<number[] | null> {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await getAssetFile(media(value))) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const first = (await track.getFirstTimestamp()) ?? 0;
    signal.throwIfAborted();
    const picked = await pickInformativeTimes(track, { from: first + window.start, to: first + window.end, max });
    signal.throwIfAborted();
    return picked.map((time) => Math.max(0, time - first));
  } catch (error) {
    signal.throwIfAborted();
    // No adapter, or a GPU that went away: the caller spaces frames evenly instead.
    if (/WebGPU|GPU adapter/i.test((error as Error)?.message ?? "")) return null;
    throw error;
  } finally {
    input.dispose();
  }
}

async function describe(value: AnalyzeMedia, prompt: string, signal: AbortSignal): Promise<PromptHit[]> {
  const session = editorSession();
  if (!session || session.project.dir() !== value.dir || !value.library || !value.video) return [];
  const { getVisualService } = await import("@/engine/visual-footage");
  const service = getVisualService(session.world, session.project.dir());
  // Searches an index the user built; never downloads the description model.
  const result = await service.descriptions.search(prompt.slice(0, 1000), value.id, signal);
  return result.matches
    .filter((match) => match.assetId === value.id && match.score > 0)
    .slice(0, 12)
    .map((match) => ({ time: match.time, score: Math.round(match.score * 4 * 1000) / 1000, terms: ["description"] }));
}

/** One sheet's frames decoded at cell size and drawn into a labelled grid, as a JPEG under the inline limit. */
async function sheets(value: AnalyzeMedia, frames: readonly PlacedFrame[], signal: AbortSignal): Promise<Array<{ bytes: Uint8Array; mimeType: string }>> {
  if (!frames.length) return [];
  const asset = media(value);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await getAssetFile(asset)) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new DapiError("wrong-kind", "This file has no video track to draw frames from.");
    const first = (await track.getFirstTimestamp()) ?? 0;
    const source = { width: await track.getDisplayWidth(), height: await track.getDisplayHeight() };
    const layouts = sheetSizes(frames.length).map((size) => {
      const plan = planSheet(size, source);
      const scale = Math.min(1, SHEET_MAX.width / plan.width, SHEET_MAX.height / plan.height);
      return { size, scale, plan };
    });
    const cellWidth = Math.max(1, Math.round(Math.max(...layouts.map(({ plan, scale }) => plan.cellWidth * scale))));
    const sink = new CanvasSink(track, cellWidth < source.width ? { width: cellWidth } : undefined);
    const images: CanvasImageSource[] = new Array(frames.length);
    const ordered = frames.map((frame, index) => ({ frame, index })).sort((a, b) => a.frame.time - b.frame.time);
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(ordered.map(({ frame }) => first + frame.time))) {
      signal.throwIfAborted();
      const { index } = ordered[i++]!;
      if (wrapped) images[index] = wrapped.canvas;
    }
    const out: Array<{ bytes: Uint8Array; mimeType: string }> = [];
    let offset = 0;
    for (const { size, scale, plan } of layouts) {
      const margin = 4, gutter = 8;
      const cellW = Math.max(1, Math.floor(plan.cellWidth * scale)), cellH = Math.max(1, Math.floor(plan.cellHeight * scale));
      const canvas = new OffscreenCanvas(2 * margin + plan.columns * cellW + gutter * (plan.columns - 1), 2 * margin + plan.rows * cellH + gutter * (plan.rows - 1));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#444";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let cell = 0; cell < size; cell++) {
        const frame = frames[offset + cell]!;
        const image = images[offset + cell];
        const x = margin + (cell % plan.columns) * (cellW + gutter), y = margin + Math.floor(cell / plan.columns) * (cellH + gutter);
        if (image) ctx.drawImage(image, x, y, cellW, cellH);
        ctx.save();
        ctx.translate(x, y);
        stampTimestampLabel(ctx, cellH, formatTimecode(frame.time, value.frameRate || 30), { minBandHeight: 22 });
        ctx.restore();
      }
      offset += size;
      let bytes: Uint8Array | undefined;
      for (const quality of [0.82, 0.68, 0.5, 0.36]) {
        signal.throwIfAborted();
        bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
        if (bytes.byteLength <= INLINE_MAX_BYTES) break;
      }
      out.push({ bytes: bytes!, mimeType: "image/jpeg" });
    }
    return out;
  } finally {
    input.dispose();
  }
}

const EARSHOT_CODES = new Set<DapiErrorCode>(["no-project", "not-found", "invalid-input", "busy", "unsupported", "canceled"]);

const earshot: AnalyzeEarshot = {
  async status() {
    try {
      return await mainBridge.call(MAIN_CHANNELS.EARSHOT_STATUS, undefined);
    } catch {
      return null;
    }
  },
  async install() {
    await mainBridge.call(MAIN_CHANNELS.EARSHOT_INSTALL, undefined);
  },
  async events(value, window, signal) {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const cancel = () => void mainBridge.call(MAIN_CHANNELS.EARSHOT_EVENTS_CANCEL, { id }).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const reply = await mainBridge.call(MAIN_CHANNELS.EARSHOT_EVENTS, { id, dir: value.dir, path: value.source, start: window.start, end: window.end });
      return { summary: reply.summary, result: reply.result };
    } catch (error) {
      signal.throwIfAborted();
      const message = (error as Error)?.message ?? String(error);
      const match = /^\[([a-z-]+)\] ([\s\S]*)$/.exec(message);
      if (match && EARSHOT_CODES.has(match[1] as DapiErrorCode)) throw new DapiError(match[1] as DapiErrorCode, match[2]!);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
};

/** The app's readers. */
export const analyzeDeps: AnalyzeDeps = {
  inspect,
  cache,
  indexedSpeech,
  transcribe,
  silences,
  visualSamples,
  scenes,
  describe,
  sheets,
  timecode: (time, frameRate) => formatTimecode(time, frameRate || 30),
  earshot,
};
