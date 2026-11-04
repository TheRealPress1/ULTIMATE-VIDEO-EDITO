import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { Transcript, TranscriptWord } from '@diffusionstudio/assets';
import { cloneReframeTree } from './reframe-plan';

export interface TimelineRange { start: number; end: number }
export interface TimelineWord extends TranscriptWord { id: string; segment: number }
export interface TimelinePassage extends TimelineRange { id: string; text: string; wordIds: string[] }
export interface TranscriptEditSuggestion extends TimelineRange {
	id: string;
	kind: 'filler' | 'silence' | 'retake';
	text: string;
	/** Retakes only: the attempt suggested to keep instead. */
	alternative?: TimelineRange & { text: string };
	/** Retakes only: 0-1, how closely this attempt matches the alternative. */
	similarity?: number;
	note?: string;
}
/** How quiet pauses are searched for; see `resolveSuggestionOptions`. */
export interface TranscriptPauseOptions {
	/**
	 * Shortest quiet stretch, in seconds, that is looked for. Each removal is
	 * at least this long too, or PAUSE_CUT_FLOOR when this is longer.
	 */
	minSeconds: number;
	/** Seconds of each pause left against the speech either side. */
	keepSeconds: number;
	/** Fixed level in dBFS below which audio is quiet; null measures one from the mix. */
	thresholdDb: number | null;
	/** Round each removal inward to whole project frames. */
	frameQuantize: boolean;
}
export interface TranscriptSuggestionOptions { pauses: TranscriptPauseOptions; fillers: string[]; retakes: boolean }
export interface TranscriptSuggestionRequest {
	pauses?: Partial<TranscriptPauseOptions>;
	/** Replaces the default filler tokens; empty turns filler suggestions off. */
	fillers?: readonly string[];
	retakes?: boolean;
}
/** What the pause search measured on the scene mix, so a fixed threshold can be calibrated. */
export interface TranscriptPauseDetection extends TranscriptPauseOptions {
	mode: 'adaptive' | 'fixed';
	/** The level actually used; null when the mix had too little contrast to find pauses. */
	appliedThresholdDb: number | null;
	noiseFloorDb: number | null;
	speechDb: number | null;
}
export interface TranscriptEditSnapshot {
	revision: string;
	sceneId: string;
	sceneName: string;
	duration: number;
	frameRate: number;
	transcriptSource: 'captions' | 'transcribed';
	words: TimelineWord[];
	passages: TimelinePassage[];
	suggestions: TranscriptEditSuggestion[];
	/** Null when the mix could not be analyzed (the warnings say why). */
	pauseDetection: TranscriptPauseDetection | null;
	warnings: string[];
}

export const DEFAULT_FILLERS: readonly string[] = ['um', 'uh', 'erm', 'hmm', 'uhm'];
export const DEFAULT_PAUSE_OPTIONS: Readonly<TranscriptPauseOptions> = { minSeconds: 0.5, keepSeconds: 0.12, thresholdDb: null, frameQuantize: true };
/** The shortest pause removal suggested when `minSeconds` is longer than this; see `transcriptSuggestions`. */
export const PAUSE_CUT_FLOOR = 0.35;

/** Lowercase letters and digits only, the form fillers and repeated wording are compared in. */
export function transcriptToken(text: string): string {
	return text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
}

/** Defaults filled in, values checked, and fillers in one canonical order so equal requests hash equally. */
export function resolveSuggestionOptions(request: TranscriptSuggestionRequest = {}): TranscriptSuggestionOptions {
	const given = request.pauses ?? {};
	const pauses: TranscriptPauseOptions = {
		minSeconds: given.minSeconds ?? DEFAULT_PAUSE_OPTIONS.minSeconds,
		keepSeconds: given.keepSeconds ?? DEFAULT_PAUSE_OPTIONS.keepSeconds,
		thresholdDb: given.thresholdDb ?? null,
		frameQuantize: given.frameQuantize ?? DEFAULT_PAUSE_OPTIONS.frameQuantize,
	};
	if (!Number.isFinite(pauses.minSeconds) || pauses.minSeconds < 0.08 || pauses.minSeconds > 3) throw new Error('pauses.minSeconds must be between 0.08 and 3 seconds.');
	if (!Number.isFinite(pauses.keepSeconds) || pauses.keepSeconds < 0 || pauses.keepSeconds > 0.3) throw new Error('pauses.keepSeconds must be between 0 and 0.3 seconds.');
	if (pauses.thresholdDb !== null && (!Number.isFinite(pauses.thresholdDb) || pauses.thresholdDb < -70 || pauses.thresholdDb > -20)) throw new Error('pauses.thresholdDb must be between -70 and -20 dBFS.');
	if (request.fillers && request.fillers.length > 30) throw new Error('List at most 30 filler tokens.');
	const fillers = [...new Set((request.fillers ?? DEFAULT_FILLERS).map(transcriptToken).filter(Boolean))].sort();
	return { pauses, fillers, retakes: request.retakes === true };
}

