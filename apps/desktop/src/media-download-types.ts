/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What `media_download` hands between the renderer and main, as
// `web_media_download` does: main runs the downloader and writes the file
// into the project, the renderer imports it into the live library, and then
// tells main to record it (`commit`) or to take it back out (`discard`).
// Plain types only: the web app type-checks this file.

import type { MediaKind } from "@diffusionstudio/dapi";
import type { WebMediaLedgerItem } from "./web-media-types";

/** The caps a video download's picture may have on its shorter side. */
export type MediaMaxHeight = 360 | 480 | 720 | 1080;

/**
 * Asks main to download `url`. With a project open, `dir` is its folder and
 * `folder` a library folder under `assets/`; with none, `dir` is null and
 * `folder` an absolute folder. `id` names the job for cancelling and for the
 * commit that follows.
 */
export type MediaDownloadRequest = {
  id: string;
  dir: string | null;
  url: string;
  kind: MediaKind;
  folder?: string;
  maxHeight: MediaMaxHeight;
  item?: number;
};

/** A file main wrote (or found already there), waiting for the renderer to import it. */
export type MediaDownloaded = {
  id: string;
  /** Project-relative, `/`-separated: `assets/<folder>/<stem>.<ext>`, the library's `source`; null for a file saved outside a project. */
  source: string | null;
  /** The library folder the file belongs in (`music`, `b-roll/city`); null outside a project. */
  folder: string | null;
  /** Absolute path of the file. */
  path: string;
  /** The upload's id on its site, which names the file. */
  mediaId: string;
  /** `youtube`, `soundcloud`, `tiktok`, `instagram`, `x`, `vimeo`, `myinstants`, or the downloader's name for another site. */
  site: string;
  kind: MediaKind;
  title: string;
  channel?: string;
  channelUrl?: string;
  /** YYYY-MM-DD. */
  uploadDate?: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  mimeType: string;
  bytes: number;
  sha256: string;
  /** The page the media came from (never a signed file URL, which expires). */
  sourceUrl: string;
  /** What the caller asked for. */
  requestedUrl: string;
  /** The file was in place already (downloaded before, or put there by hand) and nothing new was saved. */
  reused: boolean;
  /** The sound or picture was converted rather than saved as the site served it. */
  reencoded: boolean;
  /** What fetched it, e.g. `yt-dlp 2026.10.26`. */
  downloader: string;
  attribution: string;
  /** Absolute path of the project's CREDITS.md; null outside a project. */
  creditsFile: string | null;
  warnings: string[];
};

/** Records a download the renderer imported, as `web_media_download`'s commit does. */
export type MediaCommitRequest = { id: string; assetId: string; src: string; source: string };

export type MediaCommitResult = { creditsFile: string };

/** Where a platform download came from, kept on its ledger item next to the web media fields. */
export type PlatformProvenance = {
  site: string;
  id: string;
  kind: MediaKind;
  pageUrl: string;
  channel?: string;
  channelUrl?: string;
  uploadDate?: string;
  durationSeconds?: number;
  videoCodec?: string;
  audioCodec?: string;
  /** The site's format ids the file was made from. */
  formats?: string[];
  /** The cap on the picture's shorter side a video file answers (the one asked for, or up to its own size when it came larger); a later ask for a higher one downloads again. */
  maxHeight?: MediaMaxHeight;
  downloader: string;
};

/** A ledger item of `.cutroom/web-media.json`, with the platform it came from when media_download saved it. */
export type MediaLedgerItem = WebMediaLedgerItem & { platform?: PlatformProvenance };
