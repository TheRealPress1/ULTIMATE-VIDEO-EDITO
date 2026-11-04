import { describe, expect, it } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import { planTranscriptEdit, resolveSuggestionOptions, retakeSentences, subtractTimelineRanges, timelineWords, transcriptPassages, transcriptRetakes, transcriptSuggestions } from './transcript-edit-plan';
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

/** Words laid out from `[text, start, end]` rows, one segment. */
const spoken = (rows: Array<[string, number, number]>, duration = 60) => timelineWords([{ text: rows.map(([text]) => text).join(' '), words: rows.map(([text, start, end]) => ({ text, start, end })) }], duration);
/** A sentence's words spaced 0.3 s apart from `at`, each 0.25 s long. */
const line = (text: string, at: number): Array<[string, number, number]> => text.split(' ').map((word, i) => [word, at + i * 0.3, at + i * 0.3 + 0.25]);

describe('transcript suggestion settings', () => {
	it('resolves defaults, canonicalizes fillers and refuses values outside the tool ranges', () => {
		expect(resolveSuggestionOptions()).toEqual({ pauses: { minSeconds: 0.5, keepSeconds: 0.12, thresholdDb: null, frameQuantize: true }, fillers: ['erm', 'hmm', 'uh', 'uhm', 'um'], retakes: false });
		expect(resolveSuggestionOptions({ fillers: ['Like', 'like', 'you-know'], pauses: { minSeconds: 0.12, keepSeconds: 0 } })).toMatchObject({ fillers: ['like', 'youknow'], pauses: { minSeconds: 0.12, keepSeconds: 0, frameQuantize: true } });
		expect(JSON.stringify(resolveSuggestionOptions({ fillers: ['uh', 'um'] }))).toBe(JSON.stringify(resolveSuggestionOptions({ fillers: ['um', 'uh'] })));
		expect(() => resolveSuggestionOptions({ pauses: { minSeconds: 0.01 } })).toThrow('minSeconds');
		expect(() => resolveSuggestionOptions({ pauses: { thresholdDb: -10 } })).toThrow('thresholdDb');
	});

	it('replaces the default filler list, and an empty list turns fillers off', () => {
		const words = spoken([['So', 1, 1.2], ['like,', 1.3, 1.5], ['um', 1.6, 1.8], ['this', 1.9, 2.1], ['works.', 2.2, 2.5]], 3);
		const custom = transcriptSuggestions(words, 3, [], resolveSuggestionOptions({ fillers: ['like'] }));
		expect(custom.map((item) => [item.kind, item.text])).toEqual([['filler', 'like,']]);
		expect(transcriptSuggestions(words, 3, [], resolveSuggestionOptions({ fillers: [] }))).toEqual([]);
		expect(transcriptSuggestions(words, 3, []).map((item) => item.text)).toEqual(['um']);
	});

	it('cuts tight pauses to the speech edge on whole project frames', () => {
		const words = spoken([['Fast', 0.5, 0.9], ['cut.', 1.07, 1.6], ['Next', 1.95, 2.4]], 3);
		const tight = resolveSuggestionOptions({ pauses: { minSeconds: 0.12, keepSeconds: 0 } });
		const silences = transcriptSuggestions(words, 3, [{ start: 0.91, end: 1.07 }, { start: 1.6, end: 1.95 }, { start: 2.4, end: 3 }], tight, 30).filter((item) => item.kind === 'silence');
		// Starts round up and ends round down: 0.91-1.07 s keeps only frames 28-32.
		expect(silences.map(({ start, end }) => [start * 30, end * 30].map((frame) => Math.round(frame * 1e6) / 1e6))).toEqual([[28, 32], [48, 58], [72, 90]]);
		// The conservative default leaves the same short pauses alone.
		expect(transcriptSuggestions(words, 3, [{ start: 0.91, end: 1.07 }, { start: 1.6, end: 1.95 }], undefined, 30).filter((item) => item.kind === 'silence')).toEqual([]);
		// Without rounding the edges stay where they were measured.
		const raw = transcriptSuggestions(words, 3, [{ start: 0.9, end: 1.07 }], resolveSuggestionOptions({ pauses: { minSeconds: 0.12, keepSeconds: 0, frameQuantize: false } }), 30);
		expect(raw[0]).toMatchObject({ kind: 'silence', start: 0.9, end: 1.07 });
	});

	it('never proposes a removal shorter than minSeconds, or 0.35 s when minSeconds is longer', () => {
		// The detector trims kept breath from each end, so a quiet stretch arrives 2 × keepSeconds shorter.
		const pause = (before: number, after: number) => spoken([['One', 0.2, before], ['two.', after, after + 0.4]], 3);
		const silencesOf = (words: ReturnType<typeof spoken>, silence: { start: number; end: number }, options = resolveSuggestionOptions()) =>
			transcriptSuggestions(words, 3, [silence], options, 30).filter((item) => item.kind === 'silence').map(({ start, end }) => [start, end].map((t) => Math.round(t * 30)));
		// Defaults: a 0.54 s pause leaves 0.30 s to remove, under the 0.35 s the dialog has always required.
		expect(silencesOf(pause(1, 1.54), { start: 1.12, end: 1.42 })).toEqual([]);
		expect(silencesOf(pause(1, 1.7), { start: 1.12, end: 1.58 })).toEqual([[34, 47]]);
		// A short search with breath kept either side does not offer frame-sized cuts.
		const breathing = resolveSuggestionOptions({ pauses: { minSeconds: 0.2, keepSeconds: 0.12 } });
		expect(silencesOf(pause(1, 1.31), { start: 1.12, end: 1.19 }, breathing)).toEqual([]);
		expect(silencesOf(pause(1, 1.5), { start: 1.12, end: 1.38 }, breathing)).toEqual([[34, 41]]);
		// A tight search keeps no breath, so its minimum is the cut itself.
		const tight = resolveSuggestionOptions({ pauses: { minSeconds: 0.12, keepSeconds: 0 } });
		expect(silencesOf(pause(1, 1.14), { start: 1, end: 1.14 }, tight)).toEqual([[30, 34]]);
	});
});

