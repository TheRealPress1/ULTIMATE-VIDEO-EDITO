import type { InstagramMetric, InstagramPost } from "@desktop/instagram-types";

export type PostSort = "publishedAt" | Exclude<InstagramMetric, "averageWatchTimeMs">;
export type AnalyticsPoint = { date: string; value: number };
export type PostingActivityCell = { date: string; count: number; level: number; future: boolean };

const DAY_MS = 24 * 60 * 60 * 1_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function metricValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Missing measurements remain missing; partial sums retain their reporting coverage. */
export function summarizeMetric(posts: InstagramPost[], metric: InstagramMetric) {
  const values = posts.map((post) => metricValue(post.metrics[metric])).filter((value) => value !== null);
  return { value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, measured: values.length };
}

export function filterPublishedPosts(posts: InstagramPost[], days: number, now = Date.now()) {
  if (!days) return posts;
  const start = now - days * 24 * 60 * 60 * 1_000;
  return posts.filter((post) => {
    const published = Date.parse(post.publishedAt);
    return Number.isFinite(published) && published >= start && published <= now;
  });
}

export function sortPosts(posts: InstagramPost[], key: PostSort, ascending: boolean) {
  const value = (post: InstagramPost) => key === "publishedAt"
    ? metricValue(Date.parse(post.publishedAt))
    : metricValue(post.metrics[key]);
  return [...posts].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    // Missing data stays at the bottom in either direction.
    if (left === null) return right === null ? a.id.localeCompare(b.id) : 1;
    if (right === null) return -1;
    return (ascending ? left - right : right - left) || a.id.localeCompare(b.id);
  });
}

export function trendPoints(points: AnalyticsPoint[]): AnalyticsPoint[] {
  const unique = new Map<number, AnalyticsPoint>();
  for (const point of points) {
    const date = Date.parse(point.date);
    if (Number.isFinite(date) && metricValue(point.value) !== null) unique.set(date, point);
  }
  return [...unique.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);
}

/** A Sunday-first, column-major calendar of the posts we actually fetched. */
export function postingActivity(posts: InstagramPost[], now = Date.now(), weeks = 53) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const weekCount = Number.isFinite(weeks) ? Math.max(1, Math.floor(weeks)) : 53;
  const currentSunday = today - new Date(today).getUTCDay() * DAY_MS;
  const start = currentSunday - (weekCount - 1) * 7 * DAY_MS;
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const post of posts) {
    const published = Date.parse(post.publishedAt);
    if (!Number.isFinite(published) || published < start || published > now || seen.has(post.id)) continue;
    seen.add(post.id);
    const day = new Date(published).toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const cells: PostingActivityCell[] = Array.from({ length: weekCount * 7 }, (_, index) => {
    const timestamp = start + index * DAY_MS;
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const count = counts.get(date) ?? 0;
    return { date, count, level: Math.min(count, 4), future: timestamp > today };
  });
  const months: { label: string; column: number }[] = [];
  for (let column = 0; column < weekCount; column += 1) {
    const week = cells.slice(column * 7, column * 7 + 7);
    const monthStart = week.find((cell) => cell.date.endsWith("-01"));
    const labelDate = monthStart ?? (column === 0 ? week[0] : undefined);
    if (labelDate) months.push({ label: MONTHS[Number(labelDate.date.slice(5, 7)) - 1], column });
  }
  return {
    cells, months,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    activeDays: counts.size,
  };
}

/** Latest lifetime measurement per post, positioned by its publication date. */
export function postMetricPoints(posts: InstagramPost[], metric: InstagramMetric): AnalyticsPoint[] {
  const unique = new Map<string, InstagramPost>();
  for (const post of posts) if (!unique.has(post.id)) unique.set(post.id, post);
  return [...unique.values()]
    .filter((post) => Number.isFinite(Date.parse(post.publishedAt)) && metricValue(post.metrics[metric]) !== null)
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id.localeCompare(b.id))
    .map((post) => ({ date: post.publishedAt, value: post.metrics[metric]! }));
}

/** Compare a fixed cohort only on UTC days when every member was measured. */
export function observedMetricTrend(posts: InstagramPost[], metric: InstagramMetric) {
  const unique = new Map<string, InstagramPost>();
  for (const post of posts) if (!unique.has(post.id)) unique.set(post.id, post);
  const cohort = [...unique.values()].filter((post) => metricValue(post.metrics[metric]) !== null);
  const observations = cohort.map((post) => {
    const byDay = new Map<string, { time: number; value: number | null }>();
    for (const sample of [...post.history, { syncedAt: post.syncedAt, metrics: post.metrics }]) {
      const time = Date.parse(sample.syncedAt);
      if (!Number.isFinite(time)) continue;
      const day = new Date(time).toISOString().slice(0, 10);
      const previous = byDay.get(day);
      // A later unavailable sample must not resurrect an earlier measurement that day.
      if (!previous || time >= previous.time) byDay.set(day, { time, value: metricValue(sample.metrics[metric]) });
    }
    return new Map([...byDay].filter(([, sample]) => sample.value !== null).map(([day, sample]) => [day, sample.value!]));
  });
  const points: AnalyticsPoint[] = observations.length
    ? [...observations[0].keys()].filter((day) => observations.every((samples) => samples.has(day)))
      .sort()
      .map((day) => ({ date: `${day}T00:00:00.000Z`, value: observations.reduce((sum, samples) => sum + samples.get(day)!, 0) }))
    : [];
  return { points, measured: cohort.length };
}

/** Change between comparable observations; a zero baseline has no percentage. */
export function trendChange(points: AnalyticsPoint[]): { delta: number; percent: number | null } | null {
  const ordered = trendPoints(points);
  if (ordered.length < 2) return null;
  const baseline = ordered[0].value;
  const delta = ordered[ordered.length - 1].value - baseline;
  return { delta, percent: baseline === 0 ? (delta === 0 ? 0 : null) : delta / baseline * 100 };
}

export function instagramPermalink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname)
      ? url.href : null;
  } catch {
    return null;
  }
}