/** Resolved runtime clocks, in this project's frame units. */
export interface TranscriptEditClip {
	tree: AuthoredTree;
	start: number;
	end: number;
	origin: number;
	rate: number;
}
export interface TranscriptEditLayer {
	/** Scene paints have no clock and retain their order. */
	fixed?: AuthoredTree;
	name?: string;
	clips?: TranscriptEditClip[];
	caption?: AuthoredTree;
}
export interface TranscriptEditPlan {
	children: AuthoredTree[];
	transcript: Transcript;
	duration: number;
	ranges: TimelineRange[];
	clipCount: number;
	captionIndex: number;
}

export function timelineWords(transcript: Transcript, duration: number): TimelineWord[] {
	if (!Array.isArray(transcript) || !Number.isFinite(duration) || duration <= 0) throw new Error('The scene transcript is invalid.');
	const result: TimelineWord[] = [];
	let previous = -Infinity;
	for (const [segment, item] of transcript.entries()) {
		if (!item || !Array.isArray(item.words)) throw new Error('The transcript has an invalid word group.');
		for (const word of item.words) {
			if (!word || typeof word.text !== 'string' || !word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || word.start < previous || word.end > duration + 0.25) throw new Error('The transcript has invalid or out-of-order word times. Transcribe the current audio again.');
			previous = word.start;
			if (word.start >= duration) continue;
			result.push({ id: `word-${result.length}`, segment, text: word.text.trim(), start: word.start, end: Math.min(word.end, duration) });
			if (result.length > 100_000) throw new Error('Transcript editing supports up to 100,000 words. Split this scene first.');
		}
	}
	if (!result.length) throw new Error('No timed speech words are available. Transcribe the current audio first.');
	return result;
}

/** Sentence blocks partition the whole scene, including breaths and leading/trailing footage. */
export function transcriptPassages(words: readonly TimelineWord[], duration: number): TimelinePassage[] {
	const passages: TimelinePassage[] = [];
	let first = 0;
	let start = 0;
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		const next = words[i + 1];
		if (next && !/[.!?]["'”’)]*$/u.test(word.text) && next.start - word.end < 0.8 && i - first < 29) continue;
		const end = next ? Math.min(duration, Math.max(start, (word.end + next.start) / 2)) : duration;
		const group = words.slice(first, i + 1);
		passages.push({ id: `passage-${passages.length}`, start, end, text: group.map((item) => item.text).join(' '), wordIds: group.map((item) => item.id) });
		first = i + 1; start = end;
	}
	return passages;
}

/**
 * Optional removal candidates: filler tokens, measured quiet stretches outside
 * recognized words, and (when asked) earlier or abandoned attempts at a
 * sentence. Pass `fps` to round quiet removals inward to whole frames.
 */
export function transcriptSuggestions(words: readonly TimelineWord[], duration: number, silences: readonly TimelineRange[], options: TranscriptSuggestionOptions = resolveSuggestionOptions(), fps?: number): TranscriptEditSuggestion[] {
	const suggestions: TranscriptEditSuggestion[] = [];
	const fillers = new Set(options.fillers);
	for (const word of words) {
		if (fillers.has(transcriptToken(word.text))) suggestions.push({ id: `filler-${word.id}`, kind: 'filler', start: word.start, end: word.end, text: word.text });
	}
	// A quiet sample alone is insufficient: retain any interval containing a
	// recognized word, and leave the requested breath on both sides of speech.
	const { keepSeconds: keep, minSeconds, frameQuantize } = options.pauses;
	const gaps: TimelineRange[] = [];
	let cursor = 0;
	for (const word of words) {
		if (word.start > cursor) gaps.push({ start: cursor + (cursor ? keep : 0), end: word.start - keep });
		cursor = Math.max(cursor, word.end);
	}
	if (cursor < duration) gaps.push({ start: cursor + keep, end: duration });
	const frame = fps && Number.isFinite(fps) && fps > 0 ? 1 / fps : 0;
	// Kept breath shortens every removal; a short search with breath on both
	// sides would otherwise propose cuts of a frame or two, each a visible jump
	// for almost no time. So a removal is never shorter than minSeconds, or
	// PAUSE_CUT_FLOOR when minSeconds is longer, which with the defaults is the
	// dialog's long-standing 0.35 s.
	const least = Math.max(minSeconds - 2 * keep, Math.min(minSeconds, PAUSE_CUT_FLOOR), frame, 0.01);
	const quiet = silences.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start).sort((a, b) => a.start - b.start);
	// Both lists are ordered and their members disjoint, so one pass pairs them.
	let g = 0;
	for (const silence of quiet) {
		while (g < gaps.length && gaps[g]!.end <= silence.start) g++;
		for (let i = g; i < gaps.length && gaps[i]!.start < silence.end; i++) {
			let start = Math.max(gaps[i]!.start, silence.start, 0);
			let end = Math.min(gaps[i]!.end, silence.end, duration);
			if (end - start < least - 1e-9) continue;
			if (frameQuantize && frame) {
				start = Math.ceil(start * fps! - 1e-6) / fps!;
				end = Math.floor(end * fps! + 1e-6) / fps!;
				if (end - start < frame - 1e-9) continue;
			}
			suggestions.push({ id: `silence-${suggestions.length}`, kind: 'silence', start, end, text: `${(end - start).toFixed(2)}s quiet pause` });
		}
	}
	if (options.retakes) suggestions.push(...transcriptRetakes(words, new Set([...DEFAULT_FILLERS, ...options.fillers])));
	return suggestions.sort((a, b) => a.start - b.start);
}

