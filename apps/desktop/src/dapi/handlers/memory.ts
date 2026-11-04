/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DapiError } from "@diffusionstudio/dapi";
import { agentMemoryStore } from "../../agent-memory";
import type { MainHandler } from "../handler";

/** `memory`: the user's saved profile and setup notes, shared with Settings' "What agents remember". */
export const memory: MainHandler<"memory"> = async (args, ctx) => {
  if (!ctx.agentMemoryFile) throw new DapiError("unsupported", "Agent memory is turned off in this Cutroom session, so nothing is read or saved.");
  return agentMemoryStore(ctx.agentMemoryFile).tool(args);
};
