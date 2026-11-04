/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// script_read_compare in the renderer. The script comes from a markdown file
// inside the open project (brief.md by default, read the way script_lint
// reads it) or from inline text; the words come from the recording's footage
// index when it has one, else from local Whisper over the window; the
// alignment is the engine's (engine/script-align.ts), run in a worker so a
// long shoot does not stall the editor. The result is saved to the app's own
// project folder, .cutroom/script-read.json, for later reads.

import { BRIEF_FILE, DapiError, SCRIPT_READ_FILE, scriptOf } from "@diffusionstudio/dapi";
import { getLibrary } from "@diffusionstudio/runtime";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { SPEECH_MAX_SECONDS } from "@desktop/speech-types";
import { requestFootage } from "@/lib/footage-cache";
import { transcribeSource } from "@/lib/source-transcription";
import { alignScriptRead } from "@/engine/script-align";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { Asset } from "@diffusionstudio/assets";
import type { ToolOutput } from "@diffusionstudio/dapi";
import type { SpeechSegment } from "@desktop/speech-types";
import type { ScriptAlignOptions, ScriptLine, ScriptReadReport, SpokenWord } from "@/engine/script-align";
import type { ScriptAlignRequest, ScriptAlignResponse } from "@/engine/script-align-worker";
import type { EditorSession } from "../session";
import type { ToolContext, ToolHandler } from "../handler";

/** The largest script file read; a brief is a few kilobytes. */
export const SCRIPT_FILE_MAX_BYTES = 512 * 1024;
/** footage_cut's limit on passages per call. */
const FOOTAGE_CUT_MAX = 100;

const NO_SPEECH = "No speech detected: the recording does not appear to contain recognizable speech in this window.";
const INDEX_BUSY = "Footage indexing is running, and the local speech engine transcribes one recording at a time. Wait for indexing to finish (or cancel it in Footage), then compare again. A recording the index already holds is compared without transcribing.";
const TOO_LONG = "script_read_compare handles recordings up to two hours: local transcription and the footage index stop there, even for a short window. Split the recording into parts under two hours and compare each part.";
const LIMITATIONS = [
  "Words and times come from local speech recognition and are approximate: it can drop stutters and fillers, tidy up halting speech, or hear words in silence. Listen around each join before final cuts.",
  "Takes are matched word by word after normalization; a paraphrase shows up as omitted and inserted words rather than as a match, and lines that share most of their words can trade takes.",
  "Speakers are not separated: an off-camera prompt or a second voice saying a line counts as a take.",
  "The normalization rules (contractions, numbers read aloud) are English; other languages are compared on their literal words.",
];

const isRemote = (source: string) => /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("\\\\");
type Media = Extract<Asset, { type: "AUDIO" | "VIDEO" }>;
type Transcript = { words: SpokenWord[]; kind: "footage-index" | "transcribed"; fingerprint: string | null };

/** `given` as a `/`-separated markdown path inside the project, or an invalid-input error. */
export function projectScriptPath(given: string): string {
  const bad = (message: string) => new DapiError("invalid-input", `script.path: ${message}`);
  if (given.includes("\0")) throw bad("contains a NUL character.");
  if (given.includes("\\")) throw bad(`"${given}" uses backslashes; write it with / like brief.md or drafts/brief.md.`);
  if (given.startsWith("/") || /^[a-z]:/i.test(given) || /^[a-z][a-z\d+.-]+:/i.test(given) || given.startsWith("~")) {
    throw bad(`"${given}" is not inside the project. Pass a project-relative path such as brief.md, or the script as text.`);
  }
  const segments = given.split("/").filter((part) => part && part !== ".");
  if (!segments.length) throw bad("name a markdown file in the project, such as brief.md.");
  if (segments.includes("..")) throw bad(`"${given}" leaves the project. Pass a project-relative path such as brief.md.`);
  if (!/\.(?:md|markdown|txt)$/i.test(segments[segments.length - 1]!)) throw bad(`"${given}" is not a .md or .txt file.`);
  return segments.join("/");
}

function within(root: string, real: string): boolean {
  if (real === root) return true;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return real.startsWith(root.endsWith(separator) ? root : root + separator);
}

