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
import { mediaSearch } from "./media";
import { serveCatalog } from "../tools-session";

import type { MainContext } from "../handler";

const service = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../../media-search", () => ({ mediaSearchService: () => service }));

const ctx: MainContext = {
  signal: new AbortController().signal,
  logs: () => [],
  version: "test",
  window: { visible: () => false, show: async () => {}, hide: () => {} },
};
const result = (index: number) => ({
  index, id: `AbCdEfGhIj${index}`, platform: "youtube", title: `Take ${index}`, channel: "Quiet Rooms", channelUrl: null,
  url: `https://www.youtube.com/watch?v=AbCdEfGhIj${index}`, durationSeconds: 187, publishedAt: "2024-01-01", publishedAtApproximate: true,
  views: 10, likes: null, comments: null, live: "none", thumbnailUrl: `https://i.ytimg.com/vi/AbCdEfGhIj${index}/hqdefault.jpg`,
});
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

beforeEach(() => {
  vi.clearAllMocks();
  service.search.mockResolvedValue({ platform: "youtube", profile: null, results: [result(1), result(2)], warnings: [], previews: [{ index: 2, bytes: webp, mimeType: "image/webp" }] });
});

describe("media_search handler", () => {
  it("is the main handler for the tool and passes the parsed request and the caller's signal", async () => {
    expect(mainHandlers.media_search).toBe(mediaSearch);
    const args = toolByName("media_search").input.parse({ query: "rain", limit: 2 });
    await mediaSearch(args, ctx);
    expect(service.search).toHaveBeenCalledWith(args, ctx.signal);
  });

  it("answers over MCP with results, their preview paths, and the thumbnails inline", async () => {
    const session = new McpServer({ name: "media-test", version: "0.0.0" });
    serveCatalog(session, async (tool, args) => {
      if (tool.name === "media_search") return mediaSearch(toolByName("media_search").input.parse(args), ctx);
      throw new Error("Unexpected tool");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await session.connect(serverTransport);
    const client = new Client({ name: "media-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools;
      const search = listed.find((tool) => tool.name === "media_search")!;
      expect(search.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(Object.keys(search.outputSchema!.properties!)).toEqual(["platform", "profile", "results", "warnings"]);
      expect(listed.find((tool) => tool.name === "media_download")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });

      const answer = await client.callTool({ name: "media_search", arguments: { query: "rain", limit: 2 } });
      expect(answer.isError).not.toBe(true);
      const structured = answer.structuredContent as { results: Array<{ previewPath?: string }> };
      expect(structured.results[0]).not.toHaveProperty("previewPath");
      expect(structured.results[1]!.previewPath).toMatch(/dapi-media-search-.*[\\/]2\.webp$/);
      expect(structured).not.toHaveProperty("previews");
      const content = answer.content as Array<{ type: string; mimeType?: string; data?: string }>;
      expect(content.map((block) => block.type)).toEqual(["text", "image"]);
      expect(content[1]).toMatchObject({ mimeType: "image/webp", data: Buffer.from(webp).toString("base64") });
      rmSync(dirname(structured.results[1]!.previewPath!), { recursive: true, force: true });

      service.search.mockRejectedValueOnce(new Error("Cutroom can't search X."));
      const failed = await client.callTool({ name: "media_search", arguments: { platform: "x", query: "cats" } });
      expect(failed).toMatchObject({ isError: true, content: [{ type: "text", text: "Cutroom can't search X." }] });
    } finally {
      await client.close();
      await session.close();
    }
  });
});
