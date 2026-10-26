import { describe, expect, it } from 'vitest';
import { visualIndex, visualSearch, visualStatus } from './visual';
describe('visual tool contracts', () => {
  it('defaults a bounded search and discloses its evidence method', () => {
    expect(visualSearch.input.parse({})).toEqual({ query: '', limit: 50, mode: 'keywords' });
    expect(visualSearch.description).toContain('CLIP embedding cosine similarity');
    expect(visualSearch.output.safeParse({ matches: [], total: 0, unavailable: [], method: 'sampled-labels-ocr' }).success).toBe(true);
  });
  it('rejects oversized batches, queries and result limits', () => {
    expect(visualIndex.input.safeParse({ paths: Array(501).fill('source.mp4') }).success).toBe(false);
    expect(visualSearch.input.safeParse({ query: 'x'.repeat(1001) }).success).toBe(false);
    expect(visualSearch.input.safeParse({ limit: 201 }).success).toBe(false);
  });
  it('publishes read-only search and status without claiming index is read-only', () => {
    expect(visualSearch.annotations?.readOnlyHint).toBe(true);
    expect(visualStatus.annotations?.readOnlyHint).toBe(true);
    expect(visualIndex.annotations?.destructiveHint).toBe(false);
  });
});
