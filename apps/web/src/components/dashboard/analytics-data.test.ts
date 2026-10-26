import { describe, expect, it } from "vitest";
import type { InstagramMetrics, InstagramPost } from "@desktop/instagram-types";
import {
  filterPublishedPosts, instagramPermalink, observedMetricTrend, postMetricPoints,
  postingActivity, sortPosts, summarizeMetric, trendChange, trendPoints,
} from "./analytics-data";

const noMetrics: InstagramMetrics = { views: null, reach: null, likes: null, comments: null, saves: null, shares: null, averageWatchTimeMs: null };
const post = (id: string, metrics: Partial<InstagramMetrics> = {}, publishedAt = "2026-10-20T12:00:00Z"): InstagramPost => ({
  id, caption: id, mediaType: "VIDEO", mediaProductType: "REELS", permalink: null, thumbnailUrl: null,
  publishedAt, syncedAt: "2026-10-21T12:00:00Z", metrics: { ...noMetrics, ...metrics }, history: [],
});

describe("Instagram analytics reporting", () => {
  it("distinguishes unavailable totals from measured zero and reports partial coverage", () => {
    expect(summarizeMetric([], "views")).toEqual({ value: null, measured: 0 });
    expect(summarizeMetric([post("unknown")], "views")).toEqual({ value: null, measured: 0 });
    expect(summarizeMetric([post("zero", { views: 0 })], "views")).toEqual({ value: 0, measured: 1 });
    expect(summarizeMetric([
      post("one", { views: 10 }), post("missing"), post("zero", { views: 0 }), post("two", { views: 5 }),
    ], "views")).toEqual({ value: 15, measured: 3 });
  });

  it("excludes invalid measurements instead of presenting them as real totals", () => {
    expect(summarizeMetric([
      post("negative", { likes: -1 }), post("invalid", { likes: Number.NaN }), post("infinite", { likes: Infinity }),
    ], "likes")).toEqual({ value: null, measured: 0 });
  });

  it("keeps missing data last in ascending and descending rankings", () => {
    const posts = [post("missing"), post("ten", { views: 10 }), post("zero", { views: 0 })];
    expect(sortPosts(posts, "views", true).map((entry) => entry.id)).toEqual(["zero", "ten", "missing"]);
    expect(sortPosts(posts, "views", false).map((entry) => entry.id)).toEqual(["ten", "zero", "missing"]);
    expect(posts.map((entry) => entry.id)).toEqual(["missing", "ten", "zero"]);
  });

  it("sorts publication dates with unavailable dates last", () => {
    const posts = [post("unknown", {}, "invalid"), post("new", {}, "2026-10-20T12:00:00Z"), post("old", {}, "2026-01-01T12:00:00Z")];
    expect(sortPosts(posts, "publishedAt", false).map((entry) => entry.id)).toEqual(["new", "old", "unknown"]);
    expect(sortPosts(posts, "publishedAt", true).map((entry) => entry.id)).toEqual(["old", "new", "unknown"]);
  });

  it("filters publication dates without reinterpreting lifetime metrics as period metrics", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const recent = post("recent", { views: 10_000 }, "2026-10-20T12:00:00Z");
    const boundary = post("boundary", { views: 2_000 }, "2026-10-14T12:00:00Z");
    const entries = [recent, boundary, post("older", { views: 40_000 }, "2026-10-14T11:59:59Z"), post("future", {}, "2026-10-22T00:00:00Z"), post("unknown", {}, "invalid")];
    const result = filterPublishedPosts(entries, 7, now);
    expect(result).toEqual([recent, boundary]);
    expect(result[0]).toBe(recent);
    expect(summarizeMetric(result, "views")).toEqual({ value: 12_000, measured: 2 });
    expect(filterPublishedPosts(entries, 0, now)).toBe(entries);
  });

  it("deduplicates observation timestamps and keeps only valid data in time order", () => {
    expect(trendPoints([
      { date: "2026-10-21T12:00:00Z", value: 20 },
      { date: "2026-10-20T12:00:00Z", value: 0 },
      { date: "invalid", value: 99 },
      { date: "2026-10-19T12:00:00Z", value: -1 },
      { date: "2026-10-21T12:00:00.000Z", value: 21 },
    ])).toEqual([
      { date: "2026-10-20T12:00:00Z", value: 0 },
      { date: "2026-10-21T12:00:00.000Z", value: 21 },
    ]);
  });

  it("builds Sunday-first posting weeks across year boundaries with UTC day counts", () => {
    const entries = [
      post("boundary", {}, "2025-12-21T00:00:00Z"),
      post("before", {}, "2025-12-20T23:59:59Z"),
      post("one", {}, "2026-01-01T10:00:00Z"),
      post("one", {}, "2026-01-01T10:00:00Z"),
      post("two", {}, "2026-01-02T00:30:00+02:00"),
      post("three", {}, "2026-01-01T11:00:00Z"),
      post("four", {}, "2026-01-01T12:00:00Z"),
      post("five", {}, "2026-01-01T13:00:00Z"),
      post("later-today", {}, "2026-01-01T23:30:00Z"),
      post("future", {}, "2026-01-02T10:00:00Z"),
      post("invalid", {}, "invalid"),
    ];
    const activity = postingActivity(entries, Date.parse("2026-01-01T23:00:00Z"), 2);
    expect(activity.cells).toHaveLength(14);
    expect(activity.cells[0]).toEqual({ date: "2025-12-21", count: 1, level: 1, future: false });
    expect(activity.cells[7].date).toBe("2025-12-28");
    expect(activity.cells[11]).toEqual({ date: "2026-01-01", count: 5, level: 4, future: false });
    expect(activity.cells[12]).toEqual({ date: "2026-01-02", count: 0, level: 0, future: true });
    expect(activity.cells[13]).toEqual({ date: "2026-01-03", count: 0, level: 0, future: true });
    expect(activity.months).toEqual([{ label: "Dec", column: 0 }, { label: "Jan", column: 1 }]);
    expect(activity.total).toBe(6);
    expect(activity.activeDays).toBe(2);
  });

  it("keeps leap days and spans 53 complete weeks by default", () => {
    const now = Date.parse("2024-03-01T12:00:00Z");
    const activity = postingActivity([post("leap", {}, "2024-02-29T23:00:00Z")], now, 1);
    expect(activity.cells.map((cell) => cell.date)).toEqual([
      "2024-02-25", "2024-02-26", "2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02",
    ]);
    expect(activity.cells[4].count).toBe(1);
    expect(activity.cells[6].future).toBe(true);
    const year = postingActivity([], now);
    expect(year.cells).toHaveLength(371);
    expect(new Date(year.cells[0].date).getUTCDay()).toBe(0);
    expect(new Date(year.cells.at(-1)!.date).getUTCDay()).toBe(6);
  });

  it("plots measured lifetime post values by publication without inventing missing data", () => {
    expect(postMetricPoints([
      post("new", { views: 8 }, "2026-10-21T12:00:00Z"),
      post("missing"),
      post("zero", { views: 0 }, "2026-10-19T12:00:00Z"),
      post("same-time", { views: 4 }, "2026-10-21T12:00:00Z"),
      post("zero", { views: 0 }, "2026-10-19T12:00:00Z"),
      post("invalid-date", { views: 1 }, "invalid"),
      post("invalid-value", { views: -1 }),
    ], "views")).toEqual([
      { date: "2026-10-19T12:00:00Z", value: 0 },
      { date: "2026-10-21T12:00:00Z", value: 8 },
      { date: "2026-10-21T12:00:00Z", value: 4 },
    ]);
  });

  it("sums only common observed days for a stable cohort of currently measured posts", () => {
    const first = post("first", { views: 20 });
    first.history = [
      { syncedAt: "2026-10-19T12:00:00Z", metrics: { ...noMetrics, views: 0 } },
      { syncedAt: "2026-10-20T12:00:00Z", metrics: { ...noMetrics, views: 10 } },
    ];
    const later = post("later", { views: 5 });
    later.history = [{ syncedAt: "2026-10-20T14:00:00Z", metrics: { ...noMetrics, views: 3 } }];
    const unavailable = post("unavailable");
    unavailable.history = [{ syncedAt: "2026-10-19T12:00:00Z", metrics: { ...noMetrics, views: 999 } }];
    expect(observedMetricTrend([first, later, unavailable, first], "views")).toEqual({
      measured: 2,
      points: [
        { date: "2026-10-20T00:00:00.000Z", value: 13 },
        { date: "2026-10-21T00:00:00.000Z", value: 25 },
      ],
    });
    expect(observedMetricTrend([unavailable], "views")).toEqual({ measured: 0, points: [] });
  });

  it("uses the latest daily sample and excludes days whose latest measurement is unavailable", () => {
    const first = post("first", { views: 0 });
    first.history = [
      { syncedAt: "2026-10-20T09:00:00Z", metrics: { ...noMetrics, views: 10 } },
      { syncedAt: "2026-10-20T08:00:00Z", metrics: { ...noMetrics, views: 8 } },
      { syncedAt: "2026-10-20T20:00:00Z", metrics: { ...noMetrics, views: null } },
      { syncedAt: "2026-10-20T23:30:00-02:00", metrics: { ...noMetrics, views: 11 } },
      { syncedAt: "invalid", metrics: { ...noMetrics, views: 999 } },
    ];
    const second = post("second", { views: 0 });
    second.history = [{ syncedAt: "2026-10-20T10:00:00Z", metrics: { ...noMetrics, views: 5 } }];
    expect(observedMetricTrend([first, second], "views")).toEqual({
      measured: 2, points: [{ date: "2026-10-21T00:00:00.000Z", value: 0 }],
    });
    second.syncedAt = "2026-10-22T12:00:00Z";
    expect(observedMetricTrend([first, second], "views")).toEqual({ measured: 2, points: [] });
  });

  it("calculates change only from comparable real observations without a fictitious zero baseline", () => {
    expect(trendChange([])).toBeNull();
    expect(trendChange([{ date: "2026-10-21T12:00:00Z", value: 10 }])).toBeNull();
    const change = (start: number, end: number) => trendChange([
      { date: "2026-10-21T12:00:00Z", value: end },
      { date: "2026-10-20T12:00:00Z", value: start },
    ]);
    expect(change(10, 15)).toEqual({ delta: 5, percent: 50 });
    expect(change(10, 5)).toEqual({ delta: -5, percent: -50 });
    expect(change(0, 5)).toEqual({ delta: 5, percent: null });
    expect(change(0, 0)).toEqual({ delta: 0, percent: 0 });
  });

  it("only opens Instagram HTTPS permalinks", () => {
    expect(instagramPermalink("https://www.instagram.com/reel/example/")).toBe("https://www.instagram.com/reel/example/");
    expect(instagramPermalink("https://instagram.com.evil.example/reel/example/")).toBeNull();
    expect(instagramPermalink("javascript:alert(1)")).toBeNull();
    expect(instagramPermalink("http://instagram.com/reel/example/")).toBeNull();
    expect(instagramPermalink(null)).toBeNull();
  });
});
