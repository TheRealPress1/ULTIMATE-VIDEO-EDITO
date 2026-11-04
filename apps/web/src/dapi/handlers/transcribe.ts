/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DapiError, TRANSCRIBE_MODELS } from "@diffusionstudio/dapi";
import { getLibrary } from "@diffusionstudio/runtime";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { SPEECH_MAX_SECONDS } from "@desktop/speech-types";
import { requestFootage } from "@/lib/footage-cache";
import { transcribeSource } from "@/lib/source-transcription";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { Asset } from "@diffusionstudio/assets";
import type { SpeechSegment } from "@desktop/speech-types";
import type { ToolHandler } from "../handler";

const NO_SPEECH = "No speech detected: the audio does not appear to contain recognizable speech.";
const NO_SPEECH_IN_WINDOW = "No speech detected in this window: the audio there does not appear to contain recognizable speech.";

const isRemote = (source: string) => /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("\\\\");

/**
 * The part of a transcript inside [from, to), word times kept in source
 * seconds and clamped to the window, as transcribing the window alone would
 * give them. A segment cut by the window is re-spelled from its words.
 */
export function sliceTranscript(segments: readonly SpeechSegment[], from: number, to: number): SpeechSegment[] {
  return segments.flatMap((segment) => {
    const words = segment.words
      .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > from && word.start < to)
      .map((word) => ({ text: word.text, start: Math.max(from, word.start), end: Math.min(to, word.end) }));
    if (!words.length) return [];
    const whole = words.length === segment.words.length;
    return [{ text: whole ? segment.text : words.map((word) => word.text.trim()).filter(Boolean).join(" "), ...(segment.speaker ? { speaker: segment.speaker } : {}), words }];
  });
}

const hasWords = (segments: readonly SpeechSegment[]) => segments.some((segment) => segment.words.length > 0);

/** The footage index's saved transcript of a library file, or null when it has none (it indexes recordings up to two hours). */
async function savedTranscript(asset: Extract<Asset, { type: "AUDIO" | "VIDEO" }>, dir: string, signal: AbortSignal): Promise<SpeechSegment[] | null> {
  if (isRemote(asset.source) || asset.duration > SPEECH_MAX_SECONDS) return null;
  const saved = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_GET, { dir, source: asset.source, duration: asset.duration }, signal);
  return saved.transcript;
}

/**
 * The asset's audio, transcribed locally; the main process writes the
 * transcript to its file. A library file shares the project's footage index:
 * whole, it is indexed (and resumes across restarts); a window of one already
 * indexed is sliced from the saved transcript. A forced language or the
 * accurate model always runs afresh, as the index holds neither.
 */
export const transcribe: ToolHandler<"transcribe"> = async ({ path, start, end, language, quality }, ctx) => {
  const session = ctx.session?.();
  const dir = session?.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (session && (ctx.session() !== session || session.project.dir() !== dir)) throw new Error("The open project changed while transcribing footage. Try again in the intended project.");
  };
  assertCurrent();
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["AUDIO", "VIDEO"], "a video or audio asset");
  assertCurrent();

  const asked = start !== undefined || end !== undefined;
  const from = start ?? 0;
  const to = Math.min(end ?? asset.duration, asset.duration);
  if (asked && !(from < to)) {
    throw new DapiError("invalid-input", `Choose a nonempty window inside this file (it is ${asset.duration.toFixed(2)} s long).`);
  }
  if (to - from > SPEECH_MAX_SECONDS) {
    throw new DapiError(
      "invalid-input",
      asked
        ? "Local transcription supports windows up to two hours."
        : `This recording is ${(asset.duration / 3600).toFixed(1)} hours long; transcribe covers up to two hours per call. Pass start and end to transcribe it in windows.`,
    );
  }
  // A window that is the whole file is the whole file: indexed and resumable like one.
  const windowed = asked && (from > 0 || to < asset.duration);
  const meta = {
    ...(asked ? { start: from, end: to } : {}),
    model: TRANSCRIBE_MODELS[quality ?? "fast"],
    ...(language ? { language } : {}),
  };
  const shared = quality !== "accurate" && !language;

  if (shared && session && getLibrary(session.world).list().some((item) => item.id === asset.id)) {
    if (!windowed) {
      const { getFootageService } = await import("@/engine/footage");
      assertCurrent();
      const service = getFootageService(session.world, dir!);
      await service.indexPaths([asset.id], ctx.signal);
      assertCurrent();
      const item = service.snapshot().items.find((item) => item.assetId === asset.id);
      if (item?.status === "no-speech") throw new Error(NO_SPEECH);
      if (item?.status !== "ready" || !item.segments) throw new Error(item?.error ?? "This source could not be indexed. Try again from Footage.");
      return { segments: item.segments, ...meta };
    }
    const saved = await savedTranscript(asset, dir!, ctx.signal);
    assertCurrent();
    if (saved) {
      const segments = sliceTranscript(saved, from, to);
      if (!hasWords(segments)) throw new Error(NO_SPEECH_IN_WINDOW);
      return { segments, ...meta };
    }
  }

  const transcript = await transcribeSource(asset, {
    signal: ctx.signal,
    dir,
    assertCurrent,
    ...(windowed ? { window: { start: from, end: to } } : {}),
    ...(language ? { language } : {}),
    ...(quality === "accurate" ? { quality } : {}),
  });
  assertCurrent();
  if (!hasWords(transcript)) throw new Error(windowed ? NO_SPEECH_IN_WINDOW : NO_SPEECH);
  return { segments: transcript, ...meta };
};
