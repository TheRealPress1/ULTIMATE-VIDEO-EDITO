/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The downloader core as the media tools use it: a managed yt-dlp (install,
// update, run; see ./manager), the failure taxonomy its callers act on (see
// ./yt-dlp-errors), and one instance for the main process. Retrying is the
// callers' decision: after an `outdated` failure, `update()` and retry once;
// after a `network` one, retry once; anything else is final.
//
// Every run starts with these arguments, before the caller's:
//   --ignore-config --no-plugin-dirs        no user config or plugins
//   --no-cookies --no-cookies-from-browser  never signed in
//   --color never --cache-dir <root>/cache
//   --proxy http://…@127.0.0.1:<port>       the egress gate (./egress-proxy)
//   --socket-timeout 30 --retries 3 --fragment-retries 5
//   --downloader native --no-mtime          the bundled FFmpeg has no network
//   --no-js-runtimes --js-runtimes node:<shim>   (./js-runtime)
//   --ffmpeg-location <bundled audio-tools dir>
// `--no-warnings` is left to the caller. Later arguments win, so a caller can
// override the retry counts or the downloader per protocol.

import { pinnedFetch } from "../web-media";
import { YtDlpManager } from "./manager";

import type { Fetch } from "./yt-dlp-install";
import type { ReleaseKey } from "./release-signature";
import type { ManagedRunOptions } from "./manager";
import type { YtDlpRunResult } from "./yt-dlp-run";
import type { DownloaderStatus, YtDlpStatus } from "./types";

export { classifyYtDlpError, downloaderLine, sanitizeDetail } from "./yt-dlp-errors";
export type { YtDlpError, YtDlpErrorCategory, YtDlpErrorReason } from "./yt-dlp-errors";
export type { DownloaderStatus, JsRuntimeStatus, YtDlpState, YtDlpStatus } from "./types";
export type { ManagedRunOptions } from "./manager";
export type { YtDlpRunOptions, YtDlpRunResult } from "./yt-dlp-run";

export interface YtDlp {
  status(): YtDlpStatus;
  /** The installed release, installed (signature- and checksum-verified, smoke-tested) on first use. */
  ensure(signal?: AbortSignal): Promise<{ path: string; version: string }>;
  /** Looks for a newer release and installs it; throttled to one GitHub check per 30 minutes. */
  update(signal?: AbortSignal): Promise<{ version: string; changed: boolean }>;
  /** Runs yt-dlp with the base arguments above; never rejects for a failed run, only when yt-dlp can't be installed. */
  run(args: string[], opts: ManagedRunOptions): Promise<YtDlpRunResult>;
  dispose(): void;
}

/** What the main process (Settings, the background check) uses besides. */
export interface ManagedYtDlp extends YtDlp {
  details(): DownloaderStatus;
  checkNow(signal?: AbortSignal): Promise<{ version: string; changed: boolean }>;
  reinstall(signal?: AbortSignal): Promise<{ version: string; changed: boolean }>;
  startBackgroundChecks(): void;
}

export type ConfigureYtDlpOptions = {
  /** `<userData>/tools/yt-dlp`. */
  root: string;
  /** For tests; the app uses Node's client with its connections pinned to public addresses. */
  fetch?: typeof fetch;
  /** The folder holding the bundled ffmpeg (and ffprobe). */
  ffmpegDir: string;
  /** `process.execPath`: the binary the JavaScript runtime shim runs as Node. */
  appExecPath: string;
  /** The app's version. */
  version: string;
  now?: () => Date;
  /** For tests: the keys a release's checksums must be signed with, instead of yt-dlp's. */
  releaseKeys?: readonly ReleaseKey[];
};

let instance: ManagedYtDlp | undefined;

/** The main process's downloader, made once. */
export function configureYtDlp(options: ConfigureYtDlpOptions): ManagedYtDlp {
  instance?.dispose();
  const given = options.fetch;
  const fetcher: Fetch = given ? (url, init) => given(url, init) : pinnedFetch();
  instance = new YtDlpManager({
    root: options.root,
    fetch: fetcher,
    ffmpegDir: options.ffmpegDir,
    appExecPath: options.appExecPath,
    version: options.version,
    now: options.now,
    releaseKeys: options.releaseKeys,
  });
  return instance;
}

/** The downloader `configureYtDlp` made. */
export function ytDlp(): ManagedYtDlp {
  if (!instance) throw new Error("The downloader isn't configured yet.");
  return instance;
}
