/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLibrary } from "@diffusionstudio/runtime";
import { DapiError } from "@diffusionstudio/dapi";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

import type { Asset } from "@diffusionstudio/assets";
import type { DapiErrorCode, ToolOutput } from "@diffusionstudio/dapi";
import type { SoundEffectsReply, SoundEffectsRequest } from "@desktop/addons/earshot/types";
import type { ToolContext, ToolHandler } from "../handler";

/** Where takes live in the library: `assets/sfx/` on disk. */
const FOLDER = "sfx";

const CODES = new Set<DapiErrorCode>(["no-project", "not-found", "ambiguous", "wrong-kind", "invalid-input", "busy", "sign-in-required", "unsupported", "canceled"]);

const canceled = () => new DapiError("canceled", "The sound effects call was canceled.");

/** Main's `[code] message` back into the DapiError it was (IPC carries messages only). */
function fromMain(error: unknown): Error {
  const message = (error as Error)?.message ?? String(error);
  const match = /^\[([a-z-]+)\] ([\s\S]*)$/.exec(message);
  if (match && CODES.has(match[1] as DapiErrorCode)) return new DapiError(match[1] as DapiErrorCode, match[2]!);
  return error instanceof Error ? error : new Error(message);
}

/** Has main run one request, cancelled with the call. */
async function inMain<R extends SoundEffectsReply["action"]>(request: SoundEffectsRequest & { action: R }, ctx: ToolContext): Promise<Extract<SoundEffectsReply, { action: R }>> {
  if (ctx.signal.aborted) throw canceled();
  const cancel = () => void mainBridge.call(MAIN_CHANNELS.SOUND_EFFECTS_CANCEL, { id: request.id }).catch(() => {});
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    return (await mainBridge.call(MAIN_CHANNELS.SOUND_EFFECTS_RUN, request)) as Extract<SoundEffectsReply, { action: R }>;
  } catch (error) {
    if (ctx.signal.aborted) throw canceled();
    throw fromMain(error);
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
  }
}

/**
 * The bank and the audit are main's alone. A render lands in the open
 * project's `assets/sfx/` (main writes it, the project's disk being main's)
 * and is imported here into the live library, by its project path, as the
 * library's own scan would link it.
 */
export const soundEffects: ToolHandler<"sound_effects"> = async (args, ctx) => {
  const id = crypto.randomUUID();
  switch (args.action) {
    case "list": {
      const reply = await inMain({ id, action: "list", ...(args.category ? { category: args.category } : {}), ...(args.kind ? { kind: args.kind } : {}) }, ctx);
      return { action: "list", version: reply.version, summary: reply.summary, bank: reply.bank, categories: reply.categories, ...(reply.sounds ? { sounds: reply.sounds } : {}) };
    }
    case "check": {
      const dir = ctx.session()?.project.dir() ?? null;
      const reply = await inMain({ id, action: "check", dir, path: args.path!, ...(args.category ? { category: args.category } : {}), ...(args.role ? { role: args.role } : {}) }, ctx);
      return { action: "check", version: reply.version, summary: reply.summary, path: reply.path, audit: reply.audit };
    }
    case "render": {
      const session = ctx.requireSession();
      const dir = session.project.dir();
      const reply = await inMain({
        id, action: "render", dir, sound: args.id!,
        ...(args.dur !== undefined ? { dur: args.dur } : {}),
        ...(args.apex !== undefined ? { apex: args.apex } : {}),
        ...(args.pitch !== undefined ? { pitch: args.pitch } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      }, ctx);
      if (ctx.signal.aborted) throw canceled();
      if (ctx.session() !== session || session.project.dir() !== dir) {
        throw new DapiError("no-project", "The open project changed while the sound rendered. Open the intended project and render again.");
      }
      const library = getLibrary(session.world);
      const { assets, failed } = await library.import([reply.source], { folder: FOLDER });
      if (!assets[0]) {
        throw new DapiError("unsupported", `The rendered take couldn't be imported (${failed[0]?.error.message ?? "the library refused it"}). It is at ${reply.path}.`);
      }
      // The library's own instance: a reload racing this import may have replaced the one it answered with.
      const asset: Asset = library.get(assets[0].id) ?? assets[0];
      await library.flush();
      const output: ToolOutput<"sound_effects"> = {
        action: "render",
        version: reply.version,
        summary: reply.summary,
        src: asset.path,
        assetId: asset.id,
        path: reply.path,
        sound: reply.sound,
        seed: reply.seed,
        durationSeconds: reply.durationSeconds,
        onsetSeconds: reply.onsetSeconds,
        peakSeconds: reply.peakSeconds,
        endSeconds: reply.endSeconds,
        ...(reply.peakDb !== undefined ? { peakDb: reply.peakDb } : {}),
        ...(reply.edits ? { edits: reply.edits } : {}),
        ...(reply.audit ? { audit: reply.audit } : {}),
        reused: reply.reused,
        ...(reply.creditsFile ? { creditsFile: reply.creditsFile } : {}),
      };
      return output;
    }
  }
};