type SentenceEnding = 'complete' | 'clause' | 'abandoned';
interface RetakeSentence extends TimelineRange { first: number; last: number; text: string; tokens: string[]; ending: SentenceEnding }

const CLOSERS = '["\'”’)\\]]*$';
const ABANDONED_MARK = new RegExp(`(?:[-–—]|\\.\\.\\.|…)${CLOSERS}`, 'u');
const TERMINAL_MARK = new RegExp(`[.!?]${CLOSERS}`, 'u');
const CLAUSE_MARK = new RegExp(`[,;:]${CLOSERS}`, 'u');
const RETAKE_WINDOW = 30;
const RETAKE_PAUSE = 0.6;
const MIN_SIMILARITY = 0.5;

/**
 * Spoken sentences for retake matching: split at terminal or trailing-off
 * punctuation, at pauses of RETAKE_PAUSE, and where a sentence's first two
 * words come round again within its first dozen (a restart without a pause).
 */
export function retakeSentences(words: readonly TimelineWord[], fillers: ReadonlySet<string> = new Set(DEFAULT_FILLERS)): RetakeSentence[] {
	const sentences: RetakeSentence[] = [];
	let first = 0;
	let tokens: string[] = [];
	const spoken = (index: number) => { const value = words[index] ? transcriptToken(words[index]!.text) : ''; return fillers.has(value) ? '' : value; };
	const close = (last: number, reason: 'mark' | 'pause' | 'restart' | 'length') => {
		const word = words[last]!, gap = (words[last + 1]?.start ?? Infinity) - word.end;
		const ending: SentenceEnding = ABANDONED_MARK.test(word.text) ? 'abandoned' : TERMINAL_MARK.test(word.text) ? 'complete' : CLAUSE_MARK.test(word.text) || reason === 'length' || (reason === 'restart' && gap < 0.3) ? 'clause' : 'abandoned';
		const group = words.slice(first, last + 1);
		sentences.push({ start: group[0]!.start, end: word.end, first, last, text: group.map((item) => item.text).join(' ').slice(0, 400), tokens, ending });
		first = last + 1; tokens = [];
	};
	for (let i = 0; i < words.length; i++) {
		const token = spoken(i);
		if (token && i > first && tokens.length >= 2 && tokens.length <= 12 && token === tokens[0] && spoken(i + 1) === tokens[1]) close(i - 1, 'restart');
		if (token) tokens.push(token);
		const word = words[i]!, next = words[i + 1];
		if (!next || ABANDONED_MARK.test(word.text) || TERMINAL_MARK.test(word.text)) close(i, 'mark');
		else if (next.start - word.end >= RETAKE_PAUSE) close(i, 'pause');
		else if (tokens.length >= 60) close(i, 'length');
	}
	return sentences;
}

