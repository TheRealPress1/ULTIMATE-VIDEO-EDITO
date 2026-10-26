import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toolByName } from "@diffusionstudio/dapi";
import { instagramAccounts, instagramPosts, instagramPostAnalytics, instagramAccountInsights } from "./instagram";
import { serveCatalog } from "../tools-session";

import type { InstagramDashboard, InstagramPost } from "../../instagram-types";
import type { MainContext } from "../handler";

const service = vi.hoisted(() => ({ snapshot: vi.fn(), sync: vi.fn() }));
vi.mock("../../instagram", () => ({ instagramService: () => service }));

const ctx: MainContext = {
  signal: new AbortController().signal,
  logs: () => [],
  version: "test",
  window: { visible: () => false, show: async () => {}, hide: () => {} },
};
const metrics = { views: null, reach: null, likes: 0, comments: null, saves: null, shares: null, averageWatchTimeMs: null };
const post = (id: string, views: number | null, publishedAt: string): InstagramPost => ({
  id, caption: `Caption ${id}`, mediaType: "VIDEO", mediaProductType: "REELS", permalink: null, thumbnailUrl: null,
  publishedAt, syncedAt: "2026-10-21T10:00:00Z", metrics: { ...metrics, views }, history: [],
});
let snapshot: InstagramDashboard;

beforeEach(() => {
  snapshot = {
    status: "connected",
    account: { id: "account-1", username: "creator", accountType: "MEDIA_CREATOR", followers: 123 },
    lastSyncedAt: "2026-10-21T10:00:00Z", error: null,
    posts: [
      post("unavailable", null, "2026-10-21T09:00:00Z"),
      post("zero", 0, "2026-10-19T09:00:00Z"),
      post("top", 23, "2026-10-18T09:00:00Z"),
    ],
    followerHistory: [{ syncedAt: "2026-10-21T10:00:00Z", followers: 123 }],
    coverage: { fetchedPosts: 3, limit: 25, hasMore: true },
  };
  vi.clearAllMocks();
  service.snapshot.mockImplementation(async () => snapshot);
});

describe("Instagram MCP handlers", () => {
  it("sorts descending without mutating the cache, placing unavailable metrics after zero", async () => {
    const output = await instagramPosts({ sortBy: "views", limit: 2 }, ctx);
    expect(output.posts.map((post) => post.id)).toEqual(["top", "zero"]);
    expect(output.posts[1]!.metrics.views).toBe(0);
    expect(snapshot.posts.map((post) => post.id)).toEqual(["unavailable", "zero", "top"]);
    expect(output.coverage.hasMore).toBe(true);
    expect(output.metricPeriod).toBe("lifetime");
    expect(output.dataSource).toBe("local_cache");
    expect(service.sync).not.toHaveBeenCalled();

    const newest = await instagramPosts({ sortBy: "publishedAt", limit: 25 }, ctx);
    expect(newest.posts[0]!.id).toBe("unavailable");
    expect(newest.posts[0]!.metrics.views).toBeNull();
  });

  it("returns only known public fields, even if cached objects gain private fields", async () => {
    Object.assign(snapshot, { accessToken: "secret-value" });
    Object.assign(snapshot.account!, { accessToken: "secret-value" });
    Object.assign(snapshot.posts[0]!, { accessToken: "secret-value" });
    Object.assign(snapshot.posts[0]!.metrics, { token: "secret-value" });
    Object.assign(snapshot.followerHistory[0]!, { token: "secret-value" });
    const outputs = await Promise.all([
      instagramAccounts({}, ctx),
      instagramPosts({ sortBy: "publishedAt", limit: 25 }, ctx),
      instagramPostAnalytics({ postId: "unavailable" }, ctx),
      instagramAccountInsights({}, ctx),
    ]);
    expect(JSON.stringify(outputs)).not.toContain("secret-value");
    expect(service.snapshot).toHaveBeenCalledTimes(4);
    expect(service.sync).not.toHaveBeenCalled();
  });

  it("labels observed history and reports an unknown post safely", async () => {
    snapshot.posts[0]!.history = [{ syncedAt: "2026-10-20T10:00:00Z", metrics: { ...metrics, views: 8 } }];
    const output = await instagramPostAnalytics({ postId: "unavailable" }, ctx);
    expect(output.historySource).toBe("local_sync_observations");
    expect(output.post.history[0]!.metrics.views).toBe(8);
    const insights = await instagramAccountInsights({}, ctx);
    expect(insights.historySource).toBe("local_sync_observations");
    expect(insights.followerHistory).toEqual(snapshot.followerHistory);
    await expect(instagramPostAnalytics({ postId: "missing-secret-input" }, ctx)).rejects.toMatchObject({ code: "not-found" });
    await expect(instagramPostAnalytics({ postId: "missing-secret-input" }, ctx)).rejects.not.toThrow("missing-secret-input");
  });

  it("allows disconnected status queries without a project or a refresh", async () => {
    snapshot.status = "disconnected";
    snapshot.account = null;
    snapshot.posts = [];
    snapshot.lastSyncedAt = null;
    const output = await instagramAccounts({}, ctx);
    expect(output.status).toBe("disconnected");
    expect(output.account).toBeNull();
    expect(service.sync).not.toHaveBeenCalled();
  });

  it("registers a read-only MCP tool and returns its validated structured payload", async () => {
    const session = new McpServer({ name: "instagram-test", version: "0.0.0" });
    serveCatalog(session, async (tool, args) => {
      if (tool.name === "instagram_accounts") return instagramAccounts(toolByName("instagram_accounts").input.parse(args), ctx);
      throw new Error("Unexpected tool");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await session.connect(serverTransport);
    const client = new Client({ name: "instagram-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools.filter((tool) => tool.name.startsWith("instagram_"));
      expect(listed).toHaveLength(4);
      for (const tool of listed) expect(tool.annotations?.readOnlyHint).toBe(true);
      const result = await client.callTool({ name: "instagram_accounts", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "connected", account: { username: "creator" }, dataSource: "local_cache" });
      expect(service.sync).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await session.close();
    }
  });
});
