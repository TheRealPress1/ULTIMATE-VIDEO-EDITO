import { describe, expect, it } from 'vitest';
import { resolveFootagePassage, searchFootage, type FootageItem } from './footage-search';

const item: FootageItem = { assetId: 'a', path: 'interview.mp4', fingerprint: 'hash', status: 'ready', segments: [
	{ text: 'The first story.', words: [{ text: 'The', start: 1, end: 1.2 }, { text: 'first', start: 1.3, end: 1.5 }, { text: 'story.', start: 1.5, end: 2 }] },
	{ text: 'Goes on here.', words: [{ text: 'Goes', start: 2.1, end: 2.5 }, { text: 'on', start: 2.6, end: 2.7 }, { text: 'here.', start: 2.8, end: 3.1 }] },
] };

describe('searchable footage passages', () => {
	it('matches phrases across segment boundaries with case and punctuation normalized', () => {
		expect(searchFootage([item], 'STORY, goes')).toEqual([expect.objectContaining({ assetId: 'a', sourceIn: 1, sourceOut: 3.1, text: 'The first story. Goes on here.' })]);
	});
	it('returns complete source passages for blank queries and skips unavailable files', () => {
		expect(searchFootage([item, { ...item, assetId: 'stale', status: 'stale' }], '')).toHaveLength(2);
		expect(searchFootage([item], '!')).toEqual([]);
		expect(searchFootage([item], 'history')).toEqual([]);
	});
	it('supports unicode and produces independent matches for identical source copies', () => {
		const unicode = { ...item, segments: [{ text: 'ÉTÉ', words: [{ text: 'ÉTÉ', start: 0, end: 1 }] }] };
		expect(searchFootage([unicode], 'été')).toHaveLength(1);
		const matches = searchFootage([item, { ...item, assetId: 'b' }], 'first');
		expect(matches).toHaveLength(2);
		expect(matches[0]!.id).not.toBe(matches[1]!.id);
		matches[0]!.words[0]!.text = 'mutated';
		expect(item.segments![0]!.words[0]!.text).toBe('The');
	});
	it('deduplicates repeated hits inside a segment', () => {
		const repeated = { ...item, segments: [{ text: 'go go', words: [{ text: 'go', start: 0, end: 1 }, { text: 'go', start: 1, end: 2 }] }] };
		expect(searchFootage([repeated], 'go')).toHaveLength(1);
	});
	it('resolves words from the trusted index and preserves caller-selected source bounds', () => {
		const match = resolveFootagePassage(item, { assetId: 'a', fingerprint: 'hash', sourceIn: 1.4, sourceOut: 2.6 }, 4);
		expect(match).toMatchObject({ sourceIn: 1.4, sourceOut: 2.6, text: 'first story. Goes' });
		expect(match.words.map((word) => word.text)).toEqual(['first', 'story.', 'Goes']);
	});
	it('rejects changed sources, invalid bounds and ranges without speech', () => {
		const ref = { assetId: 'a', fingerprint: 'hash', sourceIn: 1, sourceOut: 2 };
		expect(() => resolveFootagePassage(item, { ...ref, fingerprint: 'changed' }, 4)).toThrow('changed');
		for (const range of [{ sourceIn: -1, sourceOut: 2 }, { sourceIn: 1, sourceOut: Infinity }, { sourceIn: 2, sourceOut: 1 }, { sourceIn: 1, sourceOut: 5 }]) {
			expect(() => resolveFootagePassage(item, { ...ref, ...range }, 4)).toThrow('outside');
		}
		expect(() => resolveFootagePassage(item, { ...ref, sourceIn: 3.2, sourceOut: 4 }, 4)).toThrow('no indexed speech');
	});
});
