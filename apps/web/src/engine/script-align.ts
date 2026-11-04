/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Lines up a recorded read-through, or a shoot with several takes, against
// the script it was read from. Both sides are reduced to the same spoken
// tokens first (case, punctuation, contractions, numerals), so "1,000" and
// "one thousand" or "don't" and "do not" are the same words. Each script line
// then votes for the places in the transcript where it could start, by the
// words it shares with them (rare words count more), and every promising
// place is aligned within a bounded band around it. That keeps a two-hour
// shoot sub-quadratic, and finds a line read three times, read out of order
// or never read at all. Where two lines claim the same words, the stronger
// alignment keeps them, with a small preference for a line whose script
// neighbours were read right next to it. A short line's words also come up
// in ordinary talk, so its suggested take is one it was read in rather than
// one said in passing. Pure: no app state, no I/O; the renderer runs it in
// script-align-worker.ts.

/** One script line: its number in the script and its spoken words. */
export interface ScriptLine { n: number; text: string }

/** One recognized word, in source seconds. */
export interface SpokenWord { text: string; start: number; end: number }

export interface ScriptAlignOptions {
	/** A silence at least this long inside a take is reported as a pause, in seconds (default 0.6). */
	pauseSeconds?: number;
	/** Share of a line's words a take must say exactly to count as a take, 0-1 (default 0.5). */
	minCoverage?: number;
	/** Source seconds a suggested keep range may not leave, usually the compared window (default: from 0, open-ended). */
	bounds?: { start: number; end: number };
	/** Room kept before the first and after the last word of a take, clamped to the neighbouring words (default 0.12 s). */
	handleSeconds?: number;
}

export interface TakeDifference { written: string; spoken: string }

export interface Take {
	/** First and last aligned word of the take, in source seconds. */
	sourceStart: number;
	sourceEnd: number;
	/** A range to keep for this take: the words plus a short handle, never reaching into a neighbouring word. */
	keep: { sourceIn: number; sourceOut: number };
	/** Share of the line's words said exactly (after normalization), 0-1. */
	coverage: number;
	/** The recognized words of the take, as transcribed. */
	spoken: string;
	/** Script words not said, as runs of normalized words. */
	omitted: string[];
	/** Words said that the script does not have, as runs of normalized words. */
	inserted: string[];
	/** Script words said differently. */
	substituted: TakeDifference[];
	/** Silences at least pauseSeconds long between words inside the take. */
	pauses: Array<{ start: number; end: number }>;
	/** Filler sounds (um, uh…) recognized inside the take. */
	fillers: number;
	/** Recognized words per minute over the take, pauses included, fillers left out; null for takes under a second. */
	wpm: number | null;
}

export interface LineReport {
	n: number;
	text: string;
	/** Spoken words in the line after normalization (numerals spelled out, contractions expanded). */
	words: number;
	/** Every take of the line, in recording order. */
	takes: Take[];
	/** Index into takes of the suggested take, or null when the line was not found. */
	best: number | null;
}

export interface ExtraSpeech { text: string; start: number; end: number; words: number }

export interface KeepRange { start: number; end: number; lines: number[] }

export interface ScriptReadReport {
	lines: LineReport[];
	/** Lines with spoken words that no take was found for. */
	unspoken: number[];
	/** Line numbers in the order their suggested takes were recorded. */
	readOrder: number[];
	/** Speech outside every take (ad-libs, false starts, slate talk), in recording order, at most EXTRA_SPEECH_MAX runs. */
	extraSpeech: ExtraSpeech[];
	extraSpeechTotal: number;
	/** Mean coverage of the suggested takes, counting unspoken lines as 0. */
	coverage: number;
	/** Recognized words per minute over the suggested takes, as for wpm; null when none lasts a second. */
	overallWpm: number | null;
	/** The suggested takes in script order; neighbours recorded back to back are merged into one range. */
	keep: KeepRange[];
	warnings: string[];
}

export const EXTRA_SPEECH_MAX = 100;
export const DEFAULT_PAUSE_SECONDS = 0.6;
export const DEFAULT_MIN_COVERAGE = 0.5;
const DEFAULT_HANDLE = 0.12;
const SPOKEN_TEXT_MAX = 400;
const EXTRA_TEXT_MAX = 300;

// ---------------------------------------------------------------------------
// Normalization

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
const SCALE_WORDS = new Set(['hundred', ...SCALES.filter(Boolean)]);
const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean)]);
const ORDINALS: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** Sounds a speaker makes between words, left out of the alignment and counted separately. */
export const FILLERS: ReadonlySet<string> = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm', 'eh']);

function hundreds(value: number): string[] {
	const out: string[] = [];
	let rest = value;
	if (rest >= 100) { out.push(ONES[Math.floor(rest / 100)]!, 'hundred'); rest %= 100; }
	if (rest >= 20) { out.push(TENS[Math.floor(rest / 10)]!); rest %= 10; if (rest) out.push(ONES[rest]!); }
	else if (rest > 0) out.push(ONES[rest]!);
	return out;
}

