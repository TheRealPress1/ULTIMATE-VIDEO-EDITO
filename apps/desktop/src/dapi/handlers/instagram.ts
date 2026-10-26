import { DapiError, toolByName } from "@diffusionstudio/dapi";
import { instagramService } from "../../instagram";

import type { ToolOutput } from "@diffusionstudio/dapi";
import type { InstagramDashboard } from "../../instagram-types";
import type { MainHandler } from "../handler";

/** Parse the public schema to keep future private service fields out of MCP. */
function connection(snapshot: InstagramDashboard): ToolOutput<"instagram_accounts"> {
  return toolByName("instagram_accounts").output.parse({
    status: snapshot.status,
    account: snapshot.account,
    lastSyncedAt: snapshot.lastSyncedAt,
    error: snapshot.error,
    coverage: snapshot.coverage,
    dataSource: "local_cache",
  });
}

export const instagramAccounts: MainHandler<"instagram_accounts"> = async () => connection(await instagramService().snapshot());

export const instagramPosts: MainHandler<"instagram_posts"> = async ({ sortBy, limit }) => {
  const snapshot = await instagramService().snapshot();
  const posts = [...snapshot.posts].sort((a, b) => {
    if (sortBy !== "publishedAt") {
      const left = a.metrics[sortBy];
      const right = b.metrics[sortBy];
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      if (left !== null && right !== null && left !== right) return right - left;
    }
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id);
  });
  return toolByName("instagram_posts").output.parse({
    ...connection(snapshot),
    metricPeriod: "lifetime",
    sortBy,
    posts: posts.slice(0, limit),
  });
};

export const instagramPostAnalytics: MainHandler<"instagram_post_analytics"> = async ({ postId }) => {
  const snapshot = await instagramService().snapshot();
  const post = snapshot.posts.find((post) => post.id === postId);
  if (!post) throw new DapiError("not-found", "This Instagram post is not in the local analytics cache. Use instagram_posts to see available post IDs.");
  return toolByName("instagram_post_analytics").output.parse({
    ...connection(snapshot),
    metricPeriod: "lifetime",
    historySource: "local_sync_observations",
    post,
  });
};

export const instagramAccountInsights: MainHandler<"instagram_account_insights"> = async () => {
  const snapshot = await instagramService().snapshot();
  return toolByName("instagram_account_insights").output.parse({
    ...connection(snapshot),
    historySource: "local_sync_observations",
    followerHistory: snapshot.followerHistory,
  });
};
