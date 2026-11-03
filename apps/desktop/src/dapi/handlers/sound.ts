/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { earshot } from "../../addons/earshot";
import { analyzeSound } from "../../addons/earshot/analyze";

import type { MainHandler } from "../handler";

/**
 * Listens in main, where the audio intelligence add-on and its warm earshot
 * worker live. Library paths resolve against the project the editor has
 * open. `sound_effects` is a renderer tool: its takes go into the live library.
 */
export const soundAnalyze: MainHandler<"sound_analyze"> = (args, ctx) => analyzeSound(earshot(), args, ctx.project?.() ?? null, ctx.signal);
