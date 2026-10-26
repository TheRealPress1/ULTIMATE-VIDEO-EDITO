import { describe, expect, it } from 'vitest';
import { mergeSpeechChunks, speechChunks, SPEECH_CHUNK_MAX_SECONDS } from './speech-chunks';
import type { SpeechSegment } from './speech-types';
const segment = (...words: [string, number, number][]): SpeechSegment[] => [{ text: words.map(([text]) => text).join(' '), words: words.map(([text,start,end]) => ({text,start,end})) }];
describe('bounded speech section planning', () => {
  it('covers a 90-minute source continuously with bounded overlapping windows', () => {
    const plan = speechChunks(5400);
    expect(plan).toHaveLength(18); expect(plan[0]!.start).toBe(0); expect(plan.at(-1)!.end).toBe(5400);
    for (let i=0;i<plan.length;i++) { const chunk=plan[i]!; expect(chunk.end-chunk.start).toBeLessThanOrEqual(SPEECH_CHUNK_MAX_SECONDS); if(i) expect(chunk.coreStart).toBe(plan[i-1]!.coreEnd); }
  });
  it('supports bounded two-minute scene mixes without changing ownership or clock', () => {
    expect(speechChunks(7200,0,7200,120)).toHaveLength(60);
    expect(speechChunks(7200,500,900,120)[0]).toMatchObject({start:500,coreStart:500,coreEnd:620,end:622});
  });
});
describe('overlap transcript reconciliation', () => {
  it('retains recognized boundary speech when the following section contains no recognized words', () => {
    const windows=speechChunks(600);
    const result=mergeSpeechChunks([{window:windows[0]!,segments:segment(['boundary',299.9,300.4])},{window:windows[1]!,segments:[]}]);
    expect(result.flatMap(s=>s.words.map(w=>w.text))).toEqual(['boundary']);
  });
  it('keeps a word whose two recognition times straddle the ownership boundary', () => {
    const windows=speechChunks(600);
    const result=mergeSpeechChunks([{window:windows[0]!,segments:segment(['before',299,299.4],['boundary',299.9,300.4],['after',300.5,301])},{window:windows[1]!,segments:segment(['before',299.05,299.45],['boundary',299.65,300.05],['after',300.45,300.95],['next',302,302.5])}],0,600);
    expect(result.flatMap(s=>s.words.map(w=>w.text))).toEqual(['before','boundary','after','next']);
  });
  it('retains actually repeated words and does not fill silent gaps with invented text', () => {
    const windows=speechChunks(600);
    const result=mergeSpeechChunks([{window:windows[0]!,segments:segment(['very',299,299.2],['very',299.3,299.5],['good',299.7,300])},{window:windows[1]!,segments:segment(['very',299.32,299.52],['good',299.72,300.02],['later',305,305.4])}]);
    expect(result.flatMap(s=>s.words.map(w=>w.text))).toEqual(['very','very','good','later']);
  });
  it('uses chronological ownership when no shared recognition anchor exists', () => {
    const windows=speechChunks(600);
    const result=mergeSpeechChunks([{window:windows[0]!,segments:segment(['left',299,299.5],['discard',300.7,301])},{window:windows[1]!,segments:segment(['context',299,299.5],['right',300.6,301])}]);
    expect(result.flatMap(s=>s.words.map(w=>w.text))).toEqual(['left','right']);
  });
});