describe('retake suggestions', () => {
	it('stay off unless asked for', () => {
		const words = spoken([...line('So the main-', 0), ...line('So the main reason is cost.', 2)]);
		expect(transcriptSuggestions(words, 60, []).some((item) => item.kind === 'retake')).toBe(false);
		expect(transcriptSuggestions(words, 60, [], resolveSuggestionOptions({ retakes: true })).filter((item) => item.kind === 'retake')).toHaveLength(1);
	});

	it('flags a restarted sentence and proposes the complete take', () => {
		const words = spoken([...line('Um so the main', 0), ...line('so the main reason we switched is cost.', 2)]);
		expect(retakeSentences(words).map((sentence) => sentence.ending)).toEqual(['abandoned', 'complete']);
		const [retake, ...rest] = transcriptRetakes(words);
		expect(rest).toEqual([]);
		expect(retake).toMatchObject({ kind: 'retake', id: 'retake-word-0', start: 0, text: 'Um so the main', alternative: { start: 2, text: 'so the main reason we switched is cost.' } });
		expect(retake!.end).toBeCloseTo(1.15);
		expect(retake!.similarity).toBeGreaterThanOrEqual(0.9);
	});

	it('finds a reworded retake that shares a phrase and half its words', () => {
		const words = spoken([...line('The main reason we did this is cost.', 0), ...line('Okay.', 4), ...line('The main reason we built this was the cost.', 6)]);
		const retakes = transcriptRetakes(words);
		expect(retakes).toHaveLength(1);
		expect(retakes[0]).toMatchObject({ text: 'The main reason we did this is cost.', alternative: { text: 'The main reason we built this was the cost.' } });
		expect(retakes[0]!.similarity).toBeGreaterThan(0.6);
		expect(retakes[0]!.similarity).toBeLessThan(0.8);
		expect(retakes[0]!.note).toMatch(/earlier one can be the better read/);
	});

	it('splits a restart said without a pause', () => {
		const words = spoken(line('I think I think we should ship it today.', 0));
		expect(retakeSentences(words).map((sentence) => sentence.text)).toEqual(['I think', 'I think we should ship it today.']);
		expect(transcriptRetakes(words)[0]).toMatchObject({ text: 'I think', alternative: { text: 'I think we should ship it today.' } });
	});

	it('leaves deliberate parallel phrasing alone', () => {
		const anaphora = spoken([...line('We will fight on the beaches.', 0), ...line('We will fight on the landing grounds.', 3), ...line('We will fight in the fields.', 6)]);
		expect(transcriptRetakes(anaphora)).toEqual([]);
		const inline = spoken(line('We will fight on the beaches, we will fight on the landing grounds.', 0));
		expect(transcriptRetakes(inline)).toEqual([]);
		const emphasis = spoken([...line('It works.', 0), ...line('It really works.', 1.5)]);
		expect(transcriptRetakes(emphasis)).toEqual([]);
	});

	it('does not offer a complete sentence that repeats its own opening as a restart', () => {
		for (const text of ['It is what it is.', 'We need to do what we need to do.', 'I said what I said.', 'It is what it is, and we move on.']) {
			expect(transcriptRetakes(spoken(line(text, 0)))).toEqual([]);
		}
		// A real restart without a pause is still found: the second try goes further.
		expect(transcriptRetakes(spoken(line('We were, we were really surprised.', 0)))).toMatchObject([{ text: 'We were,', alternative: { text: 'we were really surprised.' } }]);
	});

	it('reads past a leading conjunction when comparing how two lines open', () => {
		const parallel = spoken([...line('We will fight on the beaches.', 0), ...line('And we will fight on the landing grounds.', 3)]);
		expect(transcriptRetakes(parallel)).toEqual([]);
		const claims = spoken([...line('The best way to learn is by doing.', 0), ...line('And the best way to learn is by teaching others too.', 4)]);
		expect(transcriptRetakes(claims)).toEqual([]);
		const restart = spoken([...line('And so the main', 0), ...line('So the main reason we switched is cost.', 2)]);
		expect(transcriptRetakes(restart)).toMatchObject([{ text: 'And so the main', alternative: { text: 'So the main reason we switched is cost.' } }]);
	});

	it('does not propose dropping a sentence whose opening the pickup never says', () => {
		const pickup = spoken([...line('We launched in March and it sold out in a day.', 0), ...line('It sold out in a day.', 5)]);
		expect(transcriptRetakes(pickup)).toEqual([]);
		// The fuller later line still replaces the shorter earlier one.
		const fuller = spoken([...line('It sold out in a day.', 0), ...line('We launched in March and it sold out in a day.', 3)]);
		expect(transcriptRetakes(fuller)).toMatchObject([{ text: 'It sold out in a day.', alternative: { text: 'We launched in March and it sold out in a day.' } }]);
	});

	it('keeps the last complete take of several and flags an unfinished one after it', () => {
		const words = spoken([
			...line('Our first launch was in March', 0),
			...line('Our first launch was in March, in Berlin.', 3),
			...line('Our first launch was in March in Berlin and it sold out.', 7),
			...line('Our first launch was', 12),
		]);
		const retakes = transcriptRetakes(words);
		expect(retakes.map((item) => item.text)).toEqual(['Our first launch was in March', 'Our first launch was in March, in Berlin.', 'Our first launch was']);
		for (const item of retakes) expect(item.alternative?.text).toBe('Our first launch was in March in Berlin and it sold out.');
		expect(retakes[2]!.note).toMatch(/Unfinished later attempt/);
	});

	it('handles an hour of the same line said over and over without deep recursion', () => {
		const rows: Array<[string, number, number]> = [];
		for (let at = 0; at < 3590; at += 2) rows.push(...line('We ship every Friday at noon.', at));
		const retakes = transcriptRetakes(spoken(rows, 3600));
		expect(retakes).toHaveLength(1794);
		expect(retakes.every((item) => item.alternative?.start === 3588)).toBe(true);
	});

	it('ignores repeats further apart than the retake window', () => {
		const words = spoken([...line('The main reason we did this is cost.', 0), ...line('The main reason we did this is cost.', 40)]);
		expect(transcriptRetakes(words)).toEqual([]);
	});
});
