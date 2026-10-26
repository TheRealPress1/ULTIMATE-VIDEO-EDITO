import { describe, expect, it } from 'vitest';
import { CLIP_KEY, CLIP_FILES, CLIP_BYTES, clipURL, verifyClipFile } from './model';
import { normalizeVector, rankSemanticFrames, semanticEvictions, semanticKey, validSemanticRecord, type SemanticRecord } from './math';
const fingerprint = 'a'.repeat(64);
const vector = (index: number, scale = 1) => Array.from({ length: 512 }, (_, i) => i === index ? scale : 0);
const record = (): SemanticRecord => ({ key: semanticKey(fingerprint), fingerprint, model: CLIP_KEY, times: [0, 5], vectors: [vector(0), vector(1)], usedAt: 100 });
describe('local CLIP vector integrity and retrieval', () => {
  it('normalizes embeddings and refuses nonfinite, zero and wrong-size model outputs', () => {
    expect(normalizeVector(vector(0, 9))).toEqual(vector(0));
    for (const invalid of [[], vector(0, 0), vector(0, Infinity), vector(0, NaN)]) expect(() => normalizeVector(invalid)).toThrow();
  });
  it('rejects stale source/revision/sample geometry and corrupt cached vectors', () => {
    expect(validSemanticRecord(record(), fingerprint, [0, 5])).toBe(true);
    const invalid = [null, {}, { ...record(), key: `${CLIP_KEY}:${fingerprint}` }, { ...record(), model: 'old' }, { ...record(), fingerprint: 'b'.repeat(64) }, { ...record(), times: [0, 6] },
      { ...record(), vectors: [vector(0)] }, { ...record(), vectors: [vector(0, 2), vector(1)] },
      { ...record(), vectors: [vector(0, NaN), vector(1)] }, { ...record(), vectors: [vector(0).slice(0, 511), vector(1)] }];
    for (const value of invalid) expect(validSemanticRecord(value, fingerprint, [0, 5])).toBe(false);
  });
  it('ranks semantically aligned images without requiring query words in labels', () => {
    const items = [{ assetId: 'source', path: 'news.mp4', status: 'ready' as const, fingerprint,
      analysis: { sourceStart: 0, duration: 7, width: 1920, height: 1080, sampleInterval: 5, samples: [0, 5].map((time) => ({ time, mediaTime: time, labels: [], text: [], people: 0 })) } }];
    const matches = rankSemanticFrames(items, new Map([[fingerprint, record()]]), vector(1));
    expect(matches.map((match) => [match.time, match.score])).toEqual([[5, 1], [0, 0]]);
    expect(matches[0]).toMatchObject({ sourceIn: 3, sourceOut: 7, fingerprint, matchedTerms: [] });
    expect(rankSemanticFrames([{ ...items[0]!, fingerprint: 'b'.repeat(64) }], new Map([[fingerprint, record()]]), vector(1))).toEqual([]);
    expect(rankSemanticFrames([{ ...items[0]!, status: 'stale' }], new Map([[fingerprint, record()]]), vector(1))).toEqual([]);
  });
  it('evicts the least recently used complete records within the frame budget', () => {
    expect(semanticEvictions([{ key: 'old', times: [0, 5], usedAt: 1 }, { key: 'new', times: [0, 5], usedAt: 3 }, { key: 'middle', times: [0], usedAt: 2 }], 3)).toEqual(['old']);
  });
  it('pins every download URL, size and SHA and rejects tampered model bytes', async () => {
    expect(CLIP_BYTES).toBe(155851446);
    expect(CLIP_FILES.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && clipURL(file.path).startsWith('https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189'))).toBe(true);
    await expect(verifyClipFile('unknown', new ArrayBuffer(1))).rejects.toThrow('Invalid');
    await expect(verifyClipFile('config.json', new ArrayBuffer(4524))).rejects.toThrow('integrity');
  });
});
