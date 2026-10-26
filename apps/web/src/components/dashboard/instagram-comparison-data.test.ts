import { describe, expect, it } from 'vitest';
import type { InstagramPost } from '@desktop/instagram-types';
import { compareInstagramPosts, observedPostAgeHours } from './instagram-comparison-data';
const post = (views: number | null) => ({ id: '1', publishedAt: '2026-10-01T00:00:00Z', syncedAt: '2026-10-03T00:00:00Z', metrics: { views, reach: null, likes: 0, comments: 1, saves: null, shares: 2, averageWatchTimeMs: 3500 } }) as InstagramPost;
describe('observed Instagram post comparisons', () => {
  it('calculates only measured lifetime differences and preserves unavailable data', () => {
    const rows = compareInstagramPosts(post(100), post(150));
    expect(rows[0]).toMatchObject({ difference: 50, percent: 50 });
    expect(rows.find((row) => row.metric === 'reach')).toMatchObject({ first: null, second: null, difference: null, percent: null });
  });
  it('does not invent percent gains from a zero or missing baseline', () => {
    expect(compareInstagramPosts(post(0), post(25))[0]).toMatchObject({ difference: 25, percent: null });
    expect(compareInstagramPosts(post(null), post(25))[0]).toMatchObject({ difference: null, percent: null });
  });
  it('shows actual measurement age instead of normalizing different post ages into a fake experiment', () => {
    expect(observedPostAgeHours(post(1))).toBe(48);
    expect(observedPostAgeHours({ ...post(1), syncedAt: 'invalid' })).toBeNull();
  });
});
