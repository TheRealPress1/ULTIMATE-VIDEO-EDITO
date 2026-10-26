/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), getLibrary: vi.fn(), import: vi.fn(), update: vi.fn(), flush: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ mainBridge: { call: mocks.call } }));
vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: mocks.getLibrary }));

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { toolByName } from "@diffusionstudio/dapi";
import { webMediaDownload } from "./web-media";

import type { WebMediaDownloaded } from "@desktop/web-media-types";
import type { ToolContext } from "../handler";
import type { EditorSession } from "../session";

const license = { code: "by-sa", name: "CC BY-SA 4.0", version: "4.0", url: "https://creativecommons.org/licenses/by-sa/4.0", attributionRequired: true, shareAlike: true, commercialUse: true, modificationsAllowed: true, verified: true };
const downloaded: WebMediaDownloaded = {
  id: "", source: "assets/web/kennedy-panorama-3f2a9c1d.jpg", path: "/projects/launch/assets/web/kennedy-panorama-3f2a9c1d.jpg",
  kind: "image", mimeType: "image/jpeg", bytes: 482113, sha256: "3f2a9c1d".padEnd(64, "0"), title: "Kennedy Space Center panorama",
  creator: "Jane Doe", provider: "wikimedia", pageUrl: "https://commons.wikimedia.org/wiki/File:Kennedy_Space_Center_panorama.tif",
  fileUrl: "https://upload.wikimedia.org/x/lossy-page1-3840px-K.tif.jpg", requestedUrl: "https://upload.wikimedia.org/x/lossy-page1-3840px-K.tif.jpg",
  license, attribution: "\"Kennedy Space Center panorama\" by Jane Doe, licensed under CC BY-SA 4.0.", deduplicated: false, creditsFile: "/projects/launch/CREDITS.md",
};
const image = { id: "a1b2c3d4e5f60718", type: "IMAGE", path: "web/kennedy-panorama-3f2a9c1d.jpg", source: downloaded.source, mimeType: "image/jpeg", width: 3840, height: 1280 };

let session: EditorSession;
let active: EditorSession | null;
const args = (input: Record<string, unknown> = {}) => toolByName("web_media_download").input.parse({ url: downloaded.requestedUrl, ...input });
const context = (signal = new AbortController().signal): ToolContext => ({
  signal,
  session: () => active,
  requireSession: () => {
    if (!active) throw Object.assign(new Error("No project open — open one first."), { code: "no-project" });
    return active;
  },
  app: { openProject: vi.fn() },
});
const calls = (channel: string) => mocks.call.mock.calls.filter(([name]) => name === channel).map(([, data]) => data);

beforeEach(() => {
  vi.resetAllMocks();
  session = { world: { id: "world" }, project: { dir: () => "/projects/launch" } } as unknown as EditorSession;
  active = session;
  mocks.getLibrary.mockReturnValue({ import: mocks.import, update: mocks.update, flush: mocks.flush, get: mocks.get });
  mocks.import.mockResolvedValue({ assets: [{ ...image }], failed: [] });
  mocks.flush.mockResolvedValue(undefined);
  mocks.update.mockImplementation((asset: object, patch: object) => Object.assign(asset, patch));
  mocks.call.mockImplementation(async (channel: string, data: { id: string }) => {
    if (channel === MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD) return { ...downloaded, id: data.id };
    if (channel === MAIN_CHANNELS.WEB_MEDIA_COMMIT) return { creditsFile: "/projects/launch/CREDITS.md" };
    return undefined;
  });
});

