/** Instagram analytics shared by desktop IPC and the dashboard. No credentials cross this boundary. */
export const INSTAGRAM_METRICS = ["views", "reach", "likes", "comments", "saves", "shares", "averageWatchTimeMs"] as const;
export type InstagramMetric = typeof INSTAGRAM_METRICS[number];
export type InstagramMetrics = Record<InstagramMetric, number | null>;
export type InstagramAccount = {
  id: string;
  username: string;
  accountType: string;
  followers: number | null;
};
export type InstagramPost = {
  id: string;
  caption: string;
  mediaType: string;
  mediaProductType: string;
  permalink: string | null;
  thumbnailUrl: string | null;
  /** The post's own file on Instagram's CDN as of the last sync (Graph `media_url`); it expires, and some posts have none. */
  mediaUrl?: string | null;
  publishedAt: string;
  syncedAt: string;
  metrics: InstagramMetrics;
  history: { syncedAt: string; metrics: InstagramMetrics }[];
};
export type InstagramDashboard = {
  status: "disconnected" | "connected" | "reconnect_required" | "unavailable";
  account: InstagramAccount | null;
  lastSyncedAt: string | null;
  error: string | null;
  posts: InstagramPost[];
  followerHistory: { syncedAt: string; followers: number }[];
  coverage: { fetchedPosts: number; limit: number; hasMore: boolean };
};
