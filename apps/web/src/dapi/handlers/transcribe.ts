/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { transcribeSource } from "@/lib/source-transcription";
import { requireAssetType, resolveAsset } from "../lib/assets";
import { getLibrary } from "@diffusionstudio/runtime";

import type { ToolHandler } from "../handler";

/** The asset's audio, transcribed locally; the main process writes the transcript to its file. */
export const transcribe: ToolHandler<"transcribe"> = async ({ path }, ctx) => {
  const session = ctx.session?.();
  const dir = session?.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (session && (ctx.session() !== session || session.project.dir() !== dir)) throw new Error("The open project changed while transcribing footage. Try again in the intended project.");
  };
  assertCurrent();
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["AUDIO", "VIDEO"], "a video or audio asset");
  assertCurrent();
  if (session && getLibrary(session.world).list().some((item) => item.id === asset.id)) {
    const { getFootageService } = await import("@/engine/footage");
    assertCurrent();
    const service = getFootageService(session.world, dir!);
    await service.indexPaths([asset.id], ctx.signal);
    assertCurrent();
    const item = service.snapshot().items.find((item) => item.assetId === asset.id);
    if (item?.status === "no-speech") throw new Error("No speech detected: the audio does not appear to contain recognizable speech.");
    if (item?.status !== "ready" || !item.segments) throw new Error(item?.error ?? "This source could not be indexed. Try again from Footage.");
    return { segments: item.segments };
  }
  const transcript = await transcribeSource(asset, { signal: ctx.signal, dir, assertCurrent });
  assertCurrent();
  if (!transcript.some((segment) => segment.words.length > 0)) {
    throw new Error("No speech detected: the audio does not appear to contain recognizable speech.");
  }

  return { segments: transcript };
};
