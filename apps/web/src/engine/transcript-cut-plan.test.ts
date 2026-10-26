import { describe, expect, it } from 'vitest';
import { planTranscriptCut } from './transcript-cut-plan';
import type { Passage } from './transcript-cut-plan';
import type { Asset } from '@diffusionstudio/assets';

const video = { id: 'video', type: 'VIDEO', path: 'Interviews/Portrait.mp4', duration: 100, width: 1080, height: 1920 } as Asset;
const audio = { id: 'audio', type: 'AUDIO', path: 'Interview.wav', duration: 100 } as Asset;
const resolve = (id: string) => [video, audio].find((asset) => asset.id === id);
const passage = (overrides: Partial<Passage> = {}): Passage => ({
	assetId: 'video', fingerprint: 'verified-hash', sourceIn: 10, sourceOut: 12,
	words: [{ text: 'Hello', start: 10.2, end: 11 }, { text: 'there.', start: 11, end: 11.8 }], ...overrides,
});

describe('transcript cut planning', () => {
	it('builds ordered, repeated source ranges without mutating sources or words', () => {
		const selected = [passage(), passage({ sourceIn: 1, sourceOut: 2, words: [{ text: 'Earlier.', start: 1.1, end: 1.9 }] }), passage()];
		const before = JSON.stringify({ video, selected });
		const cut = planTranscriptCut(selected, resolve, 30);
		expect(cut.duration).toBe(5);
		expect(cut.clips.map((clip) => clip.props.start)).toEqual([0, 2, 3]);
		expect(cut.clips.map((clip) => clip.props.sourceIn)).toEqual([10, 1, 10]);
		expect(cut.clips.every((clip) => clip.props.playbackRate === 1)).toBe(true);
		expect(cut.transcript[1]!.words[0]!.start).toBeCloseTo(2.1);
		expect(cut.transcript[2]!.words[0]!.start).toBeCloseTo(3.2);
		expect(JSON.stringify({ video, selected })).toBe(before);
	});

	it('fits a complete portrait video within a landscape target', () => {
		const cut = planTranscriptCut([passage()], resolve, 30, { width: 1920, height: 1080 });
		expect(cut.clips[0]!.props).toMatchObject({ width: 607.5, height: 1080, x: 656.25, y: 0 });
		expect(cut.clips[0]!.children[0]).toEqual({ tag: 'videoPaint', props: { src: video.path }, children: [] });
		expect(planTranscriptCut([passage()], resolve, 30)).toMatchObject({ width: 1080, height: 1920 });
	});

	it('supports audio-only and mixed passages without overlapping their audio', () => {
		const audioPassage = passage({ assetId: 'audio' });
		const audioCut = planTranscriptCut([audioPassage], resolve, 30);
		expect(audioCut).toMatchObject({ width: 1920, height: 1080 });
		expect(audioCut.clips[0]).toMatchObject({ tag: 'audio', props: { src: 'Interview.wav', sourceIn: 10, sourceOut: 12, start: 0 } });
		const mixed = planTranscriptCut([audioPassage, passage()], resolve, 30);
		expect(mixed).toMatchObject({ width: 1080, height: 1920, duration: 4 });
		expect(mixed.clips.map((clip) => clip.props.start)).toEqual([0, 2]);
	});

	it('accumulates actual rounded frames so fractional edits and captions stay gapless', () => {
		const chosen = passage({ sourceIn: 0.018, sourceOut: 0.104, words: [{ text: 'Yes', start: 0.018, end: 0.104 }] });
		const cut = planTranscriptCut(Array.from({ length: 100 }, () => chosen), resolve, 30);
		expect(cut.duration).toBe(200 / 30);
		for (const [i, clip] of cut.clips.entries()) {
			expect(clip.props).toMatchObject({ start: i * 2 / 30, sourceIn: 1 / 30, sourceOut: 3 / 30 });
			expect(cut.transcript[i]!.words[0]!.start).toBeCloseTo(i * 2 / 30);
			expect(cut.transcript[i]!.words[0]!.end).toBeCloseTo((i + 1) * 2 / 30);
		}
	});

	it('drops out-of-range words and clips retained caption boundaries', () => {
		const cut = planTranscriptCut([passage({ words: [
			{ text: 'Before', start: 1, end: 2 }, { text: 'Keep', start: 9.9, end: 10.2 },
			{ text: 'last', start: 11.8, end: 12.3 }, { text: 'After', start: 15, end: 16 },
		] })], resolve, 30);
		expect(cut.transcript[0]!.text).toBe('Keep last');
		expect(cut.transcript[0]!.words[0]!.start).toBe(0);
		expect(cut.transcript[0]!.words[1]!.end).toBe(2);
	});

	it.each([
		{ sourceIn: NaN }, { sourceIn: -1 }, { sourceOut: Infinity }, { sourceOut: 101 },
		{ sourceOut: 10 }, { assetId: 'missing' }, { fingerprint: '' }, { words: [] },
		{ sourceIn: 1, sourceOut: 1.001 }, { words: [{ text: 'Bad', start: 11, end: 10 }] },
	])('rejects invalid passages before writing: %j', (bad) => {
		expect(() => planTranscriptCut([passage(bad)], resolve, 30)).toThrow();
	});

	it('bounds counts, dimensions, and frame rates', () => {
		expect(() => planTranscriptCut([], resolve, 30)).toThrow();
		expect(() => planTranscriptCut(Array.from({ length: 101 }, () => passage()), resolve, 30)).toThrow();
		expect(() => planTranscriptCut([passage()], resolve, 0)).toThrow();
		expect(() => planTranscriptCut([passage()], resolve, 30, { width: 0 })).toThrow();
		expect(() => planTranscriptCut([passage()], resolve, 30, { height: 1.5 })).toThrow();
	});
});
