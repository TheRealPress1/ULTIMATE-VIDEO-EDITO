import type { Transcript, TranscriptWord } from '@diffusionstudio/assets';

export interface FootageItem {
	assetId: string;
	path: string;
	status: 'unindexed' | 'partial' | 'ready' | 'indexing' | 'stale' | 'error' | 'no-speech';
	fingerprint?: string;
	segments?: Transcript;
	error?: string;
	partial?: { completed: number; total: number };
}
export interface FootageMatch {
	id: string;
	assetId: string;
	path: string;
	fingerprint: string;
	sourceIn: number;
	sourceOut: number;
	text: string;
	words: TranscriptWord[];
}
export type PassageReference = Pick<FootageMatch, 'assetId' | 'fingerprint' | 'sourceIn' | 'sourceOut'>;
export interface FootageSnapshot {
	items: FootageItem[];
	loading: boolean;
	indexing: boolean;
	progress?: { completed: number; total: number; currentPath?: string; message?: string; percent?: number | null };
	error?: string;
}

/** Word-based phrase search; punctuation/case do not change a spoken match. */
const tokens = (text: string): string[] => text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function match(item: FootageItem, words: TranscriptWord[]): FootageMatch {
	const sourceIn = Math.min(...words.map((word) => word.start));
	const sourceOut = Math.max(...words.map((word) => word.end));
	return {
		id: `${item.assetId}:${item.fingerprint}:${sourceIn}:${sourceOut}`,
		assetId: item.assetId, path: item.path, fingerprint: item.fingerprint!, sourceIn, sourceOut,
		text: words.map((word) => word.text.trim()).join(' '), words: words.map((word) => ({ ...word })),
	};
}

/** Return complete transcript segments around the phrase, including boundary-spanning hits. */
export function searchFootage(items: readonly FootageItem[], query: string): FootageMatch[] {
	const needle = tokens(query);
	if (query.trim() && !needle.length) return [];
	const results: FootageMatch[] = [];
	for (const item of items) {
		if (item.status !== 'ready' || !item.fingerprint || !item.segments) continue;
		const segments = item.segments.filter((segment) => segment.words.length);
		if (!needle.length) {
			for (const segment of segments) results.push(match(item, segment.words));
			continue;
		}
		const haystack = segments.flatMap((segment, index) => segment.words.flatMap((word) => tokens(word.text).map((token) => ({ token, index }))));
		const found = new Set<string>();
		for (let i = 0; i <= haystack.length - needle.length; i++) {
			if (!needle.every((token, offset) => haystack[i + offset]!.token === token)) continue;
			const first = haystack[i]!.index;
			const last = haystack[i + needle.length - 1]!.index;
			const key = `${first}:${last}`;
			if (found.has(key)) continue;
			found.add(key);
			results.push(match(item, segments.slice(first, last + 1).flatMap((segment) => segment.words)));
		}
	}
	return results;
}

/** Captions always come from the verified local index, never from caller-supplied text. */
export function resolveFootagePassage(item: FootageItem | undefined, ref: PassageReference, duration: number): FootageMatch {
	if (!item || item.status !== 'ready' || !item.fingerprint || item.fingerprint !== ref.fingerprint) {
		throw new Error('A selected source changed or is no longer indexed. Search the footage again.');
	}
	if (!Number.isFinite(ref.sourceIn) || !Number.isFinite(ref.sourceOut) || ref.sourceIn < 0 || ref.sourceOut <= ref.sourceIn || ref.sourceOut > duration + 0.000001) {
		throw new Error('A selected passage is outside its source duration.');
	}
	const words = item.segments!.flatMap((segment) => segment.words).filter((word) => word.start < ref.sourceOut && word.end > ref.sourceIn);
	if (!words.length) throw new Error('The selected source range contains no indexed speech.');
	return { ...match(item, words), id: `${item.assetId}:${item.fingerprint}:${ref.sourceIn}:${ref.sourceOut}`, sourceIn: ref.sourceIn, sourceOut: ref.sourceOut };
}
