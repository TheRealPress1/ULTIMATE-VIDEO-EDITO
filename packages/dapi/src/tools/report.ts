/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

/** Trailing app log entries attached to an issue by default. */
export const ISSUE_LOG_TAIL = 50;

export const report = defineTool({
  name: "report",
  title: "Report a bug",
  description:
    "Report a bug in Blackout. Disabled unless this build explicitly configures CUTROOM_REPORT_REPO. When configured, files a GitHub issue in that repository with app version, platform and recent logs, using the authenticated gh CLI, and returns its URL. Request the user's approval before publishing diagnostics. Use logs to collect local diagnostics without publishing.",
  input: z.object({
    title: z.string().min(1).describe("one-line summary of the problem"),
    body: z.string().optional().describe("what happened, in markdown: expected vs actual, and anything the diagnostics won't show"),
    commands: z.array(z.string()).optional().describe("the cutroom commands or tool calls that reproduce it, in order"),
    logs: z.int().min(0).optional().describe(`trailing app log entries to attach (0 to omit; default: ${ISSUE_LOG_TAIL})`),
  }),
  output: z.object({ url: z.string() }),
  environment: "main",
});