const fourGrams = (tokens: readonly string[]) => new Set(tokens.slice(0, Math.max(0, tokens.length - 3)).map((_, i) => tokens.slice(i, i + 4).join(' ')));

/**
 * The longest run of words both attempts open on, letting either start up to
 * two words later, so a leading "and" or "so" doesn't hide a shared opening.
 */
function sharedOpening(a: readonly string[], b: readonly string[]): { a: number; b: number; length: number } {
	let best = { a: 0, b: 0, length: 0 };
	for (let skip = 0; skip <= 2; skip++) {
		for (const [i, j] of [[skip, 0], [0, skip]] as const) {
			let length = 0;
			while (i + length < a.length && j + length < b.length && a[i + length] === b[j + length]) length++;
			if (length > best.length && (skip === 0 || length >= 2)) best = { a: i, b: j, length };
		}
	}
	return best;
}

/** Two attempts start on the same two words, either one allowed a leading word or two first. */
const opensAlike = (a: readonly string[], b: readonly string[]) => sharedOpening(a, b).length >= 2;

/**
 * The longest run of consecutive words in `removed` that a best word-for-word
 * alignment with `kept` leaves out: wording the kept take never says.
 */
function longestUnsaidRun(removed: readonly string[], kept: readonly string[]): number {
	const n = removed.length, m = kept.length;
	// common[i][j]: longest common subsequence of removed[i..] and kept[j..].
	const common = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
		common[i]![j] = removed[i] === kept[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
	}
	let longest = 0, run = 0;
	for (let i = 0, j = 0; i < n; ) {
		if (j < m && removed[i] === kept[j]) { run = 0; i++; j++; }
		else if (j < m && common[i]![j + 1]! >= common[i + 1]![j]!) j++;
		else { longest = Math.max(longest, ++run); i++; }
	}
	return longest;
}

/** Unsaid wording at least this long means the kept take drops something the removed one says. */
const UNSAID_RUN = 3;

/**
 * How closely `removed` restates `kept`, 0-1: the mean of their word overlap
 * (Jaccard) and how much of `removed` reappears in `kept`. A trailing-off
 * attempt whose opening is restarted scores at least halfway up from its
 * coverage. The score is halved when the attempts read as different lines
 * rather than two tries at one: `removed` is not trailing off and, after the
 * words they open on (a leading conjunction aside), says nothing `kept` goes
 * on to say ("It is what" against "it is.", parallel lines with new endings);
 * or `removed` carries three or more words in a row that `kept` never says
 * (a pickup that only repeats the end of a longer sentence).
 */
export function retakeSimilarity(removed: Pick<RetakeSentence, 'tokens' | 'ending'>, kept: Pick<RetakeSentence, 'tokens'>): number {
	const a = new Set(removed.tokens), b = new Set(kept.tokens);
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	const jaccard = shared / (a.size + b.size - shared), coverage = shared / a.size;
	const opening = sharedOpening(removed.tokens, kept.tokens);
	let score = (jaccard + coverage) / 2;
	if (removed.ending === 'abandoned' && opening.length >= 2 && coverage >= 0.6) score = Math.max(score, (1 + coverage) / 2);
	const tail = removed.tokens.slice(opening.a + opening.length), other = new Set(kept.tokens.slice(opening.b + opening.length));
	const differentEnding = removed.ending !== 'abandoned' && tail.length > 0 && !tail.some((token) => other.has(token));
	if (differentEnding || longestUnsaidRun(removed.tokens, kept.tokens) >= UNSAID_RUN) score /= 2;
	return Math.round(score * 100) / 100;
}

/**
 * Repeated attempts at one sentence. An earlier sentence is linked to a later
 * one within RETAKE_WINDOW seconds when they share four words in a row and
 * half their vocabulary, or when it trails off and the very next sentence
 * restarts on its first two words (a leading conjunction aside); a
 * trailing-off sentence is also linked back to an earlier one it opens like
 * and mostly repeats. Every link needs
 * MIN_SIMILARITY. Linked attempts form a group whose last complete sentence
 * is proposed as the take to keep (the last one, when none is complete);
 * every other attempt becomes a suggestion naming it.
 */
