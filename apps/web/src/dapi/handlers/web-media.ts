/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLibrary } from "@diffusionstudio/runtime";
import { isAbsoluteSource } from "@diffusionstudio/assets";
import { DapiError } from "@diffusionstudio/dapi";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

import type { Asset } from "@diffusionstudio/assets";
import type { ToolOutput, WebMediaLicense, WebMediaProvider } from "@diffusionstudio/dapi";
import type { WebMediaDownloaded } from "@desktop/web-media-types";
import type { ToolContext, ToolHandler } from "../handler";

/** Where downloads live in the library: `assets/web/` on disk. */
const FOLDER = "web";

/** Where an asset came from on the web, kept on its manifest record next to its other fields. */
export type WebMediaRecord = {
  fileUrl: string;
  pageUrl?: string;
  provider?: WebMediaProvider;
  title?: string;
  creator?: string;
  license: WebMediaLicense;
  attribution?: string;
};

type WebAsset = Asset & { webMedia?: WebMediaRecord };

const canceled = () => new DapiError("canceled", "The download was canceled.");

function currentProject(ctx: ToolContext) {
  if (ctx.signal.aborted) throw canceled();
  const session = ctx.requireSession();
  const dir = session.project.dir();
  const assertCurrent = () => {
    if (ctx.signal.aborted) throw canceled();
    if (ctx.session() !== session || session.project.dir() !== dir) {
      throw new DapiError("no-project", "The open project changed during the download. Open the intended project and download again.");
    }
  };
  return { session, dir, assertCurrent };
}

/** The download's provenance, without what is undefined (the manifest is YAML, and undefined has no spelling there). */
function record(download: WebMediaDownloaded): WebMediaRecord {
  const { fileUrl, pageUrl, provider, title, creator, license, attribution } = download;
  return Object.fromEntries(
    Object.entries({ fileUrl, pageUrl, provider, title, creator, license, attribution }).filter(([, value]) => value !== undefined),
  ) as WebMediaRecord;
}

/** What the library learned probing the file: size for pictures, duration for time-based media. */
function measured(asset: Asset): Pick<ToolOutput<"web_media_download">, "width" | "height" | "durationSeconds"> {
  const size = (value: unknown) => (typeof value === "number" && value >= 1 ? Math.round(value) : undefined);
  const width = "width" in asset ? size(asset.width) : undefined;
  const height = "height" in asset ? size(asset.height) : undefined;
  const duration = "duration" in asset && typeof asset.duration === "number" && Number.isFinite(asset.duration) && asset.duration >= 0 ? asset.duration : undefined;
  return { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(duration !== undefined && asset.type !== "IMAGE" ? { durationSeconds: duration } : {}) };
}

/**
 * Has main download the file into the project's `assets/web/` (the network
 * and the disk are main's; the renderer's fetch is bound by CORS), imports it
 * into the live library, notes where it came from on the asset, and has main
 * record it in the ledger and CREDITS.md. A file the library can't take is
 * taken back out of the project.
 */
export const webMediaDownload: ToolHandler<"web_media_download"> = async ({ url, name, prefer }, ctx) => {
  const { session, dir, assertCurrent } = currentProject(ctx);
  const id = crypto.randomUUID();
  const cancel = () => void mainBridge.call(MAIN_CHANNELS.WEB_MEDIA_CANCEL, { id }).catch(() => {});
  ctx.signal.addEventListener("abort", cancel, { once: true });
  let download: WebMediaDownloaded;
  try {
    download = await mainBridge.call(MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD, { id, dir, url, prefer, ...(name ? { name } : {}) });
  } catch (error) {
    if (ctx.signal.aborted) throw canceled();
    throw error;
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
  }

  // The file is in the project now: it is either imported and recorded, or taken back out.
  const library = getLibrary(session.world);
  let asset: WebAsset;
  try {
    assertCurrent();
    // By its project path under `assets/`, as the library's own scan would
    // link it, so a scan racing this import finds the same asset, not a copy.
    const { assets, failed } = await library.import([download.source], { folder: FOLDER });
    if (!assets[0]) {
      const reason = failed[0]?.error.message ?? "the library refused it";
      throw new DapiError("unsupported", `The downloaded file couldn't be opened as media (${reason}). Try another result or link.`);
    }
    // The library's own instance: a reload racing this import may have replaced the one it answered with.
    asset = library.get(assets[0].id) ?? assets[0];
  } catch (error) {
    await mainBridge.call(MAIN_CHANNELS.WEB_MEDIA_DISCARD, { id }).catch(() => {});
    throw error;
  }

  const recorded = asset.webMedia;
  if (!recorded || (!recorded.license.verified && download.license.verified)) library.update(asset, { webMedia: record(download) });
  await library.flush();
  const { creditsFile } = await mainBridge.call(MAIN_CHANNELS.WEB_MEDIA_COMMIT, { id, assetId: asset.id, src: asset.path, source: asset.source });

  const own = asset.source === download.source;
  const kind = asset.type === "VIDEO" ? "video" : asset.type === "AUDIO" ? "audio" : asset.type === "IMAGE" ? "image" : download.kind;
  return {
    src: asset.path,
    assetId: asset.id,
    path: own ? download.path : isAbsoluteSource(asset.source) ? asset.source : `${dir}/${asset.source}`,
    kind,
    mimeType: asset.mimeType || download.mimeType,
    bytes: download.bytes,
    ...measured(asset),
    ...(download.title ? { title: download.title } : {}),
    ...(download.creator ? { creator: download.creator } : {}),
    ...(download.provider ? { provider: download.provider } : {}),
    ...(download.pageUrl ? { pageUrl: download.pageUrl } : {}),
    fileUrl: download.fileUrl,
    license: download.license,
    ...(download.attribution ? { attribution: download.attribution } : {}),
    creditsFile,
    deduplicated: download.deduplicated || !own,
  };
};
