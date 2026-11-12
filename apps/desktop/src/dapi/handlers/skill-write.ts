/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DapiError } from "@diffusionstudio/dapi";
import { agentMemoryStore } from "../../agent-memory";
import { agentSkillsStore } from "../../agent-skills";
import type { MainHandler } from "../handler";

/**
 * `skill_write`: the user's own skills, in the app's data beside Cutroom's
 * bundled ones. Pausing memory in Settings stops agents saving skills as
 * well as notes, so nothing is written while it is paused; the skills
 * already saved stay listed by `skills`.
 */
export const skillWrite: MainHandler<"skill_write"> = async (args, ctx) => {
  if (!ctx.agentSkillsDir || !ctx.agentMemoryFile) throw new DapiError("unsupported", "Saving user skills is turned off in this Blackout session.");
  // A memory file that can't be read is Settings' to report; it doesn't hold up skills.
  const paused = await agentMemoryStore(ctx.agentMemoryFile).read().then((doc) => !doc.enabled, () => false);
  if (paused) {
    throw new DapiError("unsupported", "Agent memory is paused in Blackout's Settings, which pauses saved skills too, so nothing was written. The user can turn it back on under What agents remember.");
  }
  return agentSkillsStore(ctx.agentSkillsDir).write(args.operations, "agent");
};
