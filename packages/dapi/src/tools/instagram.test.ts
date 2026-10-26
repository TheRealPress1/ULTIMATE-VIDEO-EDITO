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
});
