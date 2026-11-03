/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), getLibrary: vi.fn(), import: vi.fn(), update: vi.fn(), flush: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ mainBridge: { call: mocks.call } }));
vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: mocks.getLibrary }));

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { DapiError, toolByName } from "@diffusionstudio/dapi";
import { mediaDownload } from "./media";

import type { MediaDownloaded } from "@desktop/media-download-types";
import type { ToolContext } from "../handler";
import type { EditorSession } from "../session";

const URL = "https://www.youtube.com/watch?v=XajaJYraODs";
const downloaded: MediaDownloaded = {
  id: "", source: "assets/music/XajaJYraODs.m4a", folder: "music", path: "/projects/reel/assets/music/XajaJYraODs.m4a", mediaId: "XajaJYraODs", site: "youtube",
  kind: "audio", title: "Blinding Lights (Instrumental)", channel: "The Weeknd", channelUrl: "https://www.youtube.com/channel/UC1", uploadDate: "2020-10-29",
  durationSeconds: 203.3, audioCodec: "aac", hasAudio: true, mimeType: "audio/mp4", bytes: 3289325, sha256: "5c".padEnd(64, "0"), sourceUrl: URL, requestedUrl: URL,
  reused: false, reencoded: false, downloader: "yt-dlp 2026.10.26", attribution: `"Blinding Lights (Instrumental)" by The Weeknd on YouTube (${URL})`,
  creditsFile: "/projects/reel/CREDITS.md", warnings: [],
};
const audio = { id: "a1b2c3d4e5f60718", type: "AUDIO", path: "music/XajaJYraODs.m4a", source: downloaded.source, mimeType: "audio/mp4", duration: 203.3 };

let session: EditorSession;
let active: EditorSession | null;
const args = (input: Record<string, unknown> = {}) => toolByName("media_download").input.parse({ url: URL, ...input });
const context = (signal = new AbortController().signal): ToolContext => ({
  signal,
  session: () => active,
  requireSession: () => {
    if (!active) throw new DapiError("no-project", "No project open — open one first.");
    return active;
  },
  app: { openProject: vi.fn() },
});
const calls = (channel: string) => mocks.call.mock.calls.filter(([name]) => name === channel).map(([, data]) => data);

beforeEach(() => {
  vi.resetAllMocks();
  session = { world: { id: "world" }, project: { dir: () => "/projects/reel" } } as unknown as EditorSession;
  active = session;
  mocks.getLibrary.mockReturnValue({ import: mocks.import, update: mocks.update, flush: mocks.flush, get: mocks.get });
  mocks.import.mockResolvedValue({ assets: [{ ...audio }], failed: [] });
  mocks.flush.mockResolvedValue(undefined);
  mocks.update.mockImplementation((asset: object, patch: object) => Object.assign(asset, patch));
  mocks.call.mockImplementation(async (channel: string, data: { id: string }) => {
    if (channel === MAIN_CHANNELS.MEDIA_DOWNLOAD) return { ...downloaded, id: data.id };
    if (channel === MAIN_CHANNELS.MEDIA_COMMIT) return { creditsFile: "/projects/reel/CREDITS.md" };
    return undefined;
  });
});