/** A project-relative script file, refusing one whose real path leads outside the project. */
async function readProjectScript(session: EditorSession, given: string): Promise<{ path: string; text: string }> {
  const path = projectScriptPath(given);
  const fs = getLibrary(session.world).fs;
  const info = await fs.stat(path);
  if (!info) {
    throw new DapiError("not-found", path === BRIEF_FILE
      ? `The open project has no ${BRIEF_FILE} yet. Write the script there under "## Script" (format: docs/reference/brief.md), or pass script.text.`
      : `No ${path} in the open project.`);
  }
  if (fs.realPath) {
    const [root, real] = await Promise.all([fs.realPath(""), fs.realPath(path)]);
    if (!root || !real || !within(root, real)) throw new DapiError("invalid-input", `script.path: ${path} leads outside the open project.`);
  }
  if (info.size > SCRIPT_FILE_MAX_BYTES) throw new DapiError("invalid-input", `${path} is over ${SCRIPT_FILE_MAX_BYTES / 1024} KB; pass the script section as script.text.`);
  return { path, text: await (await fs.file(path)).text() };
}

const wordsIn = (segments: readonly SpeechSegment[], from: number, to: number): SpokenWord[] =>
  segments.flatMap((segment) => segment.words).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > from && word.start < to);

/**
 * The recording's words in [from, to): the footage index's saved transcript
 * when the library file has one; for a whole library file without one, a
 * fresh index entry (resumable, and what footage_cut needs); otherwise local
 * transcription of the window. The speech engine runs one transcription at a
 * time and an indexing run holds it throughout, so while the project's index
 * is busy nothing is transcribed: the call reports busy rather than failing
 * halfway or taking the engine from the indexing run between its sections.
 */
async function transcriptOf(ctx: ToolContext, session: EditorSession | null, asset: Media, from: number, to: number, assertCurrent: () => void): Promise<Transcript> {
  const dir = session?.project.dir();
  const whole = from <= 0 && to >= asset.duration - 1e-6;
  const idleIndex = async (world: EditorSession["world"], project: string) => {
    const { getFootageService } = await import("@/engine/footage");
    assertCurrent();
    const service = getFootageService(world, project);
    if (service.snapshot().indexing) throw new DapiError("busy", INDEX_BUSY);
    return service;
  };
  if (session && dir && getLibrary(session.world).list().some((item) => item.id === asset.id)) {
    const saved = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_GET, { dir, source: asset.source, duration: asset.duration }, ctx.signal);
    assertCurrent();
    if (saved.transcript) return { words: wordsIn(saved.transcript, from, to), kind: "footage-index", fingerprint: saved.fingerprint };
    const service = await idleIndex(session.world, dir);
    if (whole) {
      await service.indexPaths([asset.id], ctx.signal);
      assertCurrent();
      const item = service.snapshot().items.find((entry) => entry.assetId === asset.id);
      if (item?.status === "no-speech") throw new Error(NO_SPEECH);
      if (item?.status !== "ready" || !item.segments || !item.fingerprint) throw new Error(item?.error ?? "This recording could not be indexed. Try again from Footage, or pass start and end to transcribe a window.");
      return { words: wordsIn(item.segments, from, to), kind: "footage-index", fingerprint: item.fingerprint };
    }
  } else if (session && dir) await idleIndex(session.world, dir);
  const segments = await transcribeSource(asset, { signal: ctx.signal, dir, assertCurrent, ...(whole ? {} : { window: { start: from, end: to } }) });
  assertCurrent();
  return { words: wordsIn(segments, from, to), kind: "transcribed", fingerprint: null };
}

/**
 * The alignment in a worker, so a long shoot leaves the editor responsive;
 * on this thread where workers are unavailable (tests) or one fails to load.
 */
