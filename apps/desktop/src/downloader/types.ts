/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Plain types shared by the downloader (main) and the Settings card
// (renderer). Nothing here may import Node: the web app type-checks it.

/** Where the managed yt-dlp stands. */
export type YtDlpState = "missing" | "installing" | "ready" | "updating" | "failed";

/** The downloader as the media tools see it. */
export type YtDlpStatus = {
  state: YtDlpState;
  /** The installed release tag, e.g. `2026.10.26`. */
  version?: string;
  /** The installed executable. */
  path?: string;
  /** Why the last install or update check failed. */
  error?: string;
  /** When Cutroom last asked GitHub for the newest release (ISO). */
  checkedAt?: string;
};

/** How yt-dlp solves YouTube's JavaScript challenges. */
export type JsRuntimeStatus =
  | { kind: "node"; version: string }
  | { kind: "none"; error: string };

/** The downloader as the Settings → Downloads card shows it. */
export type DownloaderStatus = YtDlpStatus & {
  /** The newest release the last check found. */
  latest?: string;
  /** When the installed release was set up (ISO). */
  installedAt?: string;
  /** Unknown until the first install has checked the runtime. */
  jsRuntime?: JsRuntimeStatus;
  /** Whether this platform can run the managed downloader at all. */
  supported: boolean;
  /** One sentence for people. */
  message: string;
};
