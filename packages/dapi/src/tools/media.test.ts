/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalog, toolByName } from "../catalog";
import { toolJsonSchemas } from "../json-schema";
import { mediaDownload, mediaSearch } from "./media";

describe("media tool contracts", () => {
  it("searches in main and downloads in the renderer, both open-world and never destructive", () => {
    expect(toolByName("media_search").environment).toBe("main");
    expect(toolByName("media_download").environment).toBe("renderer");
    expect(mediaSearch.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(mediaDownload.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    const names = catalog.map((tool) => tool.name);
    expect(names.indexOf("media_search")).toBe(names.indexOf("web_media_download") + 1);
    expect(names.indexOf("media_download")).toBe(names.indexOf("media_search") + 1);
  });

  it("opens each description with where its media comes from and where licensed stock goes instead", () => {
    const first = (text: string) => text.slice(0, text.indexOf(". ") + 1);
    expect(first(mediaSearch.description)).toMatch(/^Find video and audio on platforms .*rights are not verified.*web_media_search instead\.$/);
    expect(first(mediaDownload.description)).toMatch(/^Download the sound or the video behind a platform link .*rights not verified.*web_media_download instead\.$/);
    expect(mediaDownload.description).toMatch(/kind: \\?"video\\?"/);
  });

  it("applies the documented search defaults and bounds", () => {
    const input = mediaSearch.input;
    expect(input.parse({ query: "  blinding lights instrumental " })).toEqual({
      platform: "youtube", query: "blinding lights instrumental", limit: 5, sort: "relevance", tab: "videos", preview: 4,
    });
    expect(input.parse({ platform: "tiktok", creator: "@dancer.one", limit: 20, preview: 0 })).toMatchObject({ creator: "@dancer.one", limit: 20, preview: 0 });
    for (const invalid of [
      { query: "" }, { query: "x".repeat(201) }, { query: "a", limit: 0 }, { query: "a", limit: 21 }, { query: "a", limit: 1.5 }, { query: "a", preview: 5 },
      { query: "a", platform: "facebook" }, { query: "a", sort: "views" }, { creator: "@a", tab: "playlists" },
    ]) expect(input.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  });

  it("defaults a download to audio at up to 1080p and takes only http(s) links", () => {
    const input = mediaDownload.input;
    expect(input.parse({ url: "https://youtu.be/XajaJYraODs" })).toEqual({ url: "https://youtu.be/XajaJYraODs", kind: "audio", maxHeight: 1080 });
    expect(input.parse({ url: "https://x.com/a/status/1", kind: "video", maxHeight: 720, item: 2, folder: " b-roll/city " })).toMatchObject({ maxHeight: 720, item: 2, folder: "b-roll/city" });
    for (const invalid of [
      { url: "file:///etc/passwd" }, { url: "youtube.com/watch?v=x" }, { url: `https://e.com/${"a".repeat(4096)}` }, { url: "https://e.com", maxHeight: 2160 },
      { url: "https://e.com", maxHeight: 721 }, { url: "https://e.com", kind: "image" }, { url: "https://e.com", item: 0 }, { url: "https://e.com", folder: "" },
    ]) expect(input.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  });

  it("keeps preview bytes out of the published search schema and publishes both download paths", () => {
    expect(Object.keys(toolJsonSchemas(mediaSearch).outputSchema.properties as object)).toEqual(["platform", "profile", "results", "warnings"]);
    expect(mediaSearch.result!.safeParse({ platform: "youtube", profile: null, results: [], warnings: [], previews: [{ index: 1, bytes: new Uint8Array([1]), mimeType: "image/webp" }] }).success).toBe(true);
    const download = toolJsonSchemas(mediaDownload).outputSchema.properties as Record<string, unknown>;
    expect(download).toHaveProperty("src");
    expect(download).toHaveProperty("libraryPath");
    expect(download).toHaveProperty("rights");
    expect(() => z.toJSONSchema(mediaDownload.output)).not.toThrow();
  });
});
