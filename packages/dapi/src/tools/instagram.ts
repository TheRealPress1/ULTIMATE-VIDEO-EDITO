/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

const Metric = z.number().nonnegative().nullable().describe("latest lifetime total at sync; null means unavailable, not zero");
const Metrics = z.object({
  views: Metric,
  reach: Metric,
  likes: Metric,
  comments: Metric,
  saves: Metric,
  shares: Metric,
  averageWatchTimeMs: z.number().nonnegative().nullable().describe("average watch time in milliseconds when provided by Instagram; null means unavailable"),
});
const Account = z.object({
  id: z.string(),
  username: z.string(),
  accountType: z.string(),
  followers: z.number().nonnegative().nullable(),
});
const Coverage = z.object({
  fetchedPosts: z.int().nonnegative(),
  limit: z.int().nonnegative(),
  hasMore: z.boolean().describe("Instagram has posts beyond the downloaded page; rankings only cover cached posts"),
});
const connectionFields = {
  status: z.enum(["disconnected", "connected", "reconnect_required", "unavailable"]),
  account: Account.nullable(),
  lastSyncedAt: z.string().nullable().describe("last successful sync timestamp; cached values may be stale"),
  error: z.string().nullable(),
  coverage: Coverage,
  dataSource: z.literal("local_cache").describe("this call reads saved analytics; it does not request a sync or contact Instagram"),
};
const Post = z.object({
  id: z.string(),
  caption: z.string(),
  mediaType: z.string(),
  mediaProductType: z.string(),
  permalink: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  publishedAt: z.string(),
  syncedAt: z.string(),
  metrics: Metrics,
});
const historyFields = {
  historySource: z.literal("local_sync_observations").describe("observations saved when the app synced; not a backfilled daily Instagram time series"),
};
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const instagramAccounts = defineTool({
  name: "instagram_accounts",
  title: "Instagram connection",
  description: "Read the connected Instagram account, connection status, last successful sync time, and cached-post coverage. Works without an open project. Reads the local analytics cache only; it does not connect an account, refresh data, or expose credentials. A disconnected account must be connected by the user in Settings → Instagram.",
  input: z.object({}),
  output: z.object(connectionFields),
  annotations: readOnly,
  environment: "main",
});

export const instagramPosts = defineTool({
  name: "instagram_posts",
  title: "Instagram posts",
  description: "List cached Instagram posts, newest first or ranked by a lifetime metric in descending order. Null metrics are unavailable, not zero, and sort last. Rankings cover only the downloaded posts, not necessarily the full account. Reads saved data without refreshing Instagram and works without an open project. Inspect lastSyncedAt before describing these as current stats.",
  input: z.object({
    sortBy: z.enum(["publishedAt", "views", "likes", "comments", "saves", "shares"]).default("publishedAt").describe("descending ranking: publishedAt, views, likes, comments, saves, or shares (default: publishedAt)"),
    limit: z.int().min(1).max(25).default(25).describe("number of cached posts to return, 1–25 (default: 25)"),
  }),
  output: z.object({
    ...connectionFields,
    metricPeriod: z.literal("lifetime"),
    sortBy: z.enum(["publishedAt", "views", "likes", "comments", "saves", "shares"]),
    posts: z.array(Post),
  }),
  annotations: readOnly,
  environment: "main",
});

export const instagramPostAnalytics = defineTool({
  name: "instagram_post_analytics",
  title: "Instagram post analytics",
  description: "Read one cached Instagram post's latest lifetime metrics and saved observations from previous syncs. Null means Instagram did not provide that metric. History starts when Cutroom observed the post and is not a backfilled daily time series. Reads the local cache without a project or a network sync. Use a postId returned by instagram_posts; unknown IDs return a not-found error.",
  input: z.object({ postId: z.string().min(1).describe("a cached Instagram media ID returned by instagram_posts") }),
  output: z.object({
    ...connectionFields,
    ...historyFields,
    metricPeriod: z.literal("lifetime"),
    post: Post.extend({ history: z.array(z.object({ syncedAt: z.string(), metrics: Metrics })) }),
  }),
  annotations: readOnly,
  environment: "main",
});

export const instagramAccountInsights = defineTool({
  name: "instagram_account_insights",
  title: "Instagram account insights",
  description: "Read the connected account's latest follower count and follower observations saved by Cutroom's syncs. This is observed history since connection, not historical daily growth from Instagram; do not infer missing dates or pre-connection followers. Includes connection state, sync freshness and cached-post coverage. Reads local data only and does not require a project.",
  input: z.object({}),
  output: z.object({
    ...connectionFields,
    ...historyFields,
    followerHistory: z.array(z.object({ syncedAt: z.string(), followers: z.number().nonnegative() })),
  }),
  annotations: readOnly,
  environment: "main",
});
