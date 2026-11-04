/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { alignScriptRead, cardinalWords, EXTRA_SPEECH_MAX, normalizeSpeech, type ScriptLine, type SpokenWord } from './script-align';

const WORD = 0.3, GAP = 0.08;

/**
 * Synthetic word timings: strings are spoken (one 0.3 s word per space-
 * separated token, 0.08 s apart), numbers are silences in seconds.
 */
function speak(parts: Array<string | number>, start = 0): SpokenWord[] {
	const words: SpokenWord[] = [];
	let at = start;
	for (const part of parts) {
		if (typeof part === 'number') { at += part; continue; }
		for (const text of part.split(/\s+/).filter(Boolean)) {
			words.push({ text, start: Math.round(at * 1000) / 1000, end: Math.round((at + WORD) * 1000) / 1000 });
			at += WORD + GAP;
		}
	}
	return words;
}

const script = (...texts: string[]): ScriptLine[] => texts.map((text, index) => ({ n: index + 1, text }));

const LINES = script(
	'Most people buy a new camera when their videos look flat.',
	"The camera isn't the problem.",
	'Light is.',
	'Put one lamp beside the window and film again tonight.',
);

describe('spoken-word normalization', () => {
	it('lowercases, strips punctuation and expands contractions', () => {
		expect(normalizeSpeech("Don’t you think it's done? I'm sure we'll go, they've left.")).toEqual(['do', 'not', 'you', 'think', 'it', 'is', 'done', 'i', 'am', 'sure', 'we', 'will', 'go', 'they', 'have', 'left']);
		expect(normalizeSpeech("Can't, won't, let's, gonna, cannot")).toEqual(['can', 'not', 'will', 'not', 'let', 'us', 'going', 'to', 'can', 'not']);
		expect(normalizeSpeech("Maya's edit")).toEqual(['maya', 'edit']);
		expect(normalizeSpeech('HELLO,   World!!')).toEqual(['hello', 'world']);
	});

	it('spells numerals the way they are said', () => {
		expect(normalizeSpeech('1,000')).toEqual(normalizeSpeech('one thousand'));
		expect(normalizeSpeech('a thousand')).toEqual(['one', 'thousand']);
		expect(normalizeSpeech('one hundred and twenty')).toEqual(normalizeSpeech('120'));
		expect(normalizeSpeech('$20 and 50%')).toEqual(['twenty', 'dollars', 'and', 'fifty', 'percent']);
		expect(normalizeSpeech('$1')).toEqual(['one', 'dollar']);
		expect(normalizeSpeech('3rd, 21st, 12th')).toEqual(['third', 'twenty', 'first', 'twelfth']);
		expect(normalizeSpeech('the 1990s')).toEqual(['the', 'nineteen', 'nineties']);
		expect(normalizeSpeech('1905 and 2024')).toEqual(['nineteen', 'oh', 'five', 'and', 'twenty', 'twenty', 'four']);
		expect(normalizeSpeech('2005')).toEqual(normalizeSpeech('two thousand and five'));
		expect(normalizeSpeech('3.5')).toEqual(['three', 'point', 'five']);
		expect(normalizeSpeech('twenty-five')).toEqual(normalizeSpeech('25'));
		expect(normalizeSpeech('007')).toEqual(['zero', 'zero', 'seven']);
	});

	it('reads a currency amount with its scale, scale letters and teen hundreds the way they are said', () => {
		expect(normalizeSpeech('$5 million')).toEqual(normalizeSpeech('five million dollars'));
		expect(normalizeSpeech('$1 billion')).toEqual(['one', 'billion', 'dollars']);
		expect(normalizeSpeech('€2.5M')).toEqual(['two', 'point', 'five', 'million', 'euros']);
		expect(normalizeSpeech('10k subscribers')).toEqual(normalizeSpeech('10,000 subscribers'));
		expect(normalizeSpeech('1.5K')).toEqual(['one', 'point', 'five', 'thousand']);
		expect(normalizeSpeech('1M views')).toEqual(normalizeSpeech('one million views'));
		expect(normalizeSpeech('2bn')).toEqual(['two', 'billion']);
		expect(normalizeSpeech('1500 people')).toEqual(normalizeSpeech('1,500 people'));
		expect(normalizeSpeech('fifteen hundred people')).toEqual(normalizeSpeech('1,500 people'));
		expect(normalizeSpeech('twelve hundred and fifty')).toEqual(normalizeSpeech('1,250'));
		// Years keep their reading, and letters that are not scales stay words.
		expect(normalizeSpeech('in 1984')).toEqual(['in', 'nineteen', 'eighty', 'four']);
		expect(normalizeSpeech('the 1900s')).toEqual(['the', 'nineteen', 'hundreds']);
		expect(normalizeSpeech('plan b, vitamin k')).toEqual(['plan', 'b', 'vitamin', 'k']);
	});

	it('treats words that name Object.prototype members as plain words', () => {
		expect(normalizeSpeech('The constructor said hasownproperty')).toEqual(['the', 'constructor', 'said', 'hasownproperty']);
		expect(alignScriptRead(script('Ask the constructor.'), speak(['ask the constructor'])).lines[0]!.takes[0]!.coverage).toBe(1);
	});

	it('drops stage directions and unanswered placeholders', () => {
		expect(normalizeSpeech('[beat] Go ⟦ask: how many⟧ now {smile}')).toEqual(['go', 'now']);
	});

	it('writes large integers without "and"', () => {
		expect(cardinalWords(0)).toEqual(['zero']);
		expect(cardinalWords(1_205_017)).toEqual(['one', 'million', 'two', 'hundred', 'five', 'thousand', 'seventeen']);
		expect(cardinalWords(-1)).toEqual([]);
	});
});

