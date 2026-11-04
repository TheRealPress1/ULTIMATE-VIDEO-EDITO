/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, checkWindow, windowFields } from "../schemas";

export const TranscriptWord = z.object({
  text: z.string(),
  start: z.number().describe("seconds"),
  end: z.number().describe("seconds"),
});

export const TranscriptSegment = z.object({
  text: z.string(),
  speaker: z.string().optional().describe("optional speaker label for compatibility; the local engine does not identify speakers"),
  words: z.array(TranscriptWord),
});

/** Which local Whisper model transcribes: the bundled-on-first-use base model, or the larger one fetched only on request. */
export const TRANSCRIBE_QUALITIES = ["fast", "accurate"] as const;
export type TranscribeQuality = (typeof TRANSCRIBE_QUALITIES)[number];

/** The model behind each quality, as the result names it. */
export const TRANSCRIBE_MODELS: Record<TranscribeQuality, string> = {
  fast: "whisper-base",
  accurate: "whisper-large-v3-turbo",
};

/** About what the accurate model downloads, once, the first time a call asks for it. */
export const ACCURATE_MODEL_DOWNLOAD = "about 1.6 GB";

/** What the transcript covers and how it was made, beside its segments. */
const TranscriptMeta = {
  start: z.number().optional().describe("source second the transcript starts at, when a window was asked for"),
  end: z.number().optional().describe("source second the transcript ends at, when a window was asked for"),
  model: z.string().optional().describe(`the local model that recognized the speech: ${Object.values(TRANSCRIBE_MODELS).join(" or ")}`),
  language: z.string().optional().describe("the language the call forced; absent when it was detected"),
};

export const transcribe = defineTool({
  name: "transcribe",
  title: "Transcribe speech",
  description:
    `Transcribe speech in a video or audio file locally and write a JSON file, \`{ segments: [{ text, words: [{ text, start, end }] }] }\`, with word-level times in source seconds; returns its path and segment and word counts. \`start\`/\`end\` transcribe only that window (word times stay absolute source seconds; an indexed library file is sliced from its saved transcript instead of being run again). \`language\` forces an ISO 639-1 language instead of detecting it. Supports recordings up to two hours in bounded five-minute sections with overlap. Imported local footage saves completed sections for resume across restart. Uses multilingual Whisper base on this Mac by default (\`quality: "fast"\`); first use downloads about 148 MB of model weights, cached for later offline use. \`quality: "accurate"\` uses Whisper large-v3-turbo instead: better on names, accents and noisy rooms, several times slower, and its first use downloads ${ACCURATE_MODEL_DOWNLOAD} of weights, which happens only when a call asks for it. No media is uploaded for transcription and no speech-service account is required. Automatic speaker identification is not supported. Search the file for the passage you need (grep, jq) rather than reading it whole: a long recording's word timings run to tens of thousands of tokens. Useful for talking-head footage and interviews; review recognized words and timings before precise cuts. A transcript marks only speech; gaps may still contain music or other sound. To caption an edited scene's audible mix, use the captions tool with its scene id.`,
  input: z
    .object({
      path: AssetPath,
      output: z
        .string()
        .optional()
        .describe("absolute path to write the transcript JSON to, or an existing folder to write a fresh transcript file into (default: a fresh file under the system temp dir)"),
      start: windowFields.start.describe("source window start (default 0); word times in the transcript stay absolute source seconds"),
      end: windowFields.end.describe("source window end (default the file's end); at most two hours after start"),
      language: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z]{2,3}$/, "a language code such as `en`, `fr` or `de`")
        .optional()
        .describe("ISO 639-1 code of the spoken language, e.g. `en`, `es`, `de` (default: detected)"),
      quality: z
        .enum(TRANSCRIBE_QUALITIES)
        .optional()
        .describe(`fast (Whisper base, the default) or accurate (Whisper large-v3-turbo: slower; its first use downloads ${ACCURATE_MODEL_DOWNLOAD} once)`),
    })
    .superRefine(checkWindow),
  output: z.object({
    path: z.string().describe("absolute path of the transcript JSON"),
    segments: z.int().describe("segments in the transcript"),
    words: z.int().describe("words across all segments"),
    ...TranscriptMeta,
  }),
  result: z.object({ segments: z.array(TranscriptSegment), ...TranscriptMeta }),
  environment: "renderer",
});
