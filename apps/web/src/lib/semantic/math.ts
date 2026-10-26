import { CLIP_DIMENSIONS, CLIP_KEY } from './model';
import { VISUAL_ENGINE } from '@desktop/visual-types';
import type { VisualItem, VisualMatch } from '@/engine/visual-search';

export type SemanticRecord = { key: string; fingerprint: string; model: string; times: number[]; vectors: number[][]; usedAt: number };
export function normalizeVector(value: ArrayLike<number>): number[] {
  if (value.length !== CLIP_DIMENSIONS) throw new Error('Description embedding has an invalid dimension.');
  const vector = Array.from(value);
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (!vector.every(Number.isFinite) || !Number.isFinite(norm) || norm < 1e-12) throw new Error('Description embedding is invalid.');
  return vector.map((v) => v / norm);
}
export function semanticKey(fingerprint: string): string { return `${CLIP_KEY}:${VISUAL_ENGINE}:${fingerprint}`; }
export function validSemanticRecord(value: unknown, fingerprint: string, times: readonly number[]): value is SemanticRecord {
  if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(fingerprint) || !times.length || times.length > 720) return false;
  const record = value as SemanticRecord;
  return record.key === semanticKey(fingerprint) && record.fingerprint === fingerprint && record.model === CLIP_KEY &&
    Number.isFinite(record.usedAt) && Array.isArray(record.times) && record.times.length === times.length &&
    record.times.every((time, i) => Number.isFinite(time) && time >= 0 && time === times[i] && (i === 0 || time >= record.times[i - 1]!)) &&
    Array.isArray(record.vectors) && record.vectors.length === times.length && record.vectors.every((vector) =>
      Array.isArray(vector) && vector.length === CLIP_DIMENSIONS && vector.every(Number.isFinite) &&
      Math.abs(vector.reduce((sum, v) => sum + v * v, 0) - 1) < 0.002);
}
/** Cosine similarity is a ranking score, never a probability or proof. */
export function rankSemanticFrames(items: readonly VisualItem[], records: ReadonlyMap<string, SemanticRecord>, query: ArrayLike<number>): VisualMatch[] {
  const normalized = normalizeVector(query);
  const result: VisualMatch[] = [];
  for (const item of items) {
    if (item.status !== 'ready' || !item.analysis || !item.fingerprint) continue;
    const record = records.get(item.fingerprint);
    if (!validSemanticRecord(record, item.fingerprint, item.analysis.samples.map((sample) => sample.time))) continue;
    item.analysis.samples.forEach((sample, index) => {
      const score = Math.max(-1, Math.min(1, record.vectors[index]!.reduce((sum, v, i) => sum + v * normalized[i]!, 0)));
      result.push({ id: `${item.assetId}:${item.fingerprint}:${sample.time}`, assetId: item.assetId, path: item.path,
        fingerprint: item.fingerprint!, time: sample.time, score, evidence: sample, matchedTerms: [],
        sourceIn: Math.max(0, sample.time - Math.min(2, item.analysis!.sampleInterval / 2)), sourceOut: Math.min(item.analysis!.duration, sample.time + 3) });
    });
  }
  return result.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.time - b.time);
}

/** Bound persisted vectors to 20,000 frames (~41MB floats, larger JSON/IDB representation). */
export function semanticEvictions(records: readonly Pick<SemanticRecord, 'key' | 'times' | 'usedAt'>[], maximum = 20_000): string[] {
  let count = records.reduce((sum, record) => sum + record.times.length, 0);
  const removed: string[] = [];
  for (const record of [...records].sort((a, b) => a.usedAt - b.usedAt || a.key.localeCompare(b.key))) {
    if (count <= maximum) break;
    removed.push(record.key); count -= record.times.length;
  }
  return removed;
}
