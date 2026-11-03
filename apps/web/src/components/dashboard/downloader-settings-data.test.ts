/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { downloaderActions, downloaderDetails, when } from "./downloader-settings-data";

import type { DownloaderStatus } from "@desktop/downloader/types";

const ready: DownloaderStatus = {
  state: "ready",
  version: "2026.10.26",
  path: "/Users/me/Library/Application Support/Cutroom/tools/yt-dlp/2026.10.26/yt-dlp_macos",
  installedAt: "2026-10-26T18:00:00.000Z",
  checkedAt: "2026-11-03T09:00:00.000Z",
  latest: "2026.10.26",
  jsRuntime: { kind: "node", version: "24.22.0" },
  supported: true,
  message: "yt-dlp 2026.10.26 is installed.",
};
const format = (iso: string) => iso.slice(0, 10);

describe("the Downloads card", () => {
  it("describes an installed downloader", () => {
    expect(downloaderDetails(ready, format)).toEqual([
      "yt-dlp 2026.10.26, installed 2026-10-26.",
      "Last checked GitHub for a newer release 2026-11-03.",
      "YouTube's playback challenges are solved locally with Cutroom's built-in Node 24.22.0.",
    ]);
  });

  it("says when the runtime or the last check failed", () => {
    const lines = downloaderDetails({ ...ready, jsRuntime: { kind: "none", error: "The app's Node 20.1.0 is older than the 22 yt-dlp needs." }, error: "GitHub couldn't be reached (ENOTFOUND)" }, format);
    expect(lines).toContain("No JavaScript runtime passed its check, so YouTube may offer fewer formats (The app's Node 20.1.0 is older than the 22 yt-dlp needs).");
    expect(lines).toContain("The last check didn't finish: GitHub couldn't be reached (ENOTFOUND). The installed release keeps working.");
  });

  it("offers install before the first use, and nothing while busy or unsupported", () => {
    const missing: DownloaderStatus = { state: "missing", supported: true, message: "…" };
    expect(downloaderActions(missing, false)).toEqual({ busy: false, check: false, reinstall: true, reinstallLabel: "Install now" });
    expect(downloaderActions(ready, false)).toEqual({ busy: false, check: true, reinstall: true, reinstallLabel: "Reinstall" });
    expect(downloaderActions({ ...ready, state: "updating" }, false)).toMatchObject({ busy: true, check: false, reinstall: false });
    expect(downloaderActions(ready, true)).toMatchObject({ busy: true, check: false });
    expect(downloaderActions({ state: "failed", supported: false, message: "macOS only", error: "macOS only" }, false)).toMatchObject({ check: false, reinstall: false });
    expect(downloaderDetails({ state: "failed", supported: false, message: "macOS only" })).toEqual([]);
  });

  it("formats dates and keeps an unreadable one", () => {
    expect(when("not a date")).toBe("not a date");
    expect(when("2026-11-03T09:00:00.000Z", "en-US")).toMatch(/2026/);
  });
});