export function transcriptRetakes(words: readonly TimelineWord[], fillers: ReadonlySet<string> = new Set(DEFAULT_FILLERS)): TranscriptEditSuggestion[] {
	const sentences = retakeSentences(words, fillers);
	const grams = sentences.map((sentence) => fourGrams(sentence.tokens));
	const vocab = sentences.map((sentence) => new Set(sentence.tokens));
	const parent = sentences.map((_, i) => i);
	const root = (i: number): number => {
		let top = i;
		while (parent[top] !== top) top = parent[top]!;
		for (let next = i; parent[next] !== top; ) { const up = parent[next]!; parent[next] = top; next = up; }
		return top;
	};
	for (let i = 0; i < sentences.length; i++) {
		const a = sentences[i]!;
		if (!a.tokens.length) continue;
		let linked = false;
		for (let j = i + 1; j < sentences.length && sentences[j]!.start - a.end <= RETAKE_WINDOW; j++) {
			const b = sentences[j]!;
			if (!b.tokens.length) continue;
			let shared = 0;
			for (const token of vocab[i]!) if (vocab[j]!.has(token)) shared++;
			const jaccard = shared / (vocab[i]!.size + vocab[j]!.size - shared);
			const overlapping = jaccard >= 0.5 && [...grams[i]!].some((gram) => grams[j]!.has(gram));
			const restarted = j === i + 1 && a.ending !== 'complete' && a.tokens.length >= 2 && opensAlike(a.tokens, b.tokens);
			if ((overlapping || restarted) && retakeSimilarity(a, b) >= MIN_SIMILARITY) { parent[root(i)] = root(j); linked = true; break; }
		}
		// An attempt given up after the take it repeats, with nothing after it:
		// "It sold out in a day. It sold-".
		if (linked || a.ending !== 'abandoned' || a.tokens.length < 2) continue;
		for (let j = i - 1; j >= 0 && a.start - sentences[j]!.end <= RETAKE_WINDOW; j--) {
			const b = sentences[j]!;
			if (opensAlike(a.tokens, b.tokens) && retakeSimilarity(a, b) >= MIN_SIMILARITY) { parent[root(i)] = root(j); break; }
		}
	}
	const groups = new Map<number, number[]>();
	sentences.forEach((_, i) => { const key = root(i), members = groups.get(key); if (members) members.push(i); else groups.set(key, [i]); });
	const result: TranscriptEditSuggestion[] = [];
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const complete = members.filter((i) => sentences[i]!.ending === 'complete');
		const keep = sentences[complete.at(-1) ?? members.at(-1)!]!;
		for (const i of members) {
			const take = sentences[i]!;
			// A chain of links can drift; only attempts that restate the kept take are offered.
			const similarity = retakeSimilarity(take, keep);
			if (take === keep || similarity < MIN_SIMILARITY) continue;
			result.push({
				id: `retake-${words[take.first]!.id}`, kind: 'retake', start: take.start, end: take.end, text: take.text,
				alternative: { start: keep.start, end: keep.end, text: keep.text }, similarity,
				note: take.start < keep.start
					? 'Earlier attempt; the later take is proposed. Compare both, since the earlier one can be the better read.'
					: 'Unfinished later attempt; the earlier complete take is proposed.',
			});
		}
	}
	return result;
}

/** Subtract cuts while retaining the requested passage order. */
export function subtractTimelineRanges(ordered: readonly TimelineRange[], removed: readonly TimelineRange[]): TimelineRange[] {
	const cuts = [...removed].sort((a, b) => a.start - b.start);
	const result: TimelineRange[] = [];
	for (const passage of ordered) {
		let cursor = passage.start;
		for (const cut of cuts) {
			if (cut.end <= cursor || cut.start >= passage.end) continue;
			if (cut.start > cursor) result.push({ start: cursor, end: Math.min(cut.start, passage.end) });
			cursor = Math.max(cursor, Math.min(cut.end, passage.end));
		}
		if (cursor < passage.end) result.push({ start: cursor, end: passage.end });
	}
	return result;
}

export function transcriptDraftRanges(snapshot: TranscriptEditSnapshot, order: readonly string[], removedWords: readonly string[], removedSuggestions: readonly string[]): TimelineRange[] {
	const passages = new Map(snapshot.passages.map((passage) => [passage.id, passage]));
	if (new Set(order).size !== order.length || order.some((id) => !passages.has(id))) throw new Error('The passage order no longer matches this transcript. Reload it.');
	const wordIds = new Set(removedWords);
	const suggestionIds = new Set(removedSuggestions);
	return subtractTimelineRanges(order.map((id) => passages.get(id)!), [
		...snapshot.words.filter((word) => wordIds.has(word.id)),
		...snapshot.suggestions.filter((suggestion) => suggestionIds.has(suggestion.id)),
	]);
}

