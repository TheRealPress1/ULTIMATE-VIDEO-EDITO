/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

/** Rows of background work the app holds: running ones, and ones that ended in the last few minutes. */
export const CONTEXT_JOB_LIMIT = 20;

export const ContextJob = z.object({
  id: z.string().describe("the job's id: poll a segment (or generate sam-2.1) job with job, an analyze job with analyze action status"),
  kind: z.enum(["segment", "analyze"]).describe("which tool started it"),
  model: z.string().optional().describe("the model or method it runs: sam-2.1-<size>, local-evidence"),
  state: z.enum(["queued", "running", "done", "failed", "canceled"]),
  phase: z.string().nullable().optional().describe("what it is doing now, while it runs"),
  progress: z.number().nullable().describe("0..1 through its current phase; null when unknown"),
  path: z.string().optional().describe("what it works on: the footage or the analyzed file"),
  src: z.string().optional().describe("a finished mask's library path, for `<mask src>`"),
  error: z.string().optional(),
});

/**
 * What the project's source cannot say: the JSX already holds the scenes,
 * the selection, and the work area, so the report is only the folders, the
 * playhead, the fonts actually registered, and the background jobs.
 */
export const context = defineTool({
  name: "context",
  title: "App context",
  description:
    "Report the current app context: the folder projects are saved to (always reported), the folder of the project the app has open (null when none is), where its playhead sits in seconds, the registered font families, and the background jobs the app holds (segment mask tracks and analyze jobs: running ones and those that ended in the last few minutes, with their state and progress).",
  input: z.object({}),
  output: z.object({
    rootDir: z.string().nullable().describe("folder the last project was saved to; null until one has been saved"),
    projectDir: z.string().nullable().describe("absolute path of the open project; null when none is open"),
    currentTime: z
      .number()
      .nullable()
      .describe("playhead in seconds, the unit the source places clips in; null when no scene is active or no project is open"),
    fontFamilies: z
      .array(z.string())
      .describe("families registered in the world drawing the project; the editor default is always among them"),
    jobs: z
      .array(ContextJob)
      .max(CONTEXT_JOB_LIMIT)
      .optional()
      .describe("background jobs: running ones first, then those that ended in the last few minutes, newest first within each tool; they live until the app reloads"),
  }),
  environment: "renderer",
});