async function alignOffThread(script: ScriptLine[], words: SpokenWord[], options: ScriptAlignOptions, signal: AbortSignal): Promise<ScriptReadReport> {
  signal.throwIfAborted();
  if (typeof Worker === "undefined") return alignScriptRead(script, words, options);
  let worker: Worker;
  try {
    worker = new Worker(new URL("../../engine/script-align-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return alignScriptRead(script, words, options);
  }
  let abort: (() => void) | undefined;
  try {
    const report = await new Promise<ScriptReadReport | null>((resolve, reject) => {
      abort = () => reject(signal.reason ?? new DOMException("The comparison was canceled.", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      worker.onmessage = ({ data }: MessageEvent<ScriptAlignResponse>) => ("error" in data ? reject(new Error(data.error)) : resolve(data.report));
      worker.onerror = (event) => { event.preventDefault(); resolve(null); };
      worker.postMessage({ script, words, options } satisfies ScriptAlignRequest);
    });
    return report ?? alignScriptRead(script, words, options);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}

/** Lines up a recorded read or a multi-take shoot with its script. */
export const scriptReadCompare: ToolHandler<"script_read_compare"> = async ({ path, script, start, end, pauseSeconds, minCoverage, detail }, ctx) => {
  const session = ctx.session?.() ?? null;
  const dir = session?.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if ((ctx.session?.() ?? null) !== session || (session && session.project.dir() !== dir)) {
      throw new DapiError("no-project", "The open project changed while comparing the read. Open the intended project and try again.");
    }
  };
  assertCurrent();

  // The script first: a missing brief fails before any transcription starts.
  let text: string, scriptPath: string | undefined;
  if (script?.text !== undefined) text = script.text;
  else {
    if (!session) throw new DapiError("no-project", `Open the project that holds ${script?.path ?? BRIEF_FILE}, or pass the script as script.text.`);
    ({ path: scriptPath, text } = await readProjectScript(session, script?.path ?? BRIEF_FILE));
    assertCurrent();
  }
  const parsed = scriptOf(text);
  const lines = parsed.lines.map(({ n, text }) => ({ n, text }));
  if (!lines.length) {
    const where = scriptPath ?? "The script text";
    throw new DapiError("invalid-input", parsed.format === "brief"
      ? `${where} has no lines under an exact "## Script" heading. Write them as "1. [beat · emotion] sentence" (docs/reference/brief.md).`
      : `${where} has no script lines.`);
  }

  if (isRemote(path)) throw new DapiError("invalid-input", "script_read_compare uses local recordings. Download the media first and pass its local path or library path.");
  const asset = await resolveAsset(ctx, path);
  assertCurrent();
  requireAssetType(asset, ["AUDIO", "VIDEO"], "a video or audio recording");
  if (isRemote(asset.source)) throw new DapiError("invalid-input", "This library asset points to remote media. Download it locally before comparing.");
  const from = start ?? 0;
  const to = Math.min(end ?? asset.duration, asset.duration);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) {
    throw new DapiError("invalid-input", `Choose a nonempty window inside this recording (it is ${asset.duration.toFixed(2)} s long).`);
  }
  if (asset.duration > SPEECH_MAX_SECONDS) throw new DapiError("invalid-input", TOO_LONG);

  const transcript = await transcriptOf(ctx, session, asset, from, to, assertCurrent);
  if (!transcript.words.some((word) => word.text.trim())) throw new Error(NO_SPEECH);
  const report = await alignOffThread(lines, transcript.words, { pauseSeconds, minCoverage, bounds: { start: from, end: to } }, ctx.signal);
  assertCurrent();

  const inLibrary = !!session && getLibrary(session.world).list().some((item) => item.id === asset.id);
  const fingerprint = transcript.fingerprint;
  const passages = inLibrary && fingerprint
    ? report.keep.map((range) => ({ assetId: asset.id, fingerprint, sourceIn: range.start, sourceOut: range.end, lines: range.lines }))
    : [];
  const warnings = [...parsed.warnings, ...report.warnings];
  if (!passages.length && report.keep.length) {
    warnings.push(inLibrary
      ? "This recording has no footage index entry yet, so no footage_cut passages are listed. Run footage_index on it, then compare again."
      : "This recording is not imported into the project, so no footage_cut passages are listed. Import it and run footage_index to assemble a cut from the takes.");
  }
  if (passages.length > FOOTAGE_CUT_MAX) warnings.push(`footage_cut takes up to ${FOOTAGE_CUT_MAX} passages per call; these ${passages.length} need more than one cut.`);

  const fullLines = report.lines.map((line) => ({ ...line, takeCount: line.takes.length }));
  const output: ToolOutput<"script_read_compare"> = {
    source: { path: asset.path || path, assetId: inLibrary ? asset.id : null, fingerprint, start: from, end: to, transcript: transcript.kind },
    script: { kind: scriptPath ? "file" : "text", ...(scriptPath ? { path: scriptPath } : {}), format: parsed.format, lines: lines.length },
    lines: fullLines,
    unspoken: report.unspoken,
    readOrder: report.readOrder,
    extraSpeech: report.extraSpeech,
    extraSpeechTotal: report.extraSpeechTotal,
    coverage: report.coverage,
    overallWpm: report.overallWpm,
    keep: report.keep,
    passages,
    savedPath: null,
    warnings,
    limitations: LIMITATIONS,
  };

  if (session) {
    const fs = getLibrary(session.world).fs;
    const savedPath = fs.absolute?.(SCRIPT_READ_FILE) ?? `${dir}/${SCRIPT_READ_FILE}`;
    try {
      assertCurrent();
      const saved = { version: 1, comparedAt: new Date().toISOString(), ...output, savedPath };
      await fs.write(SCRIPT_READ_FILE, new Blob([`${JSON.stringify(saved, null, 2)}\n`], { type: "application/json" }));
      output.savedPath = savedPath;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      assertCurrent();
      warnings.push(`The result could not be saved to ${SCRIPT_READ_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (detail === "best") {
    output.lines = fullLines.map((line) => line.best === null ? { ...line, takes: [] } : { ...line, takes: [line.takes[line.best]!], best: 0 });
  }
  return output;
};