describe("media_download", () => {
  it("has main download into the project, imports the file into its folder, notes the platform and commits it", async () => {
    const output = await mediaDownload(args(), context());
    const [request] = calls(MAIN_CHANNELS.MEDIA_DOWNLOAD) as Array<{ id: string }>;
    expect(request).toEqual({ id: expect.any(String), dir: "/projects/reel", url: URL, kind: "audio", maxHeight: 1080 });
    expect(mocks.import).toHaveBeenCalledWith([downloaded.source], { folder: "music" });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ id: audio.id }), {
      webMedia: {
        fileUrl: URL, pageUrl: URL, title: downloaded.title, creator: "The Weeknd", license: expect.objectContaining({ code: "unknown", verified: false }),
        attribution: downloaded.attribution, platform: { site: "youtube", id: "XajaJYraODs", pageUrl: URL, channel: "The Weeknd" },
      },
    });
    expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.call.mock.invocationCallOrder.at(-1)!);
    expect(calls(MAIN_CHANNELS.MEDIA_COMMIT)).toEqual([{ id: request!.id, assetId: audio.id, src: audio.path, source: downloaded.source }]);
    expect(output).toEqual({
      src: "music/XajaJYraODs.m4a", libraryPath: "music/XajaJYraODs.m4a", assetId: audio.id, path: downloaded.path, id: "XajaJYraODs", site: "youtube", kind: "audio",
      title: downloaded.title, channel: "The Weeknd", channelUrl: downloaded.channelUrl, uploadDate: "2020-10-29", durationSeconds: 203.3, audioCodec: "aac", hasAudio: true,
      mimeType: "audio/mp4", bytes: 3289325, sourceUrl: URL, reused: false, reencoded: false, rights: "unverified", downloader: "yt-dlp 2026.10.26",
      creditsFile: "/projects/reel/CREDITS.md", warnings: [],
    });
    expect(toolByName("media_download").output.safeParse(output).success).toBe(true);
  });

  it("passes the video options through", async () => {
    await mediaDownload(args({ kind: "video", maxHeight: 720, folder: "b-roll/city", item: 2 }), context());
    expect(calls(MAIN_CHANNELS.MEDIA_DOWNLOAD)[0]).toMatchObject({ kind: "video", maxHeight: 720, folder: "b-roll/city", item: 2 });
  });

  it("takes the file back out when the library can't open it", async () => {
    mocks.import.mockResolvedValue({ assets: [], failed: [{ source: downloaded.source, error: new Error("Audio track not found") }] });
    await expect(mediaDownload(args(), context())).rejects.toThrow(/couldn't be opened as media \(Audio track not found\)/);
    expect(calls(MAIN_CHANNELS.MEDIA_DISCARD)).toHaveLength(1);
    expect(calls(MAIN_CHANNELS.MEDIA_COMMIT)).toEqual([]);
  });

  it("discards when the project changed during the download", async () => {
    mocks.call.mockImplementation(async (channel: string, data: { id: string }) => {
      if (channel === MAIN_CHANNELS.MEDIA_DOWNLOAD) {
        active = { ...session } as EditorSession;
        return { ...downloaded, id: data.id };
      }
      return undefined;
    });
    await expect(mediaDownload(args(), context())).rejects.toMatchObject({ code: "no-project" });
    expect(calls(MAIN_CHANNELS.MEDIA_DISCARD)).toHaveLength(1);
  });

  it("keeps a verified license the asset already has", async () => {
    const licensed = { ...audio, webMedia: { fileUrl: "https://upload.wikimedia.org/a.m4a", license: { code: "cc0", verified: true } } };
    mocks.import.mockResolvedValue({ assets: [licensed], failed: [] });
    await mediaDownload(args(), context());
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reports the library's own asset when it already held the same bytes elsewhere", async () => {
    mocks.import.mockResolvedValue({ assets: [{ ...audio, path: "imports/song.m4a", source: "assets/imports/song.m4a" }], failed: [] });
    const output = await mediaDownload(args(), context());
    expect(output).toMatchObject({ src: "imports/song.m4a", path: "/projects/reel/assets/imports/song.m4a", reused: true });
  });

  it("asks main to cancel when the caller does", async () => {
    const controller = new AbortController();
    mocks.call.mockImplementation(async (channel: string) => {
      if (channel === MAIN_CHANNELS.MEDIA_DOWNLOAD) {
        controller.abort();
        throw new Error("The download was canceled.");
      }
      return undefined;
    });
    await expect(mediaDownload(args(), context(controller.signal))).rejects.toMatchObject({ code: "canceled" });
    expect(calls(MAIN_CHANNELS.MEDIA_CANCEL)).toHaveLength(1);
  });

  it("saves into an absolute folder with no project open, importing nothing", async () => {
    active = null;
    mocks.call.mockImplementation(async (channel: string, data: { id: string }) =>
      channel === MAIN_CHANNELS.MEDIA_DOWNLOAD ? { ...downloaded, id: data.id, source: null, folder: null, path: "/Users/me/Music/XajaJYraODs.m4a", creditsFile: null } : undefined);
    const output = await mediaDownload(args({ folder: "/Users/me/Music" }), context());
    expect(calls(MAIN_CHANNELS.MEDIA_DOWNLOAD)[0]).toMatchObject({ dir: null, folder: "/Users/me/Music" });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(output).toMatchObject({ src: null, libraryPath: null, assetId: null, path: "/Users/me/Music/XajaJYraODs.m4a", creditsFile: null });
    expect(toolByName("media_download").output.safeParse(output).success).toBe(true);
  });

  it("needs a project for a library folder", async () => {
    active = null;
    await expect(mediaDownload(args({ folder: "music" }), context())).rejects.toMatchObject({ code: "no-project" });
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
