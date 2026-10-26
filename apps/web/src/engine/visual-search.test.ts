import { describe, expect, it } from 'vitest';
import { searchVisualFootage, type VisualItem } from './visual-search';
const item: VisualItem = { assetId: 'video', path: 'Ride.mp4', fingerprint: 'a'.repeat(64), status: 'ready', analysis: {
  sourceStart: 0, duration: 12, width: 1920, height: 1080, sampleInterval: 5, samples: [
    { time: 0, mediaTime: 0, labels: [{ text: 'bicycle', confidence: 0.9 }, { text: 'outdoor', confidence: 0.8 }], text: [], people: 1 },
    { time: 5, mediaTime: 5, labels: [{ text: 'car', confidence: 0.8 }], text: [{ text: 'Café OPEN', confidence: 0.95 }], people: 0 },
    { time: 10, mediaTime: 10, labels: [{ text: 'running', confidence: 0.7 }], text: [], people: 2 },
  ],
} };
describe('visual evidence retrieval', () => {
  it('finds description keywords and explicit synonyms in the same observed frame', () => {
    const result = searchVisualFootage([item], 'B-roll of a person with a bike');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ time: 0, sourceIn: 0, sourceOut: 3, fingerprint: item.fingerprint });
    expect(result[0]!.evidence.labels[0]!.text).toBe('bicycle');
  });
  it('searches OCR case-insensitively while preserving the exact visible text', () => {
    expect(searchVisualFootage([item], 'café open')[0]?.evidence.text[0]?.text).toBe('Café OPEN');
  });
  it('does not combine unrelated observations across timestamps or invent semantic events', () => {
    expect(searchVisualFootage([item], 'car person')).toEqual([]);
    expect(searchVisualFootage([item], 'person falling off a bike')).toEqual([]);
  });
  it('retrieves activity labels without claiming continuous action or shot boundaries', () => {
    expect(searchVisualFootage([item], 'runner')[0]).toMatchObject({ time: 10, sourceIn: 8, sourceOut: 12 });
  });
  it('browses valid samples only and omits stale or missing indexes', () => {
    expect(searchVisualFootage([item, { ...item, status: 'stale' }, { ...item, fingerprint: undefined }], '')).toHaveLength(3);
    expect(searchVisualFootage([item], '!!!')).toEqual([]);
  });
  it('ranks actual matching confidence ahead of chronological order and bounds query length', () => {
    const next = { ...item, path: 'Higher.mp4', analysis: { ...item.analysis!, samples: [{ ...item.analysis!.samples[0]!, labels: [{ text: 'bicycle', confidence: 0.99 }] }] } };
    expect(searchVisualFootage([item, next], 'bicycle')[0]?.path).toBe('Higher.mp4');
    expect(() => searchVisualFootage([item], 'x'.repeat(1001))).toThrow('1,000');
  });
});
