/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLibrary } from "@diffusionstudio/runtime";
import { isAbsoluteSource } from "@diffusionstudio/assets";
import { DapiError } from "@diffusionstudio/dapi";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

import type { Asset } from "@diffusionstudio/assets";
import type { ToolOutput } from "@diffusionstudio/dapi";
import type { MediaDownloaded } from "@desktop/media-download-types";
import type { ToolContext, ToolHandler } from "../handler";
import type { WebMediaRecord } from "./web-media";

/** Where a platform download came from, kept on its manifest record next to the web media fields. */
export type PlatformRecord = { site: string; id: string; pageUrl: string; channel?: string };

type MediaAsset = Asset & { webMedia?: WebMediaRecord & { platform?: PlatformRecord } };

/** Rights nobody has checked: what every platform download carries. */
const UNVERIFIED = {
  code: "unknown",
  name: "Unknown license",
  attributionRequired: true,
  shareAlike: false,
  commercialUse: false,
  modificationsAllowed: false,
  verified: false,
} as const;

const canceled = () => new DapiError("canceled", "The download was canceled.");

const isAbsoluteFolder = (folder: string) => folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith("\\\\");

/** The download's provenance for the asset's manifest record, without what is undefined (the manifest is YAML). */
function record(download: MediaDownloaded): WebMediaRecord & { platform: PlatformRecord } {
  const platform = Object.fromEntries(
    Object.entries({ site: download.site, id: download.mediaId, pageUrl: download.sourceUrl, channel: download.channel }).filter(([, value]) => value !== undefined),
  ) as PlatformRecord;
  return {
    fileUrl: download.sourceUrl,
    pageUrl: download.sourceUrl,
    title: download.title,
    ...(download.channel ? { creator: download.channel } : {}),
    license: { ...UNVERIFIED },
    attribution: download.attribution,
    platform,
  };
}

/** The tool's answer for a file main saved (and, in a project, the library took in as `asset`). */
function output(download: MediaDownloaded, asset: Asset | null, dir: string | null, creditsFile: string | null): ToolOutput<"media_download"> {
  const own = !asset || asset.source === download.source;
  const src = asset?.path ?? null;
  return {
    src,
    libraryPath: src,
    assetId: asset?.id ?? null,
    path: own || !asset ? download.path : isAbsoluteSource(asset.source) ? asset.source : `${dir}/${asset.source}`,
    id: download.mediaId,
    site: download.site,
    kind: download.kind,
    title: download.title,
    ...(download.channel ? { channel: download.channel } : {}),
    ...(download.channelUrl ? { channelUrl: download.channelUrl } : {}),
    ...(download.uploadDate ? { uploadDate: download.uploadDate } : {}),
    durationSeconds: download.durationSeconds,
    ...(download.width ? { width: download.width } : {}),
    ...(download.height ? { height: download.height } : {}),
    ...(download.videoCodec ? { videoCodec: download.videoCodec } : {}),
    ...(download.audioCodec ? { audioCodec: download.audioCodec } : {}),
    hasAudio: download.hasAudio,
    mimeType: asset?.mimeType || download.mimeType,
    bytes: download.bytes,
    sourceUrl: download.sourceUrl,
    reused: download.reused || !own,
    reencoded: download.reencoded,
    rights: "unverified",
    downloader: download.downloader,
    creditsFile,
    warnings: download.warnings,
  };
}

function target(folder: string | undefined, ctx: ToolContext): { dir: string | null; assertCurrent: () => void; session: ReturnType<ToolContext["session"]> } {
  if (ctx.signal.aborted) throw canceled();
  const session = ctx.session();
  if (!session) {
    if (folder && isAbsoluteFolder(folder)) return { dir: null, session: null, assertCurrent: () => { if (ctx.signal.aborted) throw canceled(); } };
    // The same `no-project` error every project tool gives, which says how to open one.
    ctx.requireSession();
  }
  const open = session ?? ctx.requireSession();
  const dir = open.project.dir();
  const assertCurrent = () => {
    if (ctx.signal.aborted) throw canceled();
    if (ctx.session() !== open || open.project.dir() !== dir) {
      throw new DapiError("no-project", "The open project changed during the download. Open the intended project and download again.");
    }
  };
  return { dir, session: open, assertCurrent };
}

/**
 * Has main download the platform media into the project's `assets/<folder>/`
 * (the downloader, the network and the disk are main's), imports it into the
 * live library, notes where it came from on the asset, and has main record
 * it in the ledger and CREDITS.md. A file the library can't take is taken
 * back out of the project. With no project open, an absolute `folder` gets
 * the file and nothing else.
 */
export const mediaDownload: ToolHandler<"media_download"> = async ({ url, kind, folder, maxHeight, item }, ctx) => {
  const { dir, session, assertCurrent } = target(folder, ctx);
  const id = crypto.randomUUID();
  const cancel = () => void mainBridge.call(MAIN_CHANNELS.MEDIA_CANCEL, { id }).catch(() => {});
  ctx.signal.addEventListener("abort", cancel, { once: true });
  let download: MediaDownloaded;
  try {
    download = await mainBridge.call(MAIN_CHANNELS.MEDIA_DOWNLOAD, { id, dir, url, kind, maxHeight, ...(folder ? { folder } : {}), ...(item ? { item } : {}) });
  } catch (error) {
    if (ctx.signal.aborted) throw canceled();
    throw error;
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
  }
  if (!session || download.source === null) return output(download, null, dir, null);

  // The file is in the project now: it is either imported and recorded, or taken back out.
  const library = getLibrary(session.world);
  let asset: MediaAsset;
  try {
    assertCurrent();
    // By its project path under `assets/`, as the library's own scan would link it, so a scan racing this import finds the same asset.
    const { assets, failed } = await library.import([download.source], { folder: download.folder ?? undefined });
    if (!assets[0]) {
      const reason = failed[0]?.error.message ?? "the library refused it";
      throw new DapiError("unsupported", `The downloaded file couldn't be opened as media (${reason}). Choose another source.`);
    }
    // The library's own instance: a reload racing this import may have replaced the one it answered with.
    asset = library.get(assets[0].id) ?? assets[0];
  } catch (error) {
    await mainBridge.call(MAIN_CHANNELS.MEDIA_DISCARD, { id }).catch(() => {});
    throw error;
  }

  // A verified license recorded for the same bytes (a web_media_download) is worth more than this one.
  if (!asset.webMedia?.license.verified) library.update(asset, { webMedia: record(download) });
  await library.flush();
  const { creditsFile } = await mainBridge.call(MAIN_CHANNELS.MEDIA_COMMIT, { id, assetId: asset.id, src: asset.path, source: asset.source });
  return output(download, asset, dir, creditsFile);
};
