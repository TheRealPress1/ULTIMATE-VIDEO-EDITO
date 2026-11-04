/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, Bytes, checkWindow } from "../schemas";
import { previewFields } from "./filmstrip";

const Silences = z.array(z.object({ start: z.number(), end: z.number() })).describe("seconds");

const SilenceSearch = z
  .object({
    thresholdDb: z.number().min(-70).max(-20).optional().describe(
      "peak level in dBFS at or below which audio counts as silent (default: about -53); raise it toward -40 for a noisy room, lower it to keep quiet breaths",
    ),
    minSeconds: z.number().min(0.05).max(5).optional().describe("shortest silent stretch reported, in seconds (default: 0.4); 0.12 finds tight pauses at joins"),
  })
  .describe("how silent stretches are found and highlighted");

export const waveform = defineTool({
  name: "waveform",
  title: "Waveform preview",
  description:
    "Render the audio track of a video or audio file as a waveform PNG (local render, no credits) with a timestamp ruler: loudness over time, with silent stretches highlighted in red. A fast, token-efficient audio track preview; the silent spans are also returned as second ranges. `silence` sets the level and minimum length that count as silent, for example a 0.12 s minimum to see tight pauses around a join.",
  input: z.object({ path: AssetPath, ...previewFields, silence: SilenceSearch.optional() }).superRefine(checkWindow),
  output: z.looseObject({
    path: z.string().describe("absolute path of the PNG"),
    silences: Silences,
    silenceThresholdDb: z.number().optional().describe("the peak level used, in dBFS"),
    silenceMinSeconds: z.number().optional().describe("the minimum silent stretch used, in seconds"),
  }),
  result: z.looseObject({ png: Bytes, silences: Silences, silenceThresholdDb: z.number().optional(), silenceMinSeconds: z.number().optional() }),
  environment: "renderer",
});
