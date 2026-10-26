/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalog, toolByName } from "../catalog";
import { toolJsonSchemas } from "../json-schema";
import { webMediaDownload, webMediaSearch } from "./web-media";

const license = { code: "cc0", name: "CC0 1.0", attributionRequired: false, shareAlike: false, commercialUse: true, modificationsAllowed: true, verified: true };

describe("web media tool contracts", () => {
  it("searches in main and downloads in the renderer, both open-world and never destructive", () => {
    expect(toolByName("web_media_search").environment).toBe("main");
    expect(toolByName("web_media_download").environment).toBe("renderer");
    expect(webMediaSearch.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(webMediaDownload.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    const names = catalog.map((tool) => tool.name);
    expect(names.indexOf("web_media_search")).toBe(names.indexOf("job") + 1);
    expect(names.filter((name) => name.startsWith("instagram_"))).toHaveLength(4);
  });

  it("applies the documented search defaults and bounds", () => {
    const input = webMediaSearch.input;
    expect(input.parse({ query: "  apollo launch " })).toEqual({
      query: "apollo launch", kind: "image", orientation: "any", license: "editable", sources: ["openverse", "wikimedia"], limit: 12, preview: 4,
    });
    for (const invalid of [
      { query: "" }, { query: "   " }, { query: "x".repeat(201) }, { query: "a", limit: 0 }, { query: "a", limit: 31 },
      { query: "a", limit: 2.5 }, { query: "a", preview: 5 }, { query: "a", preview: -1 }, { query: "a", sources: [] },
      { query: "a", sources: ["flickr"] }, { query: "a", kind: "document" }, { query: "a", license: "nc" }, { query: "a", orientation: "wide" },
    ]) expect(input.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    expect(input.parse({ query: "a", sources: ["wikimedia"], preview: 0 })).toMatchObject({ sources: ["wikimedia"], preview: 0 });
  });

  it("accepts only http(s) URLs for download and defaults to images", () => {
    const input = webMediaDownload.input;
    expect(input.parse({ url: "https://example.com/a.jpg" })).toEqual({ url: "https://example.com/a.jpg", prefer: "image" });
    expect(input.parse({ url: "HTTP://example.com/a", name: " launch ", prefer: "video" })).toMatchObject({ name: "launch", prefer: "video" });
    for (const url of ["file:///etc/passwd", "ftp://example.com/a.jpg", "javascript:alert(1)", "example.com/a.jpg", "", `https://e.com/${"a".repeat(4096)}`]) {
      expect(input.safeParse({ url }).success, url).toBe(false);
    }
    expect(input.safeParse({ url: "https://e.com/a", name: "x".repeat(81) }).success).toBe(false);
    expect(input.safeParse({ url: "https://e.com/a", prefer: "audio" }).success).toBe(false);
  });

  it("keeps preview bytes out of the published output schema", () => {
    const { outputSchema } = toolJsonSchemas(webMediaSearch);
    expect(Object.keys(outputSchema.properties as object)).toEqual(["results", "warnings"]);
    const result = { index: 1, id: "openverse:1", kind: "image", title: "Launch", provider: "openverse", url: "https://e.com/a.jpg", pageUrl: "https://e.com/a", license, attribution: "\"Launch\"" };
    expect(webMediaSearch.output.parse({ results: [result], warnings: [] }).results[0]).toEqual(result);
    expect(webMediaSearch.result!.safeParse({ results: [], warnings: [], previews: [{ index: 1, bytes: new Uint8Array([1]), mimeType: "image/jpeg" }] }).success).toBe(true);
    expect(() => z.toJSONSchema(webMediaDownload.output)).not.toThrow();
  });
});
