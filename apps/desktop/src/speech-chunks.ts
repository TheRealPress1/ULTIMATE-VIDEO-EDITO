import type { SpeechSegment, SpeechWord } from './speech-types';

/** Native speech jobs stay bounded even when the source is a two-hour interview. */
export const SPEECH_CHUNK_SECONDS = 300;
export const SPEECH_CHUNK_OVERLAP = 2;
export const SPEECH_CHUNK_MAX_SECONDS = SPEECH_CHUNK_SECONDS + 2 * SPEECH_CHUNK_OVERLAP;
export const SPEECH_CHUNK_ENGINE = 'whisper-base-source-chunks-v2';
export type SpeechChunk = { index: number; start: number; end: number; coreStart: number; coreEnd: number };
export function speechChunks(duration: number, start = 0, end = duration, chunkSeconds = SPEECH_CHUNK_SECONDS): SpeechChunk[] {
  if (![duration, start, end, chunkSeconds].every(Number.isFinite) || chunkSeconds <= 0 || chunkSeconds > SPEECH_CHUNK_SECONDS || duration <= 0 || start < 0 || start >= end || end > duration) throw new Error('Choose a valid speech analysis window.');
  const total = Math.ceil((end - start) / chunkSeconds);
  return Array.from({ length: total }, (_, index) => {
    const coreStart = start + index * chunkSeconds, coreEnd = Math.min(end, coreStart + chunkSeconds);
    return { index, coreStart, coreEnd, start: Math.max(start, coreStart - SPEECH_CHUNK_OVERLAP), end: Math.min(end, coreEnd + SPEECH_CHUNK_OVERLAP) };
  });
}
const token = (word: SpeechWord) => word.text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const middle = (word: SpeechWord) => (word.start + word.end) / 2;
const wordsFor = (segments: readonly SpeechSegment[]): SpeechWord[] => segments.flatMap(segment => segment.words.map(word => ({ ...word })));

/** Reconcile overlapping recognition using a timed shared-word anchor. No words are synthesized. */
export function mergeSpeechChunks(chunks: readonly { window: SpeechChunk; segments: readonly SpeechSegment[] }[], start = 0, end = Infinity): SpeechSegment[] {
  let joined: SpeechWord[] = [];
  for (const { window, segments } of chunks) {
    const next = wordsFor(segments).filter(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start && word.end > start && word.start < end).sort((a, b) => a.start - b.start);
    if (!next.length) continue;
    if (!joined.length) { joined = next; continue; }
    const seam = window.coreStart;
    let best: { left: number; right: number; length: number; score: number } | undefined;
    const leftBegin = joined.findIndex(word => word.end >= window.start);
    for (let a = Math.max(0, leftBegin); a < joined.length; a++) {
      if (joined[a]!.start > seam + SPEECH_CHUNK_OVERLAP) break;
      for (let b = 0; b < next.length && next[b]!.start <= seam + SPEECH_CHUNK_OVERLAP; b++) {
        let length = 0;
        while (a + length < joined.length && b + length < next.length && token(joined[a + length]!) && token(joined[a + length]!) === token(next[b + length]!) && Math.abs(middle(joined[a + length]!) - middle(next[b + length]!)) < 1) length++;
        if (!length || (length === 1 && Math.abs(middle(joined[a]!) - middle(next[b]!)) > 0.35)) continue;
        const score = length * 10 - Math.abs(middle(joined[a]!) - seam) - Math.abs(middle(joined[a]!) - middle(next[b]!));
        if (!best || score > best.score) best = { left: a, right: b, length, score };
      }
    }
    if (best) joined = [...joined.slice(0, best.left + best.length), ...next.slice(best.right + best.length)];
    else joined = [...joined.filter(word => middle(word) < seam), ...next.filter(word => middle(word) >= seam)];
    joined.sort((a, b) => a.start - b.start);
    joined = joined.filter((word, index, all) => {
      const prior = all[index - 1];
      if (!prior || token(prior) !== token(word) || !token(word)) return true;
      const overlap = Math.min(prior.end, word.end) - Math.max(prior.start, word.start);
      return overlap <= Math.min(prior.end - prior.start, word.end - word.start) * 0.5;
    });
  }
  const words = joined.map(word => ({ ...word, start: Math.max(start, word.start), end: Math.min(end, word.end) })).filter(word => word.end > word.start);
  const segments: SpeechSegment[] = [];
  let current: SpeechWord[] = [];
  const flush = () => { if (current.length) segments.push({ text: current.map(word => word.text.trim()).join(' '), words: current }); current = []; };
  for (const word of words) {
    if (current.length && (word.start - current.at(-1)!.end > 0.8 || current.length >= 24 || word.end - current[0]!.start > 12)) flush();
    current.push(word);
    if (/[.!?。！？]["'”’]?\s*$/.test(word.text)) flush();
  }
  flush(); return segments;
}
