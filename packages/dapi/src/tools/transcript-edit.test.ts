import { describe, expect, it } from 'vitest';
import { transcriptEditApply, transcriptEditInspect } from './transcript-edit';

describe('timeline transcript tool contracts', () => {
	it('defaults inspection to current captions and bounded pagination', () => {
		expect(transcriptEditInspect.input.parse({ id: 'index.tsx:scene' })).toEqual({ id: 'index.tsx:scene', refreshTranscript: false, wordOffset: 0, wordLimit: 2000, retakes: false });
		expect(transcriptEditInspect.input.safeParse({ id: 'scene', wordLimit: 5001 }).success).toBe(false);
	});
	it('fills pause defaults and bounds the tight-cut, filler and retake settings', () => {
		expect(transcriptEditInspect.input.parse({ id: 'scene', pauses: {} }).pauses).toEqual({ minSeconds: 0.5, keepSeconds: 0.12, frameQuantize: true });
		expect(transcriptEditInspect.input.parse({ id: 'scene', pauses: { minSeconds: 0.12, keepSeconds: 0, thresholdDb: -32 }, fillers: ['like'], retakes: true })).toMatchObject({ pauses: { minSeconds: 0.12, keepSeconds: 0, thresholdDb: -32, frameQuantize: true }, fillers: ['like'], retakes: true });
		for (const pauses of [{ minSeconds: 0.05 }, { minSeconds: 4 }, { keepSeconds: 0.5 }, { thresholdDb: -80 }, { thresholdDb: -10 }]) expect(transcriptEditInspect.input.safeParse({ id: 'scene', pauses }).success, JSON.stringify(pauses)).toBe(false);
		expect(transcriptEditInspect.input.safeParse({ id: 'scene', fillers: Array.from({ length: 31 }, (_, i) => `f${i}`) }).success).toBe(false);
	});
	it('describes retake suggestions with their proposed alternative and similarity', () => {
		const base = { revision: 'a'.repeat(64), sceneId: 's', sceneName: 'S', duration: 10, frameRate: 30, transcriptSource: 'captions', words: [], passages: [], warnings: [], totalWords: 1, wordOffset: 0, nextWordOffset: null, pauseDetection: null };
		const retake = { id: 'retake-word-0', kind: 'retake', text: 'So the main', start: 0, end: 1, alternative: { start: 2, end: 4, text: 'So the main reason is cost.' }, similarity: 0.9, note: 'Earlier attempt.' };
		expect(transcriptEditInspect.output.safeParse({ ...base, suggestions: [retake] }).success).toBe(true);
		expect(transcriptEditInspect.output.safeParse({ ...base, suggestions: [{ ...retake, similarity: 1.5 }] }).success).toBe(false);
	});
	it('requires a trusted revision and valid retained scene ranges', () => {
		expect(transcriptEditApply.input.safeParse({ id: 'scene', revision: 'a'.repeat(64), ranges: [{ start: 6, end: 10 }, { start: 0, end: 3 }] }).success).toBe(true);
		expect(transcriptEditApply.input.safeParse({ id: 'scene', revision: 'old', ranges: [{ start: 0, end: 3 }] }).success).toBe(false);
		expect(transcriptEditApply.input.safeParse({ id: 'scene', revision: 'a'.repeat(64), ranges: [{ start: 3, end: 2 }] }).success).toBe(false);
		expect(transcriptEditApply.annotations?.destructiveHint).toBe(true);
	});
});
