import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { Transcript, TranscriptWord } from '@diffusionstudio/assets';
import { cloneReframeTree } from './reframe-plan';

export interface TimelineRange { start: number; end: number }
export interface TimelineWord extends TranscriptWord { id: string; segment: number }
export interface TimelinePassage extends TimelineRange { id: string; text: string; wordIds: string[] }
export interface TranscriptEditSuggestion extends TimelineRange { id: string; kind: 'filler' | 'silence'; text: string }
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
	warnings: string[];
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

export function transcriptSuggestions(words: readonly TimelineWord[], duration: number, silences: readonly TimelineRange[]): TranscriptEditSuggestion[] {
	const suggestions: TranscriptEditSuggestion[] = [];
	for (const word of words) {
		const normalized = word.text.toLowerCase().replace(/[^\p{L}]/gu, '');
		if (['um', 'uh', 'erm', 'hmm', 'uhm'].includes(normalized)) suggestions.push({ id: `filler-${word.id}`, kind: 'filler', start: word.start, end: word.end, text: word.text });
	}
	// A quiet sample alone is insufficient: retain any interval containing a
	// recognized word, and preserve a little breath on both sides of speech.
	const gaps: TimelineRange[] = [];
	let cursor = 0;
	for (const word of words) {
		if (word.start > cursor) gaps.push({ start: cursor + (cursor ? 0.12 : 0), end: word.start - 0.12 });
		cursor = Math.max(cursor, word.end);
	}
	if (cursor < duration) gaps.push({ start: cursor + 0.12, end: duration });
	for (const silence of silences) {
		if (!Number.isFinite(silence.start) || !Number.isFinite(silence.end)) continue;
		for (const gap of gaps) {
			const start = Math.max(gap.start, silence.start, 0);
			const end = Math.min(gap.end, silence.end, duration);
			if (end - start >= 0.35) suggestions.push({ id: `silence-${suggestions.length}`, kind: 'silence', start, end, text: `${(end - start).toFixed(1)}s quiet pause` });
		}
	}
	return suggestions.sort((a, b) => a.start - b.start);
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
