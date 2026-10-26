/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DapiError } from "@diffusionstudio/dapi";
import { transcribeSource } from "@/lib/source-transcription";
import { MAX_TRANSCRIPTION_SECONDS } from "@/lib/local-transcription";
import { requireAssetType, resolveAsset } from "../lib/assets";
import type { ToolHandler } from "../handler";

const MAX_SECONDS = MAX_TRANSCRIPTION_SECONDS;
const isRemote = (path: string) =>
  /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("\\\\");
const limitations = [
  "This is local speech transcription evidence, not a full semantic analysis of the audio or an answer from an audio-language model.",
  "Speaker diarization, voice identity, host/guest roles, active-speaker tracking, music identification, emotion and non-speech sound recognition are not supported. No speaker labels have been inferred.",
  "Recognized words and word times are approximate. Review the original audio before precise edits; gaps in the transcript can contain music or other sound.",
];

/** Local windowed speech evidence. Prompts remain context for the caller; they are not executed or treated as facts. */
export const listen: ToolHandler<"listen"> = async (
  { path, prompt, start, end },
  ctx,
) => {
  const session = ctx.session?.(),
    dir = session?.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (
      ctx.session?.() !== session ||
      (session && session.project.dir() !== dir)
    )
      throw new DapiError(
        "no-project",
        "The open project changed while preparing speech evidence.",
      );
  };
  assertCurrent();
  if (isRemote(path))
    throw new DapiError(
      "invalid-input",
      "Listen uses local media. Download the audio or video and provide its local path.",
    );
  const asset = await resolveAsset(ctx, path);
  assertCurrent();
  requireAssetType(asset, ["AUDIO", "VIDEO"], "a video or audio asset");
  if (isRemote(asset.source))
    throw new DapiError(
      "invalid-input",
      "This library asset points to remote media. Download it locally before listening.",
    );
  const from = start ?? 0,
    to = Math.min(end ?? asset.duration, asset.duration);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= to)
    throw new DapiError(
      "invalid-input",
      "Choose a nonempty audio window inside this source.",
    );
  if (to - from > MAX_SECONDS)
    throw new DapiError(
      "invalid-input",
      "Listen supports local recordings up to two hours, processed in bounded sections.",
    );
  const transcript = await transcribeSource(asset, { signal: ctx.signal, dir, assertCurrent, window: { start: from, end: to } });
  assertCurrent();
  const segments = transcript.flatMap((segment) => {
    const words = segment.words
      .filter(
        (word) =>
          word.text.trim() &&
          Number.isFinite(word.start) &&
          Number.isFinite(word.end) &&
          word.end > from &&
          word.start < to &&
          word.end > word.start,
      )
      .map((word) => ({
        text: word.text,
        start: Math.round((Math.max(from, word.start) - from) * 1e6) / 1e6,
        end: Math.round((Math.min(word.end, to) - from) * 1e6) / 1e6,
        sourceStart: Math.max(from, word.start),
        sourceEnd: Math.min(word.end, to),
      }));
    if (!words.length) return [];
    return [
      {
        text: words.map((w) => w.text.trim()).join(" "),
        start: words[0]!.start,
        end: words.at(-1)!.end,
        sourceStart: words[0]!.sourceStart,
        sourceEnd: words.at(-1)!.sourceEnd,
        words,
      },
    ];
  });
  const recognized = segments.length > 0;
  const result = [
    `Local speech evidence for source ${from.toFixed(2)}–${to.toFixed(2)}s. Times below are relative to this window; structured sourceStart/sourceEnd are absolute source seconds.`,
    limitations[0],
    limitations[1],
    ...(recognized
      ? segments.map(
          (s) => `[${s.start.toFixed(2)}–${s.end.toFixed(2)}s] ${s.text}`,
        )
      : [
          "No recognizable speech was returned. This is not proof that the window is silent.",
        ]),
    ...(prompt
      ? [
          "The supplied prompt is preserved as requestedPrompt for the editing agent; this tool does not infer identities or answer semantic audio questions.",
        ]
      : []),
  ].join("\n");
  return {
    result,
    method: "local-speech-transcription",
    start: from,
    end: to,
    timestampOrigin: "window",
    segments,
    limitations: [...limitations],
    ...(prompt ? { requestedPrompt: prompt } : {}),
  };
};
