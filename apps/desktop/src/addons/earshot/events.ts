/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `analyze`'s sound events: earshot's timeline at low detail over one file or
// a window of it. Asked only of an add-on that is already installed, so it
// never waits on an install; `analyze` starts one with EARSHOT_INSTALL
// instead and carries on without events.

import { DapiError } from "@diffusionstudio/dapi";
import { analyzeSound } from "./analyze";

import type { ToolArgs } from "@diffusionstudio/dapi";
import type { EarshotService } from "./index";
import type { EarshotEventsReply, EarshotEventsRequest } from "./types";

export async function earshotEvents(
  service: Pick<EarshotService, "installer" | "privateDirs" | "call" | "earshotVersion">,
  request: EarshotEventsRequest,
  signal?: AbortSignal,
): Promise<EarshotEventsReply> {
  if (!request || typeof request.path !== "string" || !request.path.trim()) throw new DapiError("invalid-input", "Name the file to listen to.");
  if (!(await service.installer.isReady())) throw new DapiError("busy", "Audio intelligence isn't installed yet.");
  const args = {
    action: "timeline",
    path: request.path,
    detail: "low",
    ...(typeof request.start === "number" && Number.isFinite(request.start) && request.start > 0 ? { start: request.start } : {}),
    ...(typeof request.end === "number" && Number.isFinite(request.end) ? { end: request.end } : {}),
  } as ToolArgs<"sound_analyze">;
  const reply = await analyzeSound(service as EarshotService, args, request.dir ?? null, signal);
  return { version: reply.version, summary: reply.summary, result: reply.result };
}
