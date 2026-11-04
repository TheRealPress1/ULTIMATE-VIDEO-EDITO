/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toolByName } from "@diffusionstudio/dapi";
import { gemini } from "../../gemini";

import type { MainHandler } from "../handler";

/**
 * Asks in main, where the key is kept and the network is the app's: the
 * agent's sandbox has neither, and never sees the key. Library paths resolve
 * against the project the editor has open. A call that fails its checks
 * throws before anything is sent; one that runs answers like a job.
 */
export const askGemini: MainHandler<"ask_gemini"> = async (args, ctx) =>
  // Parsing the public schema keeps anything private a future change adds out of the agent's result.
  toolByName("ask_gemini").output.parse(await gemini().ask(args, { project: ctx.project?.() ?? null, signal: ctx.signal }));
