/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DownloaderStatus } from "@desktop/downloader/types";

/** A short local date and time, or the raw value when it doesn't parse. */
export function when(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** The detail lines under the Downloads card's status. */
export function downloaderDetails(status: DownloaderStatus, format: (iso: string) => string = (iso) => when(iso)): string[] {
  const lines: string[] = [];
  if (!status.supported) return lines;
  if (status.version && status.installedAt) lines.push(`yt-dlp ${status.version}, installed ${format(status.installedAt)}.`);
  if (status.checkedAt) lines.push(`Last checked GitHub for a newer release ${format(status.checkedAt)}.`);
  if (status.jsRuntime?.kind === "node") lines.push(`YouTube's playback challenges are solved locally with Blackout's built-in Node ${status.jsRuntime.version}.`);
  else if (status.jsRuntime?.kind === "none") lines.push(`No JavaScript runtime passed its check, so YouTube may offer fewer formats (${status.jsRuntime.error.replace(/\.$/, "")}).`);
  if (status.state === "ready" && status.error) lines.push(`The last check didn't finish: ${status.error.replace(/\.$/, "")}. The installed release keeps working.`);
  return lines;
}

/** Which buttons the card offers. */
export function downloaderActions(status: DownloaderStatus | undefined, pending: boolean): { check: boolean; reinstall: boolean; reinstallLabel: string; busy: boolean } {
  const busy = pending || status?.state === "installing" || status?.state === "updating";
  const usable = Boolean(status?.supported) && !busy;
  const installed = Boolean(status?.version);
  return {
    busy,
    check: usable && installed,
    reinstall: usable,
    reinstallLabel: installed ? "Reinstall" : "Install now",
  };
}
