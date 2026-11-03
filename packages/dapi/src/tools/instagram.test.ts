import { describe, expect, it } from "vitest";
import { catalog, toolByName } from "../catalog";

describe("Instagram tool contracts", () => {
  it("exposes four local read-only tools without credential or mutation inputs", () => {
    const tools = catalog.filter((tool) => tool.name.startsWith("instagram_"));
    expect(tools.map((tool) => tool.name)).toEqual([
      "instagram_accounts", "instagram_posts", "instagram_post_analytics", "instagram_account_insights",
    ]);
    for (const tool of tools) {
      expect(tool.environment).toBe("main");
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      for (const field of ["token", "refresh", "connect"]) expect(Object.keys(tool.input.shape)).not.toContain(field);
    }
  });

  it("bounds post lists and validates supported ranking fields", () => {
    const input = toolByName("instagram_posts").input;
    expect(input.parse({})).toEqual({ sortBy: "publishedAt", limit: 25 });
    expect(input.safeParse({ limit: 0 }).success).toBe(false);
    expect(input.safeParse({ limit: 26 }).success).toBe(false);
    expect(input.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(input.safeParse({ sortBy: "reach" }).success).toBe(false);
    expect(toolByName("instagram_post_analytics").input.safeParse({ postId: "" }).success).toBe(false);
  });

  it("gives each post its own file link for media_download, null when a cache predates it", () => {
    const metrics = { views: null, reach: null, likes: null, comments: null, saves: null, shares: null, averageWatchTimeMs: null };
    const post = { id: "1", caption: "", mediaType: "VIDEO", mediaProductType: "REELS", permalink: null, thumbnailUrl: null, publishedAt: "2026-01-01T00:00:00.000Z", syncedAt: "2026-01-02T00:00:00.000Z", metrics, history: [] };
    const output = (posts: unknown[]) => toolByName("instagram_posts").output.parse({
      status: "connected", account: null, lastSyncedAt: null, error: null, coverage: { fetchedPosts: posts.length, limit: 25, hasMore: false }, dataSource: "local_cache",
      metricPeriod: "lifetime", sortBy: "publishedAt", posts,
    });
    expect(output([post]).posts[0]!.mediaUrl).toBeNull();
    expect(output([{ ...post, mediaUrl: "https://scontent.cdninstagram.com/v/a.mp4" }]).posts[0]!.mediaUrl).toBe("https://scontent.cdninstagram.com/v/a.mp4");
    expect(toolByName("instagram_posts").description.length).toBeGreaterThan(40);
  });
});