describe('aligning a read to its script', () => {
	it('finds every line of a clean read in order, with exact coverage', () => {
		const words = speak([LINES[0]!.text, 0.7, LINES[1]!.text, 0.7, LINES[2]!.text, 0.7, LINES[3]!.text]);
		const report = alignScriptRead(LINES, words);
		expect(report.lines.map((line) => [line.n, line.takes.length, line.best, line.takes[0]?.coverage])).toEqual([[1, 1, 0, 1], [2, 1, 0, 1], [3, 1, 0, 1], [4, 1, 0, 1]]);
		expect(report.unspoken).toEqual([]);
		expect(report.readOrder).toEqual([1, 2, 3, 4]);
		expect(report.extraSpeech).toEqual([]);
		expect(report.coverage).toBe(1);
		const second = report.lines[1]!.takes[0]!;
		expect(second).toMatchObject({ omitted: [], inserted: [], substituted: [], pauses: [], fillers: 0, spoken: "The camera isn't the problem." });
		// Separate ranges: 0.7 s between lines is longer than the 0.6 s pause.
		expect(report.keep.map((range) => range.lines)).toEqual([[1], [2], [3], [4]]);
	});

	it('merges lines read back to back into one keep range', () => {
		const words = speak([LINES[0]!.text, 0.2, LINES[1]!.text, 0.2, LINES[2]!.text]);
		const report = alignScriptRead(LINES.slice(0, 3), words);
		expect(report.keep).toHaveLength(1);
		expect(report.keep[0]).toMatchObject({ lines: [1, 2, 3] });
		expect(report.keep[0]!.start).toBe(0);
		expect(report.keep[0]!.end).toBeCloseTo(words[words.length - 1]!.end + 0.12, 3);
	});

	it('reports each take of a line read three times and suggests the complete one', () => {
		const words = speak([
			LINES[0]!.text, 1,
			'The camera is not a problem.', 1, // take 1: one word changed
			'The camera', 0.8, // a false start
			"the camera isn't the problem.", 1, // take 3: clean
			LINES[2]!.text,
		]);
		const report = alignScriptRead(LINES.slice(0, 3), words);
		const line = report.lines[1]!;
		expect(line.takes).toHaveLength(2);
		expect(line.takes[0]).toMatchObject({ coverage: 0.833, substituted: [{ written: 'the', spoken: 'a' }] });
		expect(line.takes[1]).toMatchObject({ coverage: 1, substituted: [] });
		expect(line.best).toBe(1);
		expect(line.takes[0]!.sourceStart).toBeLessThan(line.takes[1]!.sourceStart);
		// The abandoned start is not a take; it is speech between takes.
		expect(report.extraSpeech).toEqual([expect.objectContaining({ text: 'The camera', words: 2 })]);
		expect(report.keep.find((range) => range.lines.includes(2))!.start).toBeCloseTo(line.takes[1]!.keep.sourceIn, 6);
	});

	it('does not let the last take win by default when an earlier one is better', () => {
		const words = speak(["The camera isn't the problem.", 1, 'The camera honestly is not the problem.']);
		const report = alignScriptRead([LINES[1]!], words);
		const line = report.lines[0]!;
		expect(line.takes).toHaveLength(2);
		expect(line.takes[1]!.inserted).toEqual(['honestly']);
		expect(line.best).toBe(0);
	});

	it('prefers the later of two equally clean takes', () => {
		const words = speak(["The camera isn't the problem.", 1, "The camera isn't the problem."]);
		expect(alignScriptRead([LINES[1]!], words).lines[0]!.best).toBe(1);
	});

	it('finds lines read out of order and reports the order they were read in', () => {
		const words = speak([LINES[0]!.text, 0.7, LINES[2]!.text, 0.7, LINES[1]!.text, 0.7, LINES[3]!.text]);
		const report = alignScriptRead(LINES, words);
		expect(report.lines.every((line) => line.best !== null && line.takes[line.best]!.coverage === 1)).toBe(true);
		expect(report.readOrder).toEqual([1, 3, 2, 4]);
		// Keep ranges stay in script order for an assembly.
		expect(report.keep.flatMap((range) => range.lines)).toEqual([1, 2, 3, 4]);
		const [, second, third] = report.keep;
		expect(second!.start).toBeGreaterThan(third!.start);
	});

	it('lists a skipped line as unspoken and leaves it out of the keep list', () => {
		const words = speak([LINES[0]!.text, 0.7, LINES[1]!.text, 0.7, LINES[3]!.text]);
		const report = alignScriptRead(LINES, words);
		expect(report.unspoken).toEqual([3]);
		expect(report.lines[2]).toMatchObject({ takes: [], best: null });
		expect(report.keep.flatMap((range) => range.lines)).toEqual([1, 2, 4]);
		expect(report.coverage).toBe(0.75);
	});

	it('keeps an ad-lib inside a line as inserted words and one between lines as extra speech', () => {
		const lines = script('We spent three months on this edit.', 'Then we shipped it.');
		const words = speak(['We spent, honestly I couldn\'t believe it, three months on this edit.', 1.2, 'Okay hang on, let me grab water.', 1.2, 'Then we shipped it.']);
		const report = alignScriptRead(lines, words);
		const first = report.lines[0]!.takes[0]!;
		expect(first.coverage).toBe(1);
		expect(first.inserted).toEqual(['honestly i could not believe it']);
		expect(report.lines[1]!.takes[0]!.coverage).toBe(1);
		expect(report.extraSpeech).toEqual([expect.objectContaining({ text: 'Okay hang on, let me grab water.', words: 7 })]);
		expect(report.extraSpeechTotal).toBe(1);
	});

	it('matches numerals against spoken numbers, even when the recognizer splits them', () => {
		const lines = script('We grew to 1,000 subscribers in 3 weeks.', 'We made one thousand dollars in twenty twenty-four.');
		const words = [
			...speak(['we grew to one thousand subscribers in three weeks.']),
			...['We', 'made', '$', '1', ',000', 'in', '2024.'].map((text, index) => ({ text, start: 10 + index * 0.4, end: 10 + index * 0.4 + 0.3 })),
		];
		const report = alignScriptRead(lines, words);
		for (const line of report.lines) expect(line.takes[0]).toMatchObject({ coverage: 1, omitted: [], inserted: [], substituted: [] });
		// "$5" and "million" as two recognized words still read five million dollars.
		const split = ['We', 'raised', '$5', 'million.'].map((text, index) => ({ text, start: index * 0.4, end: index * 0.4 + 0.3 }));
		expect(alignScriptRead(script('We raised five million dollars.'), split).lines[0]!.takes[0]).toMatchObject({ coverage: 1, substituted: [], spoken: 'We raised $5 million.' });
	});

	it('reports changed and missing words', () => {
		const lines = script('Grab the large bag from the hall closet.');
		const report = alignScriptRead(lines, speak(['Grab the big bag from the closet.']));
		const take = report.lines[0]!.takes[0]!;
		expect(take.substituted).toEqual([{ written: 'large', spoken: 'big' }]);
		expect(take.omitted).toEqual(['hall']);
		expect(take.coverage).toBe(0.75);
	});

	it('pairs a misheard first word with the script instead of cutting it off', () => {
		const lines = script('Hey everyone, welcome back to the studio.');
		const words = speak(['Hi everyone, welcome back to the studio.'], 2);
		const take = alignScriptRead(lines, words).lines[0]!.takes[0]!;
		expect(take.sourceStart).toBe(2);
		expect(take.substituted).toEqual([{ written: 'hey', spoken: 'hi' }]);
		expect(take.spoken).toBe('Hi everyone, welcome back to the studio.');
	});

	it('leaves slate talk and a word that sounds nothing alike outside the take', () => {
		const lines = script('So keep it on a stand next to the kettle.');
		const slate = alignScriptRead(lines, speak(['okay rolling', 0.1, 'keep it on a stand next to the kettle.']));
		const take = slate.lines[0]!.takes[0]!;
		expect(take).toMatchObject({ spoken: 'keep it on a stand next to the kettle.', omitted: ['so'], substituted: [] });
		expect(slate.keep[0]!.start).toBeGreaterThanOrEqual(speak(['okay rolling'])[1]!.end);
		expect(slate.extraSpeech).toEqual([expect.objectContaining({ text: 'okay rolling' })]);
		// A false start broken off with "wait": its missing words stay omitted.
		const restart = alignScriptRead(script('Keep it on a stand next to the kettle.'), speak(['Keep it on a stand', 0.3, 'wait', 0.3, 'keep it on a stand next to the kettle.']));
		const [falseStart, clean] = restart.lines[0]!.takes;
		expect(falseStart).toMatchObject({ spoken: 'Keep it on a stand', omitted: ['next to the kettle'], substituted: [] });
		expect(clean).toMatchObject({ coverage: 1 });
		expect(restart.lines[0]!.best).toBe(1);
		expect(restart.extraSpeech).toEqual([expect.objectContaining({ text: 'wait' })]);
	});

	it('keeps a misheard edge word apart from the omitted words beside it', () => {
		const take = alignScriptRead(script('Well hey everyone, welcome back to the studio.'), speak(['hi everyone, welcome back to the studio.'])).lines[0]!.takes[0]!;
		expect(take.substituted).toEqual([{ written: 'hey', spoken: 'hi' }]);
		expect(take.omitted).toEqual(['well']);
	});

	it('measures pauses, fillers and pace inside a take', () => {
		const lines = script('This one lamp changed every shot I filmed this year.');
		const words = speak(['This one lamp', 1.1, 'um changed every shot I filmed this year.']);
		const take = alignScriptRead(lines, words, { pauseSeconds: 0.6 }).lines[0]!.takes[0]!;
		expect(take.coverage).toBe(1);
		expect(take.fillers).toBe(1);
		expect(take.inserted).toEqual([]);
		expect(take.pauses).toEqual([{ start: words[2]!.end, end: words[3]!.start }]);
		const seconds = words[words.length - 1]!.end - words[0]!.start;
		expect(take.wpm).toBeCloseTo(10 / seconds * 60, 1);
		expect(alignScriptRead(lines, words, { pauseSeconds: 1.5 }).lines[0]!.takes[0]!.pauses).toEqual([]);
	});

	it('counts pace in written words, the unit script_lint reads its wpm in', () => {
		// Eight written (and recognized) words, twelve once normalized.
		const lines = script("Don't spend $15 on a lamp in 2024.");
		const words = speak(["Don't spend $15 on a", 0.5, 'lamp in 2024.']);
		const report = alignScriptRead(lines, words);
		expect(report.lines[0]!.words).toBe(12);
		const seconds = words[words.length - 1]!.end - words[0]!.start;
		expect(report.lines[0]!.takes[0]!.wpm).toBeCloseTo(8 / seconds * 60, 1);
		expect(report.overallWpm).toBeCloseTo(8 / seconds * 60, 1);
	});

	it('keeps a handle around each take without reaching into the neighbouring words', () => {
		const lines = script('Light is.', 'Film again tonight.');
		const words = speak(['Light is.', 0.05, 'so', 0.05, 'film again tonight.', 0.5], 1);
		const report = alignScriptRead(lines, words, { bounds: { start: 0, end: 20 } });
		const [first, second] = report.lines.map((line) => line.takes[0]!);
		const so = words[2]!;
		expect(first!.keep.sourceIn).toBeCloseTo(1 - 0.12, 6);
		expect(first!.keep.sourceOut).toBeLessThanOrEqual(so.start);
		expect(second!.keep.sourceIn).toBeGreaterThanOrEqual(so.end);
		expect(second!.keep.sourceOut).toBeCloseTo(words[words.length - 1]!.end + 0.12, 3);
		// "so" sits between the takes, so they stay separate ranges.
		expect(report.keep).toHaveLength(2);
		const clamped = alignScriptRead(lines.slice(0, 1), speak(['Light is.'], 0.05), { bounds: { start: 0, end: 0.7 } }).lines[0]!.takes[0]!;
		expect(clamped.keep).toEqual({ sourceIn: 0, sourceOut: 0.7 });
	});

	it('gives each of two similar lines its own take', () => {
		const lines = script("You don't need a new camera.", 'Start with the window.', "You don't need a new camera, you need better light.");
		const words = speak([lines[0]!.text, 0.7, lines[1]!.text, 0.7, lines[2]!.text]);
		const report = alignScriptRead(lines, words);
		expect(report.lines.map((line) => line.takes.length)).toEqual([1, 1, 1]);
		expect(report.lines[0]!.takes[0]!.sourceStart).toBe(0);
		expect(report.lines[2]!.takes[0]).toMatchObject({ coverage: 1, spoken: lines[2]!.text });
	});

	it('places a repeated refrain line by its script neighbours', () => {
		const lines = script('Make it simple.', 'One light, one lens, one take.', 'Then cut the boring parts.', 'Make it simple.');
		const words = speak([lines[0]!.text, 0.7, lines[1]!.text, 0.7, lines[2]!.text, 0.7, lines[3]!.text]);
		const report = alignScriptRead(lines, words);
		expect(report.lines[0]!.takes.map((take) => take.sourceStart)).toEqual([0]);
		expect(report.lines[3]!.takes).toHaveLength(1);
		expect(report.lines[3]!.takes[0]!.sourceStart).toBeGreaterThan(report.lines[2]!.takes[0]!.sourceEnd);
		expect(report.readOrder).toEqual([1, 2, 3, 4]);
	});

	it('does not suggest a short line from later chatter that happens to say its words', () => {
		const lines = script('Most people think they need a better camera.', 'Wrong.', 'Light matters more than any lens.', 'Here is why.');
		const words = speak([lines[0]!.text, 0.7, lines[1]!.text, 0.7, lines[2]!.text, 0.7, lines[3]!.text, 2, 'I always get that wrong']);
		const report = alignScriptRead(lines, words);
		const wrong = report.lines[1]!;
		expect(wrong.takes).toHaveLength(2);
		expect(wrong.best).toBe(0);
		expect(wrong.takes[0]!.spoken).toBe('Wrong.');
		expect(report.keep.flatMap((range) => range.lines)).toEqual([1, 2, 3, 4]);
		const chatterStart = words.find((word) => word.text === 'I')!.start;
		for (const range of report.keep) expect(range.end).toBeLessThan(chatterStart);
		expect(report.warnings).toEqual([]);
	});

	it('keeps short lines on the read when chatter repeats two of them back to back', () => {
		const lines = script('Most people buy a new camera when their videos look flat.', "The camera isn't the problem.", 'Light is.', 'Here is why.', 'Put one lamp beside the window and film again tonight.');
		const words = speak([lines[0]!.text, 0.7, lines[1]!.text, 0.7, lines[2]!.text, 0.7, lines[3]!.text, 0.7, lines[4]!.text, 2, 'was the light is too harsh? here is why I ask']);
		const report = alignScriptRead(lines, words);
		expect(report.lines.map((line) => line.takes[line.best!]!.spoken)).toEqual(lines.map((line) => line.text));
		const chatterStart = words.find((word) => word.text === 'was')!.start;
		for (const range of report.keep) expect(range.end).toBeLessThan(chatterStart);
	});

	it('still prefers a later pickup of a short line read on its own', () => {
		const lines = script('Most people think they need a better camera.', 'Wrong.', 'Light matters more than any lens.');
		const words = speak([lines[0]!.text, 0.7, lines[1]!.text, 0.7, lines[2]!.text, 2, 'okay once more', 1, 'Wrong.', 1]);
		const report = alignScriptRead(lines, words);
		expect(report.lines[1]!.takes).toHaveLength(2);
		expect(report.lines[1]!.best).toBe(1);
	});

	it('accepts short lines read with small words between them, and warns when a line was only heard in passing', () => {
		const lines = script('Light is.', 'Here is why.');
		const report = alignScriptRead(lines, speak(['Light is.', 0.1, 'so', 0.1, 'here is why.']));
		expect(report.unspoken).toEqual([]);
		expect(report.warnings).toEqual([]);
		const passing = alignScriptRead(script('Most people buy a new camera when their videos look flat.', 'Wrong.'), speak(['Most people buy a new camera when their videos look flat.', 2, 'I always get that wrong.']));
		expect(passing.lines[1]!.best).toBe(0);
		expect(passing.warnings).toEqual([expect.stringContaining('Line 2 was only heard inside other talk')]);
	});

	it('does not count a few shared common words as a take', () => {
		const lines = script('The window light is softer in the morning.');
		const report = alignScriptRead(lines, speak(['In the end the edit is what matters to me.']));
		expect(report.unspoken).toEqual([1]);
		expect(report.extraSpeech).toHaveLength(1);
	});

	it('honours a stricter coverage threshold', () => {
		const lines = script('Grab the large bag from the hall closet.');
		const words = speak(['Grab the big bag from the closet.']);
		expect(alignScriptRead(lines, words, { minCoverage: 0.9 }).unspoken).toEqual([1]);
	});

	it('handles an empty transcript and lines without speakable words', () => {
		const report = alignScriptRead([...script('Light is.'), { n: 2, text: '⟦ask: the price⟧' }], []);
		expect(report.unspoken).toEqual([1]);
		expect(report.lines[1]).toMatchObject({ words: 0, takes: [], best: null });
		expect(report.overallWpm).toBeNull();
		expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('line 2'), expect.stringContaining('no recognized words')]));
	});

	it('ignores filler-only stretches and invalid words', () => {
		const words = [...speak(['um', 2, 'Light is.']), { text: 'ghost', start: Number.NaN, end: 1 }, { text: '  ', start: 5, end: 5.2 }];
		const report = alignScriptRead(script('Light is.'), words);
		expect(report.extraSpeech).toEqual([]);
		expect(report.lines[0]!.takes).toHaveLength(1);
	});

	it('caps the extra-speech list', () => {
		const parts: Array<string | number> = [];
		for (let index = 0; index < EXTRA_SPEECH_MAX + 5; index++) parts.push(`chatter number ${index}`, 2);
		const report = alignScriptRead(script('Light is.'), speak(parts));
		expect(report.extraSpeech).toHaveLength(EXTRA_SPEECH_MAX);
		expect(report.extraSpeechTotal).toBe(EXTRA_SPEECH_MAX + 5);
		expect(report.warnings.some((warning) => warning.includes('first 100'))).toBe(true);
	});

	/**
	 * A two-hour multi-take shoot: about 18,000 words drawn, like speech, from
	 * a Zipf distribution over 3,000 letter-only words (the commonest is about
	 * 11% of all words, more than "the" in English), with every line read two
	 * or three times in shuffled order between stretches of chatter.
	 */
	function shoot(lineCount: number, dense?: string) {
		let state = 7;
		const random = () => {
			state = (state + 0x6d2b79f5) | 0;
			let t = Math.imul(state ^ (state >>> 15), 1 | state);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
		};
		const letters = (value: number) => { let out = ''; do { out = String.fromCharCode(97 + (value % 26)) + out; value = Math.floor(value / 26); } while (value > 0); return out; };
		const vocabulary = Array.from({ length: 3000 }, (_, index) => `zq${letters(index)}`);
		const cumulative: number[] = [];
		let mass = 0;
		for (let rank = 1; rank <= vocabulary.length; rank++) cumulative.push(mass += 1 / rank);
		const pick = () => {
			if (dense && random() < 0.3) return dense;
			const target = random() * mass;
			let low = 0, high = cumulative.length - 1;
			while (low < high) { const middle = (low + high) >> 1; if (cumulative[middle]! < target) low = middle + 1; else high = middle; }
			return vocabulary[low]!;
		};
		const lines = Array.from({ length: lineCount }, (_, index) => ({ n: index + 1, text: Array.from({ length: 8 + (index % 10) }, pick).join(' ') }));
		const parts: Array<string | number> = [];
		const reads = new Map<number, number>();
		let count = 0;
		const order = [...lines, ...lines, ...lines.filter((_, index) => index % 3 === 0)].sort(() => random() - 0.5);
		for (const line of order) {
			const chatter = Array.from({ length: 40 + Math.floor(random() * 30) }, pick).join(' ');
			parts.push(chatter, 1, line.text, 1);
			count += chatter.split(' ').length + line.text.split(' ').length;
			reads.set(line.n, (reads.get(line.n) ?? 0) + 1);
		}
		return { lines, words: speak(parts), reads, count };
	}

	function expectEveryRead(report: ReturnType<typeof alignScriptRead>, reads: Map<number, number>) {
		expect(report.unspoken).toEqual([]);
		for (const line of report.lines) expect(line.takes.filter((take) => take.coverage === 1).length, `line ${line.n}`).toBeGreaterThanOrEqual(reads.get(line.n)!);
	}

	it('aligns a two-hour multi-take shoot with a speech-like vocabulary quickly', () => {
		const { lines, words, reads, count } = shoot(120);
		expect(count).toBeGreaterThan(15_000);
		const started = performance.now();
		const report = alignScriptRead(lines, words);
		// About 0.15 s on a busy laptop; the bound leaves room for a loaded test run.
		expect(performance.now() - started).toBeLessThan(5_000);
		expectEveryRead(report, reads);
	});

	it('stays quick when one word is in nearly a third of the speech', () => {
		const { lines, words, reads } = shoot(120, 'like');
		const started = performance.now();
		const report = alignScriptRead(lines, words);
		expect(performance.now() - started).toBeLessThan(5_000);
		expectEveryRead(report, reads);
	});
});
