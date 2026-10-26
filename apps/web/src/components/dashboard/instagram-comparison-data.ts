import { INSTAGRAM_METRICS, type InstagramPost } from '@desktop/instagram-types';
import { metricValue } from './analytics-data';

/** Observed lifetime differences only; no causal lift, inferred daily rates or fabricated missing values. */
export function compareInstagramPosts(first: InstagramPost, second: InstagramPost) {
  return INSTAGRAM_METRICS.map((metric) => {
    const a = metricValue(first.metrics[metric]), b = metricValue(second.metrics[metric]);
    return { metric, first: a, second: b, difference: a === null || b === null ? null : b - a,
      percent: a === null || b === null || a === 0 ? null : (b - a) / a * 100 };
  });
}
export function observedPostAgeHours(post: InstagramPost): number | null {
  const hours = (Date.parse(post.syncedAt) - Date.parse(post.publishedAt)) / 3600000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}
