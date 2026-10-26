import { describe, expect, it } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import { planTranscriptEdit, subtractTimelineRanges, timelineWords, transcriptPassages, transcriptSuggestions } from './transcript-edit-plan';
import type { TranscriptEditLayer } from './transcript-edit-plan';

const node = (tag: string, props: Record<string, unknown> = {}, children: AuthoredTree[] = []): AuthoredTree => ({ tag, props, children });
const words = timelineWords([{ text: 'Hello um world. Next thought.', words: [
	{ text: 'Hello', start: 1, end: 2 }, { text: 'um', start: 2.3, end: 2.6 }, { text: 'world.', start: 3, end: 4 },
	{ text: 'Next', start: 6, end: 7 }, { text: 'thought.', start: 8, end: 9 },
] }], 10);
const layers = (): TranscriptEditLayer[] => [
	{ name: 'Picture', clips: [{ tree: node('video', { id: 'original-video', src: 'Interview.mp4', sourceIn: 4, sourceOut: 24, start: 0, end: 10, playbackRate: 2, volume: -3 }, [node('keyframeTrack', { property: 'x' }, [node('keyframe', { time: 10, value: -30 })])]), start: 0, end: 300, origin: -60, rate: 2 }] },
	{ name: 'Music', clips: [{ tree: node('audio', { id: 'music', src: 'Music.wav', start: 0, end: 10, volume: -18 }), start: 0, end: 300, origin: 0, rate: 1 }] },
	{ name: 'Title', clips: [{ tree: { ...node('text', { start: 2, end: 4, x: 100 }), text: 'A title' }, start: 60, end: 120, origin: 60, rate: 1 }] },
	{ caption: node('captions', { src: 'Old words.json', preset: 'whisper' }) },
];

describe('current timeline transcript edit planning', () => {
	it('removes the same time from video, music and graphics while respecting source trim and speed', () => {
		const plan = planTranscriptEdit(layers(), words, [{ start: 0, end: 2 }, { start: 3, end: 10 }], 10, 30);
		expect(plan.duration).toBe(9);
		const video = plan.children[0]!.children;
		expect(video[0]!.props).toMatchObject({ start: 0, end: 2, sourceIn: 4, playbackRate: 2, volume: -3 });
		expect(video[1]!.props).toMatchObject({ start: 2, end: 9, sourceIn: 10, playbackRate: 2 });
		expect(video[1]!.props.sourceOut).toBeUndefined();
		expect(video[1]!.children[0]!.children[0]!.props.time).toBe(10);
		expect(plan.children[1]!.children[1]!.props).toMatchObject({ start: 2, end: 9, sourceIn: 3, volume: -18 });
		expect(plan.children[2]!.props).toMatchObject({ start: 2, end: 3, sourceIn: 1 });
		expect(plan.transcript.flatMap((segment) => segment.words).map((word) => [word.text, word.start, word.end])).toEqual([
			['Hello', 1, 2], ['world.', 2, 3], ['Next', 5, 6], ['thought.', 7, 8],
		]);
		expect(plan.children[3]!.props).toMatchObject({ preset: 'whisper', sourceIn: 0, sourceOut: 9 });
	});

	it('reorders passages and their captions together on the current scene clock', () => {
		const plan = planTranscriptEdit(layers(), words, [{ start: 5, end: 10 }, { start: 0, end: 5 }], 10, 30);
		expect(plan.duration).toBe(10);
		expect(plan.children[0]!.children.map((clip) => [clip.props.start, clip.props.end, clip.props.sourceIn])).toEqual([[0, 5, 14], [5, 10, 4]]);
		expect(plan.transcript.flatMap((segment) => segment.words).map((word) => [word.text, word.start])).toEqual([['Next', 1], ['thought.', 3], ['Hello', 6], ['um', 7.3], ['world.', 8]]);
	});

	it('preserves original tree data and strips identities from every new piece', () => {
		const original = layers(), before = JSON.stringify(original);
		const plan = planTranscriptEdit(original, words, [{ start: 1, end: 9 }], 10, 30);
		expect(JSON.stringify(original)).toBe(before);
		expect(JSON.stringify(plan.children)).not.toContain('original-video');
	});

	it('keeps fractional source rates aligned on non-30fps project frames', () => {
		const plan = planTranscriptEdit([{ clips: [{ tree: node('video', { src: 'Slow.mov' }), start: 0, end: 240, origin: -48, rate: 0.5 }] }], words, [{ start: 2, end: 6 }], 10, 24);
		expect(plan.children[0]!.props).toMatchObject({ start: 0, end: 4, sourceIn: 2, playbackRate: 0.5 });
		expect(plan.children[plan.captionIndex]!.props.sourceOut).toBe(4);
	});

	it('retains a chosen leading gap rather than shifting the first clip prematurely', () => {
		const plan = planTranscriptEdit([{ clips: [{ tree: node('video', { src: 'Late.mov' }), start: 120, end: 300, origin: 120, rate: 1 }] }], words, [{ start: 2, end: 10 }], 10, 30);
		expect(plan.duration).toBe(8);
		expect(plan.children[0]!.props).toMatchObject({ start: 2, end: 8, sourceIn: 0 });
	});

	it.each([
		[[{ start: 0, end: 6 }, { start: 4, end: 9 }], 'overlap'],
		[[{ start: 0, end: 10 }], 'Choose words'],
		[[{ start: -1, end: 4 }], 'outside'],
		[[{ start: 0, end: 12 }], 'outside'],
		[[{ start: 0, end: 0.001 }], 'shorter'],
	] as const)('rejects unsafe or empty selection %j', (ranges, message) => {
		expect(() => planTranscriptEdit(layers(), words, ranges, 10, 30)).toThrow(message);
	});

	it('subtracts overlapping removals without duplicating time and keeps passage order', () => {
		expect(subtractTimelineRanges([{ start: 5, end: 10 }, { start: 0, end: 5 }], [{ start: 1, end: 3 }, { start: 2, end: 4 }, { start: 7, end: 8 }])).toEqual([{ start: 5, end: 7 }, { start: 8, end: 10 }, { start: 0, end: 1 }, { start: 4, end: 5 }]);
	});

	it('partitions complete sentences without dropping original pauses or the intro/outro', () => {
		const passages = transcriptPassages(words, 10);
		expect(passages).toHaveLength(3);
		expect(passages.map(({ start, end }) => [start, end])).toEqual([[0, 5], [5, 7.5], [7.5, 10]]);
		expect(passages[0]!.wordIds).toEqual(['word-0', 'word-1', 'word-2']);
	});

	it('suggests conservative fillers and only measured silence outside recognized words', () => {
		const suggestions = transcriptSuggestions(words, 10, [{ start: 1.5, end: 6.5 }]);
		expect(suggestions.find((item) => item.kind === 'filler')).toMatchObject({ text: 'um', start: 2.3, end: 2.6 });
		const silence = suggestions.filter((item) => item.kind === 'silence');
		expect(silence).toHaveLength(1);
		expect(silence[0]!.start).toBeCloseTo(4.12);
		expect(silence[0]!.end).toBeCloseTo(5.88);
		expect(transcriptSuggestions(words, 10, []).some((item) => item.kind === 'silence')).toBe(false);
	});
});
