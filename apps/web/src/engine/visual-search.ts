import type { VisualAnalysis, VisualSample } from '@desktop/visual-types';

export type VisualItem = {
  assetId: string; path: string; status: 'unindexed' | 'ready' | 'indexing' | 'stale' | 'error';
  fingerprint?: string; analysis?: VisualAnalysis; error?: string;
};
export type VisualMatch = {
  id: string; assetId: string; path: string; fingerprint: string;
  time: number; sourceIn: number; sourceOut: number; score: number;
  evidence: VisualSample; matchedTerms: string[];
};
export type VisualSnapshot = { items: VisualItem[]; loading: boolean; indexing: boolean;
  progress?: { completed: number; total: number; path: string; frames?: { completed: number; total: number } }; error?: string };

// Small, transparent vocabulary expansion. No embeddings, language model or
// inferred relationships: every query term must match recorded frame evidence.
const groups = [
  ['person', 'people', 'human', 'humans'], ['car', 'cars', 'automobile', 'vehicle'],
  ['bike', 'bicycle', 'cycling', 'biking'], ['run', 'running', 'jogging', 'runner'],
  ['swim', 'swimming', 'swimmer'], ['surf', 'surfing', 'surfer'],
  ['ski', 'skiing', 'skier'], ['cook', 'cooking'],
  ['dog', 'dogs', 'canine'], ['cat', 'cats', 'feline'], ['ocean', 'sea', 'seaside'],
  ['forest', 'woods', 'woodland'], ['city', 'urban', 'cityscape'],
  ['airplane', 'plane', 'aircraft'], ['phone', 'smartphone', 'cellphone'],
];
const stop = new Set('a an the of on in at with and for to from some showing show find footage shot shots b roll video clip clips scene scenes someone something'.split(' '));
const tokens = (value: string) => value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const normalized = (token: string): string => groups.find((group) => group.includes(token))?.[0] ?? (token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token);

/** Description keywords are AND-matched against each still, never across different frames. */
export function searchVisualFootage(items: readonly VisualItem[], query: string): VisualMatch[] {
  if (query.length > 1000) throw new Error('Keep visual searches under 1,000 characters.');
  const raw = tokens(query).filter((token) => !stop.has(token));
  const terms = [...new Set(raw.map(normalized))];
  if (query.trim() && !terms.length) return [];
  const results: VisualMatch[] = [];
  for (const item of items) {
    if (item.status !== 'ready' || !item.analysis || !item.fingerprint) continue;
    for (const sample of item.analysis.samples) {
      const evidence = [...sample.labels, ...sample.text, ...(sample.people ? [{ text: 'person', confidence: 0.65 }] : [])];
      const scores = new Map<string, number>();
      for (const entry of evidence) {
        for (const token of tokens(entry.text).map(normalized)) scores.set(token, Math.max(scores.get(token) ?? 0, entry.confidence));
      }
      if (terms.some((term) => !scores.has(term))) continue;
      // Intervals are audition suggestions around the actual observed frame;
      // they do not assert a shot boundary or continuous visibility.
      const sourceIn = Math.max(0, sample.time - Math.min(2, item.analysis.sampleInterval / 2));
      const sourceOut = Math.min(item.analysis.duration, sample.time + 3);
      results.push({ id: `${item.assetId}:${item.fingerprint}:${sample.time}`, assetId: item.assetId, path: item.path,
        fingerprint: item.fingerprint, time: sample.time, sourceIn, sourceOut,
        score: terms.length ? terms.reduce((sum, term) => sum + scores.get(term)!, 0) / terms.length : 0,
        evidence: sample, matchedTerms: raw });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.time - b.time);
}
