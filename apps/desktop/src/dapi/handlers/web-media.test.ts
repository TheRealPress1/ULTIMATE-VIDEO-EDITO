/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toolByName } from "@diffusionstudio/dapi";
import { mainHandlers } from ".";
import { webMediaSearch } from "./web-media";
import { serveCatalog } from "../tools-session";

import type { MainContext } from "../handler";

const service = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../../web-media", () => ({ webMediaService: () => service }));

const ctx: MainContext = {
  signal: new AbortController().signal,
  logs: () => [],
  version: "test",
  window: { visible: () => false, show: async () => {}, hide: () => {} },
};
const license = { code: "by", name: "CC BY 2.0", version: "2.0", url: "https://creativecommons.org/licenses/by/2.0/", attributionRequired: true, shareAlike: false, commercialUse: true, modificationsAllowed: true, verified: true };
const result = (index: number) => ({
  index, id: `openverse:${index}`, kind: "image", title: `Pad ${index}`, provider: "openverse", source: "flickr",
  url: `https://live.staticflickr.com/${index}.jpg`, thumbnailUrl: `https://api.openverse.org/v1/images/${index}/thumb/`, pageUrl: `https://www.flickr.com/photos/x/${index}`,
  width: 1024, height: 768, mimeType: "image/jpeg", creator: "Example", license, attribution: `"Pad ${index}" by Example (https://www.flickr.com/photos/x/${index}), licensed under CC BY 2.0.`,
});
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeEach(() => {
  vi.clearAllMocks();
  service.search.mockResolvedValue({ results: [result(1), result(2)], warnings: [], previews: [{ index: 1, bytes: jpeg, mimeType: "image/jpeg" }] });
});

describe("web_media_search handler", () => {
  it("is the main handler for the tool and passes the parsed request and the caller's signal", async () => {
    expect(mainHandlers.web_media_search).toBe(webMediaSearch);
    const args = toolByName("web_media_search").input.parse({ query: "launch pad", kind: "image", limit: 2 });
    await webMediaSearch(args, ctx);
    expect(service.search).toHaveBeenCalledWith(args, ctx.signal);
  });

  it("answers over MCP with results, their preview paths, and the thumbnails inline as JPEG", async () => {
    const session = new McpServer({ name: "web-media-test", version: "0.0.0" });
    serveCatalog(session, async (tool, args) => {
      if (tool.name === "web_media_search") return webMediaSearch(toolByName("web_media_search").input.parse(args), ctx);
      throw new Error("Unexpected tool");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await session.connect(serverTransport);
    const client = new Client({ name: "web-media-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "web_media_search")!;
      expect(listed.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(Object.keys(listed.outputSchema!.properties!)).toEqual(["results", "warnings"]);

      const answer = await client.callTool({ name: "web_media_search", arguments: { query: "launch pad", limit: 2 } });
      expect(answer.isError).not.toBe(true);
      const structured = answer.structuredContent as { results: Array<{ previewPath?: string }>; warnings: string[] };
      expect(structured.results).toHaveLength(2);
      expect(structured.results[0]!.previewPath).toMatch(/dapi-web-media-.*[\\/]1\.jpg$/);
      expect(structured.results[1]).not.toHaveProperty("previewPath");
      expect(structured).not.toHaveProperty("previews");
      const content = answer.content as Array<{ type: string; mimeType?: string; data?: string }>;
      expect(content.map((block) => block.type)).toEqual(["text", "image"]);
      expect(content[1]).toMatchObject({ mimeType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") });
      rmSync(dirname(structured.results[0]!.previewPath!), { recursive: true, force: true });

      service.search.mockRejectedValueOnce(new Error("Web media search failed. Openverse: rate limited."));
      const failed = await client.callTool({ name: "web_media_search", arguments: { query: "launch pad" } });
      expect(failed).toMatchObject({ isError: true, content: [{ type: "text", text: "Web media search failed. Openverse: rate limited." }] });
    } finally {
      await client.close();
      await session.close();
    }
  });
});
