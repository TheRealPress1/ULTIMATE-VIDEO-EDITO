/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";

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

export const transcribe = defineTool({
  name: "transcribe",
  title: "Transcribe speech",
  description:
    "Transcribe speech in a video or audio file locally and write a JSON file, `{ segments: [{ text, words: [{ text, start, end }] }] }`, with word-level times in source seconds; returns its path and segment and word counts. Supports recordings up to two hours in bounded five-minute sections with overlap. Imported local footage saves completed sections for resume across restart. Uses multilingual Whisper base on this Mac; first use downloads about 148 MB of model weights, cached for later offline use. No media is uploaded for transcription and no speech-service account is required. Automatic speaker identification is not supported. Search the file for the passage you need (grep, jq) rather than reading it whole: a long recording's word timings run to tens of thousands of tokens. Useful for talking-head footage and interviews; review recognized words and timings before precise cuts. A transcript marks only speech; gaps may still contain music or other sound. To caption an edited scene's audible mix, use the captions tool with its scene id.",
  input: z.object({
    path: AssetPath,
    output: z.string().optional().describe("absolute path to write the transcript JSON to (default: a fresh file under the system temp dir)"),
  }),
  output: z.object({
    path: z.string().describe("absolute path of the transcript JSON"),
    segments: z.int().describe("segments in the transcript"),
    words: z.int().describe("words across all segments"),
  }),
  result: z.object({ segments: z.array(TranscriptSegment) }),
  environment: "renderer",
});