/** An integer as spoken words, without "and" or hyphens: 1205 → one thousand two hundred five. */
export function cardinalWords(value: number): string[] {
	if (!Number.isSafeInteger(value) || value < 0) return [];
	if (value === 0) return ['zero'];
	const groups: number[] = [];
	for (let rest = value; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
	if (groups.length > SCALES.length) return String(value).split('').map((digit) => ONES[Number(digit)]!);
	const out: string[] = [];
	for (let index = groups.length - 1; index >= 0; index--) {
		if (!groups[index]) continue;
		out.push(...hundreds(groups[index]!));
		if (SCALES[index]) out.push(SCALES[index]!);
	}
	return out;
}

/** A four-digit number read the way years usually are: 1990 → nineteen ninety, 1905 → nineteen oh five. */
function yearWords(value: number): string[] {
	const high = Math.floor(value / 100), low = value % 100;
	if (low === 0) return [...hundreds(high), 'hundred'];
	if (low < 10) return [...hundreds(high), 'oh', ONES[low]!];
	return [...hundreds(high), ...hundreds(low)];
}

function ordinal(words: string[]): string[] {
	const last = words[words.length - 1];
	if (!last) return words;
	const spoken = (Object.hasOwn(ORDINALS, last) ? ORDINALS[last] : undefined) ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
	return [...words.slice(0, -1), spoken];
}

function plural(words: string[]): string[] {
	const last = words[words.length - 1];
	if (!last) return words;
	const spoken = last.endsWith('y') ? `${last.slice(0, -1)}ies` : last.endsWith('x') ? `${last}es` : `${last}s`;
	return [...words.slice(0, -1), spoken];
}

/** Digits as spoken words; `suffix` is an ordinal (st, nd, rd, th) or a plural (s, 's) ending. */
function numberWords(digits: string, suffix: string | undefined): string[] {
	const [whole = '', fraction] = digits.split('.');
	const grouped = whole.includes(',');
	const plain = whole.replace(/,/g, '');
	let words: string[];
	if (plain.length > 1 && plain.startsWith('0')) words = plain.split('').map((digit) => ONES[Number(digit)]!);
	else {
		const value = Number(plain);
		words = !grouped && plain.length === 4 && fraction === undefined && ((value >= 1100 && value <= 1999) || (value >= 2010 && value <= 2099))
			? yearWords(value)
			: cardinalWords(value);
	}
	if (fraction !== undefined) words = [...words, 'point', ...fraction.split('').map((digit) => ONES[Number(digit)]!)];
	const ending = suffix?.toLowerCase().replace(/^'/, '');
	if (ending === 's') return plural(words);
	if (ending === 'st' || ending === 'nd' || ending === 'rd' || ending === 'th') return ordinal(words);
	return words;
}

// Maps, not object literals: a spoken word such as "constructor" must not find Object.prototype.
const CONTRACTIONS = new Map<string, string[]>(Object.entries({
	"can't": ['can', 'not'], "won't": ['will', 'not'], "shan't": ['shall', 'not'], "ain't": ['is', 'not'],
	"let's": ['let', 'us'], "y'all": ['you', 'all'], "o'clock": ['oclock'], "ma'am": ['madam'],
}));
const IS_CONTRACTED = new Set(['it', 'that', 'there', 'here', 'what', 'who', 'where', 'when', 'why', 'how', 'he', 'she', 'this', 'everyone', 'everybody', 'nobody', 'someone', 'somebody', 'something', 'nothing', 'everything']);
const SPELLINGS = new Map<string, string[]>(Object.entries({
	cannot: ['can', 'not'], gonna: ['going', 'to'], wanna: ['want', 'to'], gotta: ['got', 'to'], kinda: ['kind', 'of'], sorta: ['sort', 'of'],
	lemme: ['let', 'me'], gimme: ['give', 'me'], dunno: ['do', 'not', 'know'], ok: ['okay'], alright: ['all', 'right'], percent: ['percent'],
}));

function expandWord(word: string): string[] {
	if (!word.includes("'")) return SPELLINGS.get(word) ?? [word];
	const whole = CONTRACTIONS.get(word);
	if (whole) return whole;
	const suffix = /^(.*?)(n't|'re|'ve|'ll|'d|'m|'s)$/.exec(word);
	if (suffix && suffix[1]) {
		const base = suffix[1].replace(/'/g, '');
		switch (suffix[2]) {
			case "n't": return [base, 'not'];
			case "'re": return [base, 'are'];
			case "'ve": return [base, 'have'];
			case "'ll": return [base, 'will'];
			case "'d": return [base, 'would'];
			case "'m": return [base, 'am'];
			default: return IS_CONTRACTED.has(base) ? [base, 'is'] : [base];
		}
	}
	return [word.replace(/'/g, '')];
}

const CURRENCY: Record<string, [string, string]> = { $: ['dollar', 'dollars'], '€': ['euro', 'euros'], '£': ['pound', 'pounds'], '¥': ['yen', 'yen'] };
const PIECE = /([$€£¥])|(\d+(?:,\d{3})*(?:\.\d+)?)('?s\b|st\b|nd\b|rd\b|th\b)?(%)?|([\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*)|(&|\+|%|@)/gu;
const SYMBOLS: Record<string, string> = { '&': 'and', '+': 'plus', '%': 'percent', '@': 'at' };
/** Short scale letters after a number: 10k, 1.5M, 2bn. */
const SCALE_LETTERS = new Map([['k', 'thousand'], ['m', 'million'], ['bn', 'billion']]);
/** Words a currency amount reads before its currency: "$5 million" is five million dollars. */
const SCALE_AFTER = new Set([...SCALES.filter(Boolean), ...SCALE_LETTERS.keys()]);

/**
 * Spoken words of a text, as the aligner compares them: lowercase, without
 * punctuation, contractions expanded ("don't" → do not), numerals spelled
 * out ("$1,000" → one thousand dollars, "$5 million" → five million dollars,
 * "10k" → ten thousand, "3rd" → third, "1990s" → nineteen nineties), "a
 * hundred" read as one hundred, "fifteen hundred" as one thousand five
 * hundred, and "and" dropped inside numbers. Stage directions in [brackets],
 * {braces} or ⟦placeholders⟧ are not spoken and are left out. English rules;
 * other languages keep their literal words.
 */
export function normalizeSpeech(text: string): string[] {
	const cleaned = text.normalize('NFKC').toLocaleLowerCase()
		.replace(/[’‘ʼ`´]/g, "'")
		.replace(/⟦[^⟧]*⟧|\[[^\]]*\]|\{[^}]*\}/g, ' ')
		.replace(/(^|[^\p{L}])'(cause|cos|cuz)\b/gu, '$1because')
		.replace(/(^|[^\p{L}])'em\b/gu, '$1them')
		.replace(/(^|[^\p{L}])'til\b/gu, '$1until')
		.replace(/(\p{L}{2,})in'(?!\p{L})/gu, '$1ing');
	const raw: string[] = [];
	let currency: [string, string] | null = null;
	// A currency amount's word waits for the next piece, which may be its scale.
	let owed: { name: [string, string]; one: boolean } | null = null;
	const settle = () => { if (owed) { raw.push(owed.one ? owed.name[0] : owed.name[1]); owed = null; } };
	for (const match of cleaned.matchAll(PIECE)) {
		const [, symbol, digits, suffix, percent, word, other] = match;
		if (symbol) { settle(); currency = CURRENCY[symbol]!; continue; }
		if (digits) {
			settle();
			raw.push(...numberWords(digits, suffix));
			if (percent) raw.push('percent');
			if (currency) { owed = { name: currency, one: digits === '1' && !percent }; currency = null; }
			continue;
		}
		if (currency) { raw.push(currency[0]); currency = null; }
		if (owed && word && SCALE_AFTER.has(word)) { raw.push(word); owed.one = false; settle(); continue; }
		settle();
		if (word) raw.push(...expandWord(word));
		else if (other) raw.push(SYMBOLS[other]!);
	}
	settle();
	if (currency) raw.push(currency[0]);
	const out: string[] = [];
	for (let index = 0; index < raw.length; index++) {
		const token = raw[index]!;
		const next = raw[index + 1];
		const previous = out[out.length - 1] ?? '';
		if (token === 'a' && next !== undefined && SCALE_WORDS.has(next)) { out.push('one'); continue; }
		if (token === 'and' && next && NUMBER_WORDS.has(next) && SCALE_WORDS.has(previous)) continue;
		if (token === 'per' && next === 'cent') { out.push('percent'); index++; continue; }
		const scale = SCALE_LETTERS.get(token);
		if (scale && NUMBER_WORDS.has(previous)) { out.push(scale); continue; }
		// Eleven to nineteen hundred is the same number as one thousand one to nine hundred.
		const teen = ONES.indexOf(token);
		if (teen > 10 && next === 'hundred' && !NUMBER_WORDS.has(previous) && !SCALE_WORDS.has(previous) && previous !== 'point' && previous !== 'oh') {
			out.push('one', 'thousand', ONES[teen - 10]!, 'hundred');
			index++;
			continue;
		}
		if (token) out.push(token);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Transcript preparation

interface Stream {
	words: SpokenWord[];
	filler: boolean[];
	/** Token ids of the non-filler tokens, in order. */
	tokens: Int32Array;
	/** Word index of each token. */
	tokenWord: Int32Array;
	/** First token of each word, or -1 for words without tokens. */
	firstToken: Int32Array;
	lastToken: Int32Array;
}

class Vocabulary {
	private ids = new Map<string, number>();
	readonly words: string[] = [];
	id(word: string): number {
		let id = this.ids.get(word);
		if (id === undefined) { id = this.words.length; this.ids.set(word, id); this.words.push(word); }
		return id;
	}
	peek(word: string): number | undefined { return this.ids.get(word); }
}

/**
 * Valid words in time order, with numerals Whisper split across words (`1`
 * `,000`, `$` `5`) joined back, and a currency amount kept together with its
 * scale (`$5` `million`), which is read before the currency.
 */
function cleanWords(words: readonly SpokenWord[]): SpokenWord[] {
	const valid = words
		.filter((word) => word && typeof word.text === 'string' && word.text.trim() && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start)
		.map((word) => ({ text: word.text.trim(), start: word.start, end: word.end }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const out: SpokenWord[] = [];
	for (const word of valid) {
		const previous = out[out.length - 1];
		const scaled = !!previous && /^[$€£¥][\d.,]*\d$/.test(previous.text) && /^(?:thousand|million|billion|trillion)\b[\p{P}]*$/iu.test(word.text);
		if (previous && (scaled || (/\d$/.test(previous.text) && /^(?:[,.]\d|%)/.test(word.text)) || /^[$€£¥]$/.test(previous.text))) {
			previous.text += scaled ? ` ${word.text}` : word.text;
			previous.end = Math.max(previous.end, word.end);
			continue;
		}
		out.push(word);
	}
	return out;
}

function prepareStream(input: readonly SpokenWord[], vocabulary: Vocabulary): Stream {
	const words = cleanWords(input);
	const filler: boolean[] = [];
	const tokens: number[] = [], tokenWord: number[] = [];
	const firstToken = new Int32Array(words.length).fill(-1), lastToken = new Int32Array(words.length).fill(-1);
	words.forEach((word, index) => {
		const spoken = normalizeSpeech(word.text);
		const kept = spoken.filter((token) => !FILLERS.has(token));
		filler.push(spoken.length > 0 && kept.length === 0);
		if (!kept.length) return;
		firstToken[index] = tokens.length;
		for (const token of kept) { tokens.push(vocabulary.id(token)); tokenWord.push(index); }
		lastToken[index] = tokens.length - 1;
	});
	return { words, filler, tokens: Int32Array.from(tokens), tokenWord: Int32Array.from(tokenWord), firstToken, lastToken };
}

// ---------------------------------------------------------------------------
// Alignment

// Affine gaps: opening a run of missing or added words costs more than
// extending it, so an aside inside a line is bridged instead of splitting the
// take in two. A substitution costs a little more than one missing word, so a
// take does not start or end by borrowing a neighbour's word.
const MATCH = 2, NEAR = 0.5, MISMATCH = -1.6, OPEN = -1.5, EXTEND = -0.4;
const Op = { Match: 0, Substitute: 1, Omit: 2, Insert: 3 } as const;
type Op = (typeof Op)[keyof typeof Op];
/** `edge` marks a script word paired with a word just outside the aligned take (see alignScriptRead). */
interface Step { op: Op; i: number; j: number; edge?: boolean }
interface Alignment { score: number; steps: Step[]; first: number; last: number; exact: number }

/** Close spellings: a plural or tense ending (tool/tools), or one letter apart (colour/color, four/for). */
function near(a: string, b: string): boolean {
	if (a.length < 3 || b.length < 3) return false;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	if (long.length - short.length > 3) return false;
	if (short.length >= 4 && long.startsWith(short)) return true;
	if (long.length - short.length > 1) return false;
	let i = 0, j = 0, edits = 0;
	while (i < short.length && j < long.length) {
		if (short[i] === long[j]) { i++; j++; continue; }
		if (++edits > 1) return false;
		if (short.length === long.length) i++;
		j++;
	}
	return edits + (long.length - j) + (short.length - i) <= 1;
}

/** A word the recognizer could have heard for the script's word: a close spelling, or the same first letter and about as long (hey/hi, their/there, to/two). */
function soundsLike(written: string, spoken: string): boolean {
	return near(written, spoken) || (written[0] === spoken[0] && Math.abs(written.length - spoken.length) <= 2);
}

/** Written words in a recognized word, counted the way script_lint counts a script's: whitespace-separated, with a letter or digit. */
function writtenWords(text: string): number {
	let count = 0;
	for (const piece of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(piece)) count++;
	return count;
}

/**
 * Where a take of a short line sits, best first: on its own (Alone), inside
 * other talk but right beside a neighbouring line's take (BesideScript), or
 * inside other talk away from the script (InPassing). Longer lines are always
 * Alone: their words seldom all come up in passing.
 */
const Placement = { InPassing: 0, BesideScript: 1, Alone: 2 } as const;
type Placement = (typeof Placement)[keyof typeof Placement];
/** Lines of at most this many words are weighed by placement first. */
const SHORT_LINE_WORDS = 4;
/** Beside a neighbouring line's take: at most three words ("and so", "okay") between them. */
const BESIDE_GAP = 4;

/** Scratch buffers reused across alignments; one alignment runs at a time. */
const scratch = { size: 0, M: new Float64Array(0), X: new Float64Array(0), Y: new Float64Array(0), fromM: new Uint8Array(0), fromX: new Uint8Array(0), fromY: new Uint8Array(0) };
function buffers(cells: number) {
	if (scratch.size < cells) {
		const size = Math.max(cells, scratch.size * 2);
		Object.assign(scratch, { size, M: new Float64Array(size), X: new Float64Array(size), Y: new Float64Array(size), fromM: new Uint8Array(size), fromX: new Uint8Array(size), fromY: new Uint8Array(size) });
	}
	return scratch;
}

/** Seeding leaves out a word said more often than this share of the transcript, or DENSE_MIN times. */
const DENSE_SHARE = 0.05, DENSE_MIN = 64;

/** Spoken tokens close to each script token (see near), so the alignment never compares strings. */
type NearSets = ReadonlyArray<ReadonlySet<number> | undefined>;

interface PreparedLine {
	index: number;
	n: number;
	text: string;
	tokens: Int32Array;
	/** Per token: rarer words in this transcript weigh more. */
	weights: Float64Array;
	weight: number;
	/** Each distinct token's count in the line and its weight. */
	counts: Map<number, { count: number; weight: number }>;
	near: NearSets;
}
interface Candidate { line: PreparedLine; from: number; to: number; alignment: Alignment; priority: number }

/**
 * Global over the script line, local over the transcript: every script token
 * is matched, substituted or omitted, while transcript words before and after
 * the take are free. `from`..`to` (inclusive) bounds the transcript tokens.
 */
function alignLine(line: Int32Array, nearSets: NearSets, tokens: Int32Array, from: number, to: number): Alignment | null {
	const k = line.length, m = to - from + 1;
	if (!k || m <= 0) return null;
	const width = m + 1, cells = (k + 1) * width;
	// Three states per cell: ending on a pair (M), a missing script word (X), an added spoken word (Y).
	const { M, X, Y, fromM, fromX, fromY } = buffers(cells);
	for (let j = 0; j <= m; j++) { M[j] = 0; X[j] = -Infinity; Y[j] = -Infinity; }
	for (let i = 1; i <= k; i++) {
		const row = i * width, above = row - width, s = line[i - 1]!, close = nearSets[i - 1];
		for (let j = 0; j <= m; j++) {
			const at = row + j;
			if (j > 0) {
				const t = tokens[from + j - 1]!, d = above + j - 1;
				let best = M[d]!, state = 0;
				if (X[d]! > best) { best = X[d]!; state = 1; }
				if (Y[d]! > best) { best = Y[d]!; state = 2; }
				M[at] = best + (s === t ? MATCH : close !== undefined && close.has(t) ? NEAR : MISMATCH);
				fromM[at] = state;
				let inserted = M[at - 1]! + OPEN, insertedFrom = 0;
				if (X[at - 1]! + OPEN > inserted) { inserted = X[at - 1]! + OPEN; insertedFrom = 1; }
				if (Y[at - 1]! + EXTEND > inserted) { inserted = Y[at - 1]! + EXTEND; insertedFrom = 2; }
				Y[at] = inserted;
				fromY[at] = insertedFrom;
			} else { M[at] = -Infinity; Y[at] = -Infinity; }
			const u = above + j;
			let omitted = M[u]! + OPEN, omittedFrom = 0;
			if (X[u]! + EXTEND > omitted) { omitted = X[u]! + EXTEND; omittedFrom = 1; }
			if (Y[u]! + OPEN > omitted) { omitted = Y[u]! + OPEN; omittedFrom = 2; }
			X[at] = omitted;
			fromX[at] = omittedFrom;
		}
	}
	const last = k * width;
	let end = 0, endState = M[last]! >= X[last]! ? 0 : 1, score = Math.max(M[last]!, X[last]!);
	for (let j = 1; j <= m; j++) {
		const value = Math.max(M[last + j]!, X[last + j]!);
		if (value > score + 1e-9) { score = value; end = j; endState = M[last + j]! >= X[last + j]! ? 0 : 1; }
	}
	const steps: Step[] = [];
	let exact = 0;
	for (let i = k, j = end, state = endState; i > 0;) {
		const at = i * width + j;
		if (state === 0) {
			const same = line[i - 1] === tokens[from + j - 1];
			if (same) exact++;
			steps.push({ op: same ? Op.Match : Op.Substitute, i: i - 1, j: from + j - 1 });
			state = fromM[at]!; i--; j--;
		} else if (state === 1) { steps.push({ op: Op.Omit, i: i - 1, j: -1 }); state = fromX[at]!; i--; }
		else { steps.push({ op: Op.Insert, i: -1, j: from + j - 1 }); state = fromY[at]!; j--; }
	}
	steps.reverse();
	let first = -1, lastToken = -1;
	for (const step of steps) if (step.j >= 0) { if (first < 0) first = step.j; lastToken = step.j; }
	if (first < 0) return null;
	return { score, steps, first, last: lastToken, exact };
}

/**
 * The most a window can match exactly: per token, the smaller of its count in
 * the line and in the window, as a token count and as the share of the line's
 * weight. An upper bound on coverage that rules out most windows before
 * aligning them.
 */
function reachable(line: PreparedLine, tokens: Int32Array, from: number, to: number, counts: Int32Array): { found: number; share: number } {
	for (let j = from; j <= to; j++) counts[tokens[j]!]!++;
	let found = 0, mass = 0;
	for (const [token, entry] of line.counts) {
		const hits = Math.min(entry.count, counts[token]!);
		found += hits;
		mass += hits * entry.weight;
	}
	for (let j = from; j <= to; j++) counts[tokens[j]!] = 0;
	return { found, share: line.weight ? mass / line.weight : 0 };
}

/**
 * Where a line could start: transcript positions voted for by shared words,
 * summed over a band of neighbouring diagonals, strongest first and spaced
 * apart. `votes` is zeroed scratch space of at least total + k entries.
 *
 * A word said all through the transcript ("the", "and") tells little about
 * where a line starts yet votes at every place it is said. The densest of
 * them sit the vote out, as long as their weight stays under half the bar,
 * and the bar drops by that weight, so a stretch that would have reached it
 * still does.
 */
function seeds(line: PreparedLine, postings: ReadonlyMap<number, Int32Array>, votes: Float64Array, blocked: Uint8Array, band: number, threshold: number, spacing: number, cap: number, total: number): number[] {
	const k = line.tokens.length;
	const dense = Math.max(DENSE_MIN, total * DENSE_SHARE);
	const sitOut = new Uint8Array(k);
	const crowded: number[] = [];
	for (let i = 0; i < k; i++) if ((postings.get(line.tokens[i]!)?.length ?? 0) > dense) crowded.push(i);
	crowded.sort((a, b) => postings.get(line.tokens[b]!)!.length - postings.get(line.tokens[a]!)!.length);
	let skipped = 0;
	for (const i of crowded) {
		if (skipped + line.weights[i]! > threshold / 2) continue;
		sitOut[i] = 1;
		skipped += line.weights[i]!;
	}
	const bar = threshold - skipped;
	const touched: number[] = [];
	for (let i = 0; i < k; i++) {
		const list = postings.get(line.tokens[i]!);
		if (!list || sitOut[i]) continue;
		const weight = line.weights[i]!;
		for (let x = 0; x < list.length; x++) {
			const slot = list[x]! - i + k;
			if (votes[slot] === 0) touched.push(slot);
			votes[slot] += weight;
		}
	}
	const starts = Int32Array.from(touched).sort();
	const strongSlots: number[] = [], strongSums: number[] = [];
	let low = 0, high = 0, sum = 0, most = 0;
	for (let x = 0; x < starts.length; x++) {
		while (high < starts.length && starts[high]! <= starts[x]! + band) sum += votes[starts[high++]!]!;
		while (starts[low]! < starts[x]! - band) sum -= votes[starts[low++]!]!;
		if (sum >= bar - 1e-9) { strongSlots.push(starts[x]!); strongSums.push(sum); most = Math.max(most, sum); }
	}
	for (const slot of touched) votes[slot] = 0;
	// Strongest first, then earliest. A dense word can make this list as long
	// as the transcript, so it is sorted as packed numbers (sum to 1e-4, then
	// slot) rather than with a comparator.
	const width = votes.length;
	let order: number[];
	if (Math.round(most * 1e4) * width < 2 ** 52) {
		const keys = new Float64Array(strongSlots.length);
		for (let x = 0; x < keys.length; x++) keys[x] = -Math.round(strongSums[x]! * 1e4) * width + strongSlots[x]!;
		keys.sort();
		order = Array.from(keys, (key) => key - Math.floor(key / width) * width);
	} else order = strongSlots.map((slot, x) => ({ slot, sum: strongSums[x]! })).sort((a, b) => b.sum - a.sum || a.slot - b.slot).map((entry) => entry.slot);
	// `blocked` (zeroed, same indexing as `votes`) marks slots too close to a chosen start.
	const chosen: number[] = [];
	const marked: number[] = [];
	for (const slot of order) {
		const start = slot - k;
		if (blocked[start + k]) continue;
		chosen.push(start);
		for (let slot = Math.max(0, start + k - spacing + 1); slot < Math.min(blocked.length, start + k + spacing); slot++) if (!blocked[slot]) { blocked[slot] = 1; marked.push(slot); }
		if (chosen.length >= cap) break;
	}
	for (const slot of marked) blocked[slot] = 0;
	return chosen;
}

const round = (value: number, places = 3) => { const scale = 10 ** places; return Math.round(value * scale) / scale; };
// Rounded to the millisecond away from the neighbouring words; `|| 0` keeps -0 out of the output.
const up = (value: number) => Math.ceil(value * 1000 - 1e-6) / 1000 || 0;
const down = (value: number) => Math.floor(value * 1000 + 1e-6) / 1000 || 0;

/** Align every line of `script` against `words` and report its takes, the speech between them, and a keep list. */
export function alignScriptRead(script: readonly ScriptLine[], spoken: readonly SpokenWord[], options: ScriptAlignOptions = {}): ScriptReadReport {
	const pauseSeconds = options.pauseSeconds ?? DEFAULT_PAUSE_SECONDS;
	const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
	const handle = Math.max(0, options.handleSeconds ?? DEFAULT_HANDLE);
	const warnings: string[] = [];
	const vocabulary = new Vocabulary();
	const stream = prepareStream(spoken, vocabulary);
	const { words, tokens, tokenWord } = stream;
	const total = tokens.length;
	const bounds = options.bounds ?? { start: 0, end: Number.POSITIVE_INFINITY };

	const postingLists = new Map<number, number[]>();
	tokens.forEach((token, j) => { const list = postingLists.get(token); if (list) list.push(j); else postingLists.set(token, [j]); });
	const postings = new Map<number, Int32Array>([...postingLists].map(([token, list]) => [token, Int32Array.from(list)]));
	const idf = (token: string) => {
		const id = vocabulary.peek(token);
		const frequency = id === undefined ? 0 : postings.get(id)?.length ?? 0;
		return Math.log((total + 1) / (frequency + 1)) + 1;
	};

	const nearSets = new Map<number, ReadonlySet<number> | undefined>();
	const nearSet = (id: number) => {
		if (nearSets.has(id)) return nearSets.get(id);
		const word = vocabulary.words[id]!;
		const close = new Set<number>();
		for (const token of postings.keys()) if (token !== id && near(word, vocabulary.words[token]!)) close.add(token);
		const value = close.size ? close : undefined;
		nearSets.set(id, value);
		return value;
	};
	const lines: PreparedLine[] = script.map((line, index) => {
		const normalized = normalizeSpeech(line.text).filter((token) => !FILLERS.has(token));
		const weights = Float64Array.from(normalized.map(idf));
		const ids = Int32Array.from(normalized.map((token) => vocabulary.id(token)));
		const counts = new Map<number, { count: number; weight: number }>();
		ids.forEach((id, i) => { const entry = counts.get(id); if (entry) entry.count++; else counts.set(id, { count: 1, weight: weights[i]! }); });
		return { index, n: line.n, text: line.text, tokens: ids, weights, weight: weights.reduce((sum, weight) => sum + weight, 0), counts, near: Array.from(ids, nearSet) };
	});
	for (const line of lines) if (!line.tokens.length) warnings.push(`Script line ${line.n} has no speakable words and was not compared.`);
	if (!total) warnings.push('The transcript has no recognized words in this window.');

	// A take says at least minCoverage of the line's words, and of its weight:
	// a few shared common words around a missing name or number are not a take.
	const passes = (line: PreparedLine, alignment: Alignment | null): alignment is Alignment => {
		if (!alignment || alignment.score <= 0 || alignment.exact < Math.min(line.tokens.length, 2) || alignment.exact / line.tokens.length < minCoverage - 1e-9) return false;
		let mass = 0;
		for (const step of alignment.steps) if (step.op === Op.Match) mass += line.weights[step.i]!;
		return mass / line.weight >= minCoverage - 1e-9;
	};

	// Candidate takes per line: seed, align in a band, keep the best of overlapping ones.
	const candidates: Candidate[] = [];
	const byLine = new Map<number, Candidate[]>();
	// A take carries at least minCoverage of its line's weight, and most of
	// that lands within one band of diagonals even with an aside in the line.
	const seedShare = minCoverage * 0.8;
	const MISSES = 24;
	const votes = new Float64Array(total + lines.reduce((most, line) => Math.max(most, line.tokens.length), 0) + 1);
	const blocked = new Uint8Array(votes.length);
	const counts = new Int32Array(vocabulary.words.length);
	for (const line of lines) {
		const k = line.tokens.length;
		if (!k || !total) continue;
		const band = Math.max(2, Math.ceil(k * 0.2));
		const slack = Math.max(4, k);
		// Strongest seed first; a seed inside a take already found for this line
		// is that take, and the next one is aligned only in the gap around its
		// seed, so a stronger neighbouring take cannot hide it.
		const kept: Candidate[] = [];
		const needed = Math.max(Math.min(k, 2), Math.ceil(k * minCoverage - 1e-9));
		// Seeds come strongest first, so a long run of misses means the takes are found.
		let misses = 0;
		for (const start of seeds(line, postings, votes, blocked, band, line.weight * seedShare, Math.max(1, Math.ceil(k / 3)), 200, total)) {
			if (misses >= MISSES) break;
			const anchor = Math.min(total - 1, Math.max(0, start));
			if (kept.some((other) => anchor >= other.alignment.first && anchor <= other.alignment.last)) continue;
			let from = Math.max(0, start - band - slack), to = Math.min(total - 1, start + k - 1 + band + slack);
			for (const other of kept) {
				if (other.alignment.last < anchor) from = Math.max(from, other.alignment.last + 1);
				if (other.alignment.first > anchor) to = Math.min(to, other.alignment.first - 1);
			}
			misses++;
			if (from > to) continue;
			const bound = reachable(line, tokens, from, to, counts);
			if (bound.found < needed || bound.share < minCoverage - 1e-9) continue;
			const alignment = alignLine(line.tokens, line.near, tokens, from, to);
			if (passes(line, alignment) && !kept.some((other) => alignment.first <= other.alignment.last && other.alignment.first <= alignment.last)) {
				kept.push({ line, from, to, alignment, priority: alignment.score });
				misses = 0;
			}
		}
		byLine.set(line.index, kept);
		candidates.push(...kept);
	}

	// Script order as a tiebreak: a take sitting right after a take of the line
	// before it (or right before the line after it) is preferred, which settles
	// repeated or near-identical lines.
	const adjacent = 8;
	for (const candidate of candidates) {
		const before = byLine.get(candidate.line.index - 1) ?? [];
		const after = byLine.get(candidate.line.index + 1) ?? [];
		if (before.some((other) => { const gap = candidate.alignment.first - other.alignment.last; return gap >= 1 && gap <= adjacent; })) candidate.priority += 1;
		if (after.some((other) => { const gap = other.alignment.first - candidate.alignment.last; return gap >= 1 && gap <= adjacent; })) candidate.priority += 1;
	}
	candidates.sort((a, b) => b.priority - a.priority || a.line.index - b.line.index || a.alignment.first - b.alignment.first);

	// Each transcript word belongs to at most one take.
	const owner = new Int32Array(total).fill(-1);
	const accepted: Candidate[] = [];
	const claimed = (from: number, to: number) => { for (let j = from; j <= to; j++) if (owner[j] !== -1) return true; return false; };
	const claim = (candidate: Candidate, id: number) => {
		const a = stream.firstToken[tokenWord[candidate.alignment.first]!]!, b = stream.lastToken[tokenWord[candidate.alignment.last]!]!;
		for (let j = a; j <= b; j++) owner[j] = id;
	};
	for (const candidate of candidates) {
		let chosen: Candidate | null = candidate;
		if (claimed(candidate.alignment.first, candidate.alignment.last)) {
			chosen = null;
			const spans: Array<[number, number]> = [];
			for (let j = candidate.from; j <= candidate.to;) {
				if (owner[j] !== -1) { j++; continue; }
				const start = j;
				while (j <= candidate.to && owner[j] === -1) j++;
				spans.push([start, j - 1]);
			}
			const matched = candidate.alignment.steps.filter((step) => step.op === Op.Match).map((step) => step.j);
			const ranked = spans.map((span) => ({ span, hits: matched.filter((j) => j >= span[0] && j <= span[1]).length })).filter((entry) => entry.hits > 0).sort((a, b) => b.hits - a.hits);
			const best = ranked[0];
			if (best) {
				const alignment = alignLine(candidate.line.tokens, candidate.line.near, tokens, best.span[0], best.span[1]);
				if (passes(candidate.line, alignment)) chosen = { ...candidate, from: best.span[0], to: best.span[1], alignment };
			}
		}
		if (!chosen) continue;
		claim(chosen, accepted.length);
		accepted.push(chosen);
	}

	// A take that starts or ends with omitted script words, right next to
	// unclaimed speech without a pause, may have said those words in a way the
	// recognizer heard differently ("hi" for "hey"): pair them up, one for one,
	// but only with a word that sounds alike. Anything else said there ("okay
	// rolling", "wait") stays outside the take and the script words stay omitted.
	const own = (j: number, id: number) => {
		const word = tokenWord[j]!;
		for (let t = stream.firstToken[word]!; t <= stream.lastToken[word]!; t++) owner[t] = id;
	};
	const extended = accepted.map((candidate, id) => {
		const steps = [...candidate.alignment.steps];
		const alike = (x: number, j: number) => soundsLike(vocabulary.words[candidate.line.tokens[steps[x]!.i]!]!, vocabulary.words[tokens[j]!]!);
		let lead = 0;
		while (lead < steps.length && steps[lead]!.op === Op.Omit) lead++;
		let first = candidate.alignment.first;
		for (let x = lead - 1; x >= 0; x--) {
			const j = first - 1;
			if (j < 0 || owner[j] !== -1 || !alike(x, j)) break;
			if (words[tokenWord[first]!]!.start - words[tokenWord[j]!]!.end >= pauseSeconds) break;
			steps[x] = { op: Op.Substitute, i: steps[x]!.i, j, edge: true };
			own(j, id);
			first = j;
		}
		let trail = 0;
		while (trail < steps.length && steps[steps.length - 1 - trail]!.op === Op.Omit) trail++;
		let last = candidate.alignment.last;
		for (let x = steps.length - trail; x < steps.length; x++) {
			const j = last + 1;
			if (j >= total || owner[j] !== -1 || !alike(x, j)) break;
			if (words[tokenWord[j]!]!.start - words[tokenWord[last]!]!.end >= pauseSeconds) break;
			steps[x] = { op: Op.Substitute, i: steps[x]!.i, j, edge: true };
			own(j, id);
			last = j;
		}
		return { line: candidate.line, exact: candidate.alignment.exact, steps, first, last, firstWord: tokenWord[first]!, lastWord: tokenWord[last]! };
	});

	// The words of a short line come up in other talk too ("wrong", "here is
	// why"), so a take of one is also weighed by where it sits. It stands on its
	// own when nothing unclaimed is said right before or after it, only a
	// pause, a filler, the edge or another take. Said in passing inside other
	// talk, it still reads as part of the script when a neighbouring line's
	// take is right next to it; otherwise it is most likely just talk.
	const touches = (word: number, step: -1 | 1) => {
		let edge = step < 0 ? words[word]!.start : words[word]!.end;
		for (let w = word + step; w >= 0 && w < words.length; w += step) {
			const other = words[w]!;
			if ((step < 0 ? edge - other.end : other.start - edge) >= pauseSeconds) return false;
			const t = stream.firstToken[w]!;
			if (t !== -1) return owner[t] === -1;
			edge = step < 0 ? other.start : other.end;
		}
		return false;
	};
	const extendedByLine = new Map<number, typeof extended>();
	for (const entry of extended) { const list = extendedByLine.get(entry.line.index); if (list) list.push(entry); else extendedByLine.set(entry.line.index, [entry]); }
	const placement = (entry: (typeof extended)[number]): Placement => {
		if (entry.line.tokens.length > SHORT_LINE_WORDS) return Placement.Alone;
		if (!touches(entry.firstWord, -1) && !touches(entry.lastWord, 1)) return Placement.Alone;
		const before = extendedByLine.get(entry.line.index - 1) ?? [], after = extendedByLine.get(entry.line.index + 1) ?? [];
		const inScript = before.some((other) => { const gap = entry.first - other.last; return gap >= 1 && gap <= BESIDE_GAP; })
			|| after.some((other) => { const gap = other.first - entry.last; return gap >= 1 && gap <= BESIDE_GAP; });
		return inScript ? Placement.BesideScript : Placement.InPassing;
	};

	interface Found { take: Take; firstWord: number; lastWord: number; placement: Placement; spokenWords: number }
	const takesByLine = new Map<number, Found[]>();
	const inside = new Uint8Array(words.length);
	for (const entry of extended) {
		const { line, exact, steps, firstWord, lastWord } = entry;
		for (let w = firstWord; w <= lastWord; w++) inside[w] = 1;
		const span = words.slice(firstWord, lastWord + 1);
		const sourceStart = span[0]!.start;
		const sourceEnd = Math.max(...span.map((word) => word.end));
		const omitted: string[] = [], inserted: string[] = [], substituted: TakeDifference[] = [];
		let written: string[] = [], said: string[] = [], kinds = new Set<Op>(), paired = false;
		const flush = () => {
			if (kinds.size === 1 && kinds.has(Op.Omit)) omitted.push(written.join(' '));
			else if (kinds.size === 1 && kinds.has(Op.Insert)) inserted.push(said.join(' '));
			else if (kinds.size) substituted.push({ written: written.join(' '), spoken: said.join(' ') });
			written = []; said = []; kinds = new Set();
		};
		for (const step of steps) {
			if (step.op === Op.Match) { flush(); continue; }
			// Words paired at the take's edge are their own run, apart from the omitted ones beside them.
			if (kinds.size && !!step.edge !== paired) flush();
			paired = !!step.edge;
			kinds.add(step.op);
			if (step.i >= 0) written.push(vocabulary.words[line.tokens[step.i]!]!);
			if (step.j >= 0) said.push(vocabulary.words[tokens[step.j]!]!);
		}
		flush();
		const pauses: Array<{ start: number; end: number }> = [];
		let fillers = 0, spokenWords = 0;
		for (let w = firstWord; w <= lastWord; w++) {
			if (stream.filler[w]) fillers++;
			else spokenWords += writtenWords(words[w]!.text);
			const next = words[w + 1];
			if (w < lastWord && next && next.start - words[w]!.end >= pauseSeconds - 1e-9) pauses.push({ start: round(words[w]!.end), end: round(next.start) });
		}
		// The handle never reaches into a neighbouring word, so footage_cut picks
		// up exactly this take's words.
		const previous = words[firstWord - 1], following = words[lastWord + 1];
		const floor = Math.max(bounds.start, previous ? previous.end : bounds.start);
		const ceiling = Math.min(bounds.end, following ? following.start : bounds.end);
		let sourceIn = up(Math.max(floor, sourceStart - handle));
		let sourceOut = down(Math.min(ceiling, sourceEnd + handle));
		if (!(sourceOut > sourceIn)) { sourceIn = round(sourceStart); sourceOut = round(Math.max(sourceEnd, sourceStart + 0.001)); }
		const duration = sourceEnd - sourceStart;
		const text = span.map((word) => word.text).join(' ');
		const take: Take = {
			sourceStart: round(sourceStart), sourceEnd: round(sourceEnd),
			keep: { sourceIn, sourceOut },
			coverage: round(exact / line.tokens.length),
			spoken: text.length > SPOKEN_TEXT_MAX ? `${text.slice(0, SPOKEN_TEXT_MAX - 1)}…` : text,
			omitted, inserted, substituted, pauses, fillers,
			wpm: duration >= 1 ? round(spokenWords / duration * 60, 1) : null,
		};
		const found: Found = { take, firstWord, lastWord, placement: placement(entry), spokenWords };
		const list = takesByLine.get(line.index);
		if (list) list.push(found); else takesByLine.set(line.index, [found]);
	}

	// The suggested take: for a short line, one of its own or beside its
	// script neighbours before one said in passing; then the most complete,
	// then the fewest added or changed words, then the fewest pauses, then the
	// latest.
	const deviations = (take: Take) => take.inserted.reduce((sum, run) => sum + run.split(' ').length, 0) + take.substituted.length;
	const better = (entry: Found, current: Found) => {
		const take = entry.take, other = current.take;
		return entry.placement !== current.placement ? entry.placement > current.placement
			: take.coverage !== other.coverage ? take.coverage > other.coverage
				: deviations(take) !== deviations(other) ? deviations(take) < deviations(other)
					: take.pauses.length <= other.pauses.length;
	};
	const chosen: Array<Found & { n: number; index: number }> = [];
	const report: LineReport[] = lines.map((line) => {
		const found = (takesByLine.get(line.index) ?? []).sort((a, b) => a.firstWord - b.firstWord);
		let best: number | null = null;
		found.forEach((entry, index) => { if (best === null || better(entry, found[best]!)) best = index; });
		if (best !== null) {
			const pick = found[best]!;
			chosen.push({ ...pick, n: line.n, index: line.index });
			if (pick.placement === Placement.InPassing) warnings.push(`Line ${line.n} was only heard inside other talk (its suggested take is at ${round(pick.take.sourceStart, 2)} s), not read on its own. Check that take before cutting it in.`);
		}
		return { n: line.n, text: line.text, words: line.tokens.length, takes: found.map((entry) => entry.take), best };
	});

	const unspoken = report.filter((line) => line.words > 0 && line.best === null).map((line) => line.n);
	const readOrder = [...chosen].sort((a, b) => a.firstWord - b.firstWord || a.index - b.index).map((entry) => entry.n);
	const comparable = report.filter((line) => line.words > 0);
	const coverage = comparable.length ? round(comparable.reduce((sum, line) => sum + (line.best === null ? 0 : line.takes[line.best]!.coverage), 0) / comparable.length) : 0;
	let spokenSum = 0, secondsSum = 0;
	for (const { take, spokenWords } of chosen) {
		if (take.wpm === null) continue;
		spokenSum += spokenWords;
		secondsSum += take.sourceEnd - take.sourceStart;
	}
	const overallWpm = secondsSum >= 1 ? round(spokenSum / secondsSum * 60, 1) : null;

	// Keep ranges in script order; two lines recorded back to back, with
	// nothing said between them and at most a pause apart, become one range.
	const keep: KeepRange[] = [];
	let previousLastWord = -2;
	for (const { take, firstWord, lastWord, n } of chosen) {
		const tail = keep[keep.length - 1];
		const start = take.keep.sourceIn, end = take.keep.sourceOut;
		if (tail && firstWord === previousLastWord + 1 && words[firstWord]!.start - words[previousLastWord]!.end <= pauseSeconds + 1e-9) {
			tail.end = end;
			tail.lines.push(n);
		} else keep.push({ start, end, lines: [n] });
		previousLastWord = lastWord;
	}

	// Speech outside every take, split where the speaker stops for a while.
	const extra: ExtraSpeech[] = [];
	let extraTotal = 0;
	const breakGap = Math.max(1, pauseSeconds * 2);
	for (let w = 0; w < words.length;) {
		if (inside[w]) { w++; continue; }
		const start = w;
		let real = 0;
		while (w < words.length && !inside[w] && (w === start || words[w]!.start - words[w - 1]!.end < breakGap)) {
			if (stream.firstToken[w] !== -1) real++;
			w++;
		}
		if (!real) continue;
		extraTotal++;
		if (extra.length >= EXTRA_SPEECH_MAX) continue;
		const run = words.slice(start, w);
		const text = run.map((word) => word.text).join(' ');
		extra.push({ text: text.length > EXTRA_TEXT_MAX ? `${text.slice(0, EXTRA_TEXT_MAX - 1)}…` : text, start: round(run[0]!.start), end: round(Math.max(...run.map((word) => word.end))), words: run.length });
	}
	if (extraTotal > EXTRA_SPEECH_MAX) warnings.push(`${extraTotal} stretches of speech fall outside every take; the first ${EXTRA_SPEECH_MAX} are listed.`);

	return { lines: report, unspoken, readOrder, extraSpeech: extra, extraSpeechTotal: extraTotal, coverage, overallWpm, keep, warnings };
}