export function planTranscriptEdit(layers: readonly TranscriptEditLayer[], words: readonly TimelineWord[], ranges: readonly TimelineRange[], duration: number, fps: number): TranscriptEditPlan {
	if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('The scene has invalid timing.');
	if (!Array.isArray(ranges) || !ranges.length || ranges.length > 500) throw new Error('Keep between 1 and 500 timeline passages.');
	const total = Math.round(duration * fps);
	const frames = ranges.map((range) => {
		if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > duration + 1e-6 || range.end <= range.start) throw new Error('A kept passage is outside the current scene.');
		const start = Math.round(range.start * fps), end = Math.min(total, Math.round(range.end * fps));
		if (end <= start) throw new Error('A kept passage is shorter than one project frame.');
		return { start, end };
	});
	const sorted = [...frames].sort((a, b) => a.start - b.start);
	if (sorted.some((range, i) => i > 0 && range.start < sorted[i - 1]!.end)) throw new Error('Kept passages cannot overlap or repeat the same moment.');
	const normalized: Array<{ start: number; end: number; output: number }> = [];
	let cursor = 0;
	for (const range of frames) {
		const previous = normalized.at(-1);
		if (previous?.end === range.start) previous.end = range.end;
		else normalized.push({ ...range, output: cursor });
		cursor += range.end - range.start;
	}
	if (normalized.length === 1 && normalized[0]!.start === 0 && normalized[0]!.end === total) throw new Error('Choose words to remove or change the passage order before applying.');
	let clipCount = 0;
	let captionIndex = -1;
	const children: AuthoredTree[] = [];
	for (const layer of layers) {
		if (layer.fixed) { children.push(cloneReframeTree(layer.fixed)); continue; }
		if (layer.caption) {
			const caption = cloneReframeTree(layer.caption);
			for (const key of ['start', 'end', 'sourceIn', 'sourceOut', 'playbackRate', 'syncTo']) delete caption.props[key];
			Object.assign(caption.props, { start: 0, sourceIn: 0, sourceOut: cursor / fps });
			captionIndex = children.length; children.push(caption); continue;
		}
		const pieces: AuthoredTree[] = [];
		for (const clip of layer.clips ?? []) {
			if (![clip.start, clip.end, clip.origin, clip.rate].every(Number.isFinite) || clip.rate <= 0 || clip.end <= clip.start) throw new Error('A layer has invalid resolved timing.');
			for (const range of normalized) {
				const start = Math.max(clip.start, range.start), end = Math.min(clip.end, range.end);
				if (end <= start) continue;
				const copy = cloneReframeTree(clip.tree);
				delete copy.props.sourceOut;
				const output = range.output + start - range.start;
				Object.assign(copy.props, { start: output / fps, end: (output + end - start) / fps, sourceIn: Math.round((start - clip.origin) * clip.rate) / fps, playbackRate: clip.rate });
				pieces.push(copy);
				if (++clipCount > 2000) throw new Error('This edit would create more than 2,000 clip pieces. Keep fewer passages.');
			}
		}
		if (pieces.length === 1) children.push(pieces[0]!);
		else if (pieces.length > 1) children.push({ tag: 'sequence', props: { name: layer.name || 'Transcript edit' }, children: pieces });
	}
	if (!clipCount) throw new Error('The kept passages contain no supported timeline clips.');
	if (captionIndex < 0) {
		captionIndex = children.length;
		children.push({ tag: 'captions', props: { name: 'Edited transcript', preset: 'whisper', start: 0, sourceIn: 0, sourceOut: cursor / fps }, children: [] });
	}
	const transcript: Transcript = [];
	for (const range of normalized) {
		const from = range.start / fps, to = range.end / fps, output = range.output / fps;
		let segment = -1;
		let group: Transcript[number] | undefined;
		for (const word of words) {
			const start = Math.max(from, word.start), end = Math.min(to, word.end);
			if (end <= start) continue;
			if (!group || segment !== word.segment) { group = { text: '', words: [] }; transcript.push(group); segment = word.segment; }
			group.words.push({ text: word.text, start: output + start - from, end: output + end - from });
			group.text = group.words.map((value) => value.text).join(' ');
		}
	}
	return { children, transcript, duration: cursor / fps, ranges: normalized.map((range) => ({ start: range.start / fps, end: range.end / fps })), clipCount, captionIndex };
}
