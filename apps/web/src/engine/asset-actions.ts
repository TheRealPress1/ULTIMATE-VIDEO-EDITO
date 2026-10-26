/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// File actions on the library, with the user told how they went: the
// mechanics live in @diffusionstudio/assets.

import { toast } from "somoto";
import { importFiles as importFilesInto, pickFiles, saveAssetAs as saveAs } from "@diffusionstudio/assets";
import { getActiveEntity } from "@diffusionstudio/runtime";
import { insertAsset } from "./insert-asset";
import { insertAssetsInNewScene, sequentialVideoStarts } from "./new-scene";
import { forgetAssetMedia } from "./timeline/media";
import { forgetAssetPeaks } from "./timeline/peaks";
import { mimeTypeToExtension } from "@/utils/media";

import type { Entity, World } from "koota";

import type { Asset, AssetLibrary, ImportResult } from "@diffusionstudio/assets";
import type { ClipboardMedia } from "@/lib/clipboard";

export { droppedFiles, pickFiles } from "@diffusionstudio/assets";

/** Saves a copy of an asset's file where the user says; reports failure. */
export async function saveAssetAs(asset: Pick<Asset, "handle" | "mimeType" | "path">): Promise<void> {
  try {
    await saveAs(asset);
  } catch (error) {
    toast.error("Failed to save", { description: (error as Error).message });
  }
}

/** Links files into the library at `folder` and reports whatever was skipped or refused. */
export async function importFiles(library: AssetLibrary, files: ReadonlyArray<File>, folder: string): Promise<Asset[]> {
  const report = await importFilesInto(library, files, folder);

  if (report.unnamed.length) {
    toast("Some files could not be imported", { description: "Only files on this computer can be added to the library." });
  }
  return reported(report);
}

/** What an import brought in, with whatever it refused reported. */
function reported(result: ImportResult): Asset[] {
  for (const { source, error } of result.failed) {
    toast.error(`Could not import ${source.split(/[\\/]/).pop()}`, { description: error.message });
  }
  return result.assets;
}

/**
 * Brings what the clipboard holds into the library at `folder`: copied files
 * are linked where they are, as a drop links them; a picture has no file of
 * its own, so it is written into the project.
 */
export async function importClipboard(library: AssetLibrary, media: ClipboardMedia, folder: string): Promise<Asset[]> {
  const assets = media.paths.length ? reported(await library.import(media.paths, { folder })) : [];
  for (const image of media.images) {
    try {
      assets.push(await library.store(image, { folder, name: `Pasted image${mimeTypeToExtension(image.type)}` }));
    } catch (error) {
      toast.error("Could not paste the image", { description: (error as Error).message });
    }
  }
  return assets;
}

/**
 * Pastes what the clipboard holds onto the stage: into the library first,
 * then into `parent`, or the active scene (a scene of their own when there
 * is none), at the playhead.
 */
export async function pasteClipboardMedia(world: World, library: AssetLibrary, media: ClipboardMedia, parent?: Entity): Promise<void> {
  const assets = await importClipboard(library, media, "");
  if (!parent) return insertAssets(world, assets);
  for (const asset of assets) {
    if (!insertAsset(world, asset, { parent })) {
      toast("Nothing to insert into", { description: "Open a project first." });
      return;
    }
  }
}

/** Opens the file picker and imports what the user picks into `folder`. */
export async function pickAndImport(library: AssetLibrary, folder: string): Promise<Asset[]> {
  return importFiles(library, await pickFiles(), folder);
}

/**
 * Lets the user pick another file for `asset` and points it there; the JSX
 * keeps naming it by path. Returns the relinked asset, or null when the
 * picker was dismissed, the host cannot tell the file's path, or the relink
 * failed (reported).
 */
export async function replaceAssetSource(library: AssetLibrary, asset: Asset): Promise<Asset | null> {
  const [file] = await pickFiles({ multiple: false });
  const path = file ? library.fs.pathOf?.(file) : null;
  if (!path) return null;
  try {
    const relinked = await library.relink(asset, path);
    // The picture and the waveform the timeline is showing are of the file
    // it used to be.
    forgetAssetMedia(asset.id);
    forgetAssetPeaks(asset.id);
    return relinked;
  } catch (error) {
    toast.error("Failed to replace", { description: (error as Error).message });
    return null;
  }
}

/** Inserts `asset` at the playhead of the active scene; tells the user when there is nowhere to put it. */
export function insertAssetAtPlayhead(world: World, asset: Asset): void {
  insertAssets(world, [asset]);
}

/** Inserts each of `assets` at the playhead, all starting there. */
export function insertAssetsAtPlayhead(world: World, assets: ReadonlyArray<Asset>): void {
  insertAssets(world, assets);
}

/** Inserts each of `assets` at the start of the timeline, all starting there. */
export function insertAssetsAtStart(world: World, assets: ReadonlyArray<Asset>): void {
  insertAssets(world, assets, 0);
}

/** A timeline drop makes an ordered cut from video clips, with audio starting beneath it. */
export function insertAssetsInTimeline(world: World, assets: ReadonlyArray<Asset>, start: number): void {
  if (!assets.length) return;
  if (!getActiveEntity(world)) {
    if (!insertAssetsInNewScene(world, assets, { start, sequenceVideos: true })) {
      toast("Nothing to insert into", { description: "Open a project first." });
    }
    return;
  }
  const starts = sequentialVideoStarts(assets, start);
  for (const [index, asset] of assets.entries()) {
    if (!insertAsset(world, asset, { start: starts[index] })) {
      toast("Nothing to insert into", { description: "Open a scene first." });
      return;
    }
  }
}

/**
 * Inserts `assets` into the active scene, all starting at `start` (the
 * playhead by default). With no scene active they get one of their own, as
 * when dropped on the empty stage, rather than landing loose at the root.
 */
function insertAssets(world: World, assets: ReadonlyArray<Asset>, start?: number): void {
  if (!assets.length) return;

  if (!getActiveEntity(world)) {
    if (!insertAssetsInNewScene(world, assets, { start })) {
      toast("Nothing to insert into", { description: "Open a project first." });
    }
    return;
  }

  for (const asset of assets) {
    if (!insertAsset(world, asset, { start })) {
      toast("Nothing to insert into", { description: "Open a project first." });
      return;
    }
  }
}