describe("web_media_download", () => {
  it("has main download into the open project, imports the file under web/, notes its provenance and commits it", async () => {
    const output = await webMediaDownload(args({ name: "kennedy panorama" }), context());
    const [request] = calls(MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD) as Array<{ id: string }>;
    expect(request).toEqual({ id: expect.any(String), dir: "/projects/launch", url: downloaded.requestedUrl, prefer: "image", name: "kennedy panorama" });
    expect(mocks.getLibrary).toHaveBeenCalledWith(session.world);
    expect(mocks.import).toHaveBeenCalledWith([downloaded.source], { folder: "web" });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ id: image.id }), {
      webMedia: {
        fileUrl: downloaded.fileUrl, pageUrl: downloaded.pageUrl, provider: "wikimedia", title: downloaded.title, creator: "Jane Doe",
        license, attribution: downloaded.attribution,
      },
    });
    expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.call.mock.invocationCallOrder.at(-1)!);
    expect(calls(MAIN_CHANNELS.WEB_MEDIA_COMMIT)).toEqual([{ id: request!.id, assetId: image.id, src: image.path, source: downloaded.source }]);
    expect(calls(MAIN_CHANNELS.WEB_MEDIA_DISCARD)).toEqual([]);
    expect(output).toEqual({
      src: "web/kennedy-panorama-3f2a9c1d.jpg",
      assetId: image.id,
      path: downloaded.path,
      kind: "image",
      mimeType: "image/jpeg",
      bytes: 482113,
      width: 3840,
      height: 1280,
      title: downloaded.title,
      creator: "Jane Doe",
      provider: "wikimedia",
      pageUrl: downloaded.pageUrl,
      fileUrl: downloaded.fileUrl,
      license,
      attribution: downloaded.attribution,
      creditsFile: "/projects/launch/CREDITS.md",
      deduplicated: false,
    });
    expect(() => toolByName("web_media_download").output.parse(output)).not.toThrow();
  });

  it("reports time-based media by the library's probe, and an asset the library already had as reused", async () => {
    mocks.import.mockResolvedValue({ assets: [{ id: "f00d", type: "VIDEO", path: "B-roll/liftoff.webm", source: "/Users/me/Movies/liftoff.webm", mimeType: "video/webm", width: 1920, height: 1080, duration: 43.52 }], failed: [] });
    const output = await webMediaDownload(args(), context());
    expect(output).toMatchObject({ src: "B-roll/liftoff.webm", path: "/Users/me/Movies/liftoff.webm", kind: "video", width: 1920, height: 1080, durationSeconds: 43.52, deduplicated: true });
    expect(calls(MAIN_CHANNELS.WEB_MEDIA_COMMIT)[0]).toMatchObject({ assetId: "f00d", src: "B-roll/liftoff.webm", source: "/Users/me/Movies/liftoff.webm" });
  });

  it("keeps provenance an asset already carries unless the new one is verified and the old one isn't", async () => {
    mocks.import.mockResolvedValue({ assets: [{ ...image, webMedia: { fileUrl: "https://a", license: { ...license, verified: true } } }], failed: [] });
    await webMediaDownload(args(), context());
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.import.mockResolvedValue({ assets: [{ ...image, webMedia: { fileUrl: "https://a", license: { ...license, code: "unknown", verified: false } } }], failed: [] });
    await webMediaDownload(args(), context());
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("notes provenance on the library's current instance when a reload replaced it during the import", async () => {
    const current = { ...image, reloaded: true };
    mocks.get.mockImplementation((id: string) => (id === image.id ? current : undefined));
    await webMediaDownload(args(), context());
    expect(mocks.update.mock.calls[0]![0]).toBe(current);
  });

  it("takes the file back out when the library can't open it", async () => {
    mocks.import.mockResolvedValue({ assets: [], failed: [{ source: downloaded.source, error: new Error("Unsupported file: x.jpg") }] });
    await expect(webMediaDownload(args(), context())).rejects.toThrow("The downloaded file couldn't be opened as media (Unsupported file: x.jpg). Try another result or link.");
    const [request] = calls(MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD) as Array<{ id: string }>;
    expect(calls(MAIN_CHANNELS.WEB_MEDIA_DISCARD)).toEqual([{ id: request!.id }]);
    expect(calls(MAIN_CHANNELS.WEB_MEDIA_COMMIT)).toEqual([]);
  });

  it("does not import into a project the user switched to meanwhile", async () => {
    mocks.call.mockImplementation(async (channel: string, data: { id: string }) => {
      if (channel !== MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD) return undefined;
      active = { ...session, project: { dir: () => "/projects/other" } } as EditorSession;
      return { ...downloaded, id: data.id };
    });
    await expect(webMediaDownload(args(), context())).rejects.toMatchObject({ code: "no-project" });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(calls(MAIN_CHANNELS.WEB_MEDIA_DISCARD)).toHaveLength(1);
  });

  it("cancels main's download when the caller goes away", async () => {
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    mocks.call.mockImplementation((channel: string) => channel === MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD
      ? new Promise((_, reject) => { fail = reject; })
      : Promise.resolve(undefined));
    const pending = webMediaDownload(args(), context(controller.signal));
    controller.abort();
    fail(new Error("The download was canceled."));
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
    const [request] = calls(MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD) as Array<{ id: string }>;
    expect(calls(MAIN_CHANNELS.WEB_MEDIA_CANCEL)).toEqual([{ id: request!.id }]);
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it("passes main's failures through and needs an open project", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Local and private network addresses can't be downloaded from. Use a public http or https link."));
    await expect(webMediaDownload(args({ url: "http://localhost/a.jpg" }), context())).rejects.toThrow(/private network addresses/);
    active = null;
    await expect(webMediaDownload(args(), context())).rejects.toMatchObject({ code: "no-project" });
    const aborted = new AbortController();
    aborted.abort();
    active = session;
    await expect(webMediaDownload(args(), context(aborted.signal))).rejects.toMatchObject({ code: "canceled" });
  });
});
