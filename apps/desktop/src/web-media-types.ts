/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What `web_media_download` hands between the renderer and main: main does
// the network and the disk (the renderer's fetch is bound by CORS), the
// renderer imports the file into the live library, and then tells main to
// record it (`commit`) or to take it back out (`discard`).

import type { WebMediaKind, WebMediaLicense, WebMediaProvider } from "@diffusionstudio/dapi";

/** The library folders a download may land in: `assets/web/` unless a catalog sound belongs in `music/` or `sfx/`. */
export type WebMediaFolder = "web" | "music" | "sfx";

/** What Cutroom's curated audio catalog records about a source it ships (audio-catalog.ts): a download of that source is credited from it. */
export type WebMediaCatalogCredit = { title: string; rights: string; attribution?: string; pageUrl?: string };

/** Asks main to download `url` into `<dir>/assets/<folder>/` (default `web`). `id` names the job for cancelling and the commit that follows. */
export type WebMediaDownloadRequest = {
  id: string;
  dir: string;
  url: string;
  name?: string;
  prefer: "image" | "video";
  folder?: WebMediaFolder;
};

/** A file main wrote (or found already there), waiting for the renderer to import it. */
export type WebMediaDownloaded = {
  id: string;
  /** Project-relative, `/`-separated: `assets/<folder>/<slug>-<sha8>.<ext>`, the library's `source`. */
  source: string;
  /** Absolute path of the file. */
  path: string;
  kind: WebMediaKind;
  mimeType: string;
  bytes: number;
  sha256: string;
  title?: string;
  creator?: string;
  provider?: WebMediaProvider;
  pageUrl?: string;
  /** Where the bytes came from, after redirects and page resolution. */
  fileUrl: string;
  /** What the caller asked for. */
  requestedUrl: string;
  license: WebMediaLicense;
  attribution?: string;
  /** The same bytes were in the project already, and that file is the one here. */
  deduplicated: boolean;
  /** Absolute path of the project's CREDITS.md. */
  creditsFile: string;
};

/** Records a download the renderer imported: as asset `assetId`, whose bytes are at `source` (the download's own, or a library asset with the same content). */
export type WebMediaCommitRequest = { id: string; assetId: string; src: string; source: string };

export type WebMediaCommitResult = { creditsFile: string };

/** One download as `.cutroom/web-media.json` keeps it. */
export type WebMediaLedgerItem = {
  /** The file: project-relative (`assets/web/…`, `assets/music/…`, `assets/sfx/…`), or absolute for a library asset outside the project with the same bytes. */
  file: string;
  sha256: string;
  bytes: number;
  kind: WebMediaKind;
  mimeType: string;
  assetId?: string;
  src?: string;
  title?: string;
  creator?: string;
  provider?: WebMediaProvider;
  pageUrl?: string;
  fileUrl: string;
  requestedUrl: string;
  license: WebMediaLicense;
  attribution?: string;
  downloadedAt: string;
};

export type WebMediaLedger = { version: 1; items: WebMediaLedgerItem[] };
