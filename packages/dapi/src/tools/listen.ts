/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, checkWindow, windowFields } from "../schemas";
const TimedWord = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  sourceStart: z.number(),
  sourceEnd: z.number(),
});
export const listen = defineTool({
  name: "listen",
  title: "Inspect local speech evidence",
  description:
    "Inspect speech in a local audio/video recording/window (up to two hours, processed in bounded sections) using the bundled local Whisper engine. No media upload, upstream account or paid audio API. Returns recognized words with window-relative times and absolute sourceStart/sourceEnd; start/end always echo the analyzed source window. This is speech evidence, not full semantic listening. Prompt is preserved as context for the editing agent and is not answered by an audio-language model. Does NOT diarize speakers, recognize voices or identities, infer host/guest roles, identify music, track the active speaker, or describe non-speech audio. Never attach inferred speaker labels to the transcript. For requests to follow whoever is speaking, use reframe with mode speakers: its separate local audio/video model can frame a supported visible speaker and widens the view when uncertain. That model does not assign names or diarize off-camera voices. Review words and approximate timing before precise cuts; transcript gaps may contain other sound. Uses the same local speech runtime/model as transcribe.",
  input: z
    .object({
      path: AssetPath.describe(
        "Absolute local file path, or an imported library path. Remote URLs are not supported.",
      ),
      prompt: z
        .string()
        .max(10000)
        .optional()
        .describe(
          "Editing question preserved as context; does not enable semantic analysis, diarization or speaker identity.",
        ),
      start: windowFields.start.describe(
        "Source window start (default 0); returned start/end within segments and words are relative to this point.",
      ),
      end: windowFields.end.describe(
        "Source window end (default media duration); select at most 7200 seconds.",
      ),
    })
    .superRefine(checkWindow),
  output: z.object({
    result: z.string(),
    method: z.literal("local-speech-transcription"),
    start: z.number(),
    end: z.number(),
    timestampOrigin: z.literal("window"),
    requestedPrompt: z.string().optional(),
    segments: z.array(
      z.object({
        text: z.string(),
        start: z.number(),
        end: z.number(),
        sourceStart: z.number(),
        sourceEnd: z.number(),
        words: z.array(TimedWord),
      }),
    ),
    limitations: z.array(z.string()),
  }),
  environment: "renderer",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});
