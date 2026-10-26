import { describe, expect, it } from 'vitest';
import { transcriptEditApply, transcriptEditInspect } from './transcript-edit';

describe('timeline transcript tool contracts', () => {
	it('defaults inspection to current captions and bounded pagination', () => {
		expect(transcriptEditInspect.input.parse({ id: 'index.tsx:scene' })).toEqual({ id: 'index.tsx:scene', refreshTranscript: false, wordOffset: 0, wordLimit: 2000 });
		expect(transcriptEditInspect.input.safeParse({ id: 'scene', wordLimit: 5001 }).success).toBe(false);
	});
	it('requires a trusted revision and valid retained scene ranges', () => {
		expect(transcriptEditApply.input.safeParse({ id: 'scene', revision: 'a'.repeat(64), ranges: [{ start: 6, end: 10 }, { start: 0, end: 3 }] }).success).toBe(true);
		expect(transcriptEditApply.input.safeParse({ id: 'scene', revision: 'old', ranges: [{ start: 0, end: 3 }] }).success).toBe(false);
		expect(transcriptEditApply.input.safeParse({ id: 'scene', revision: 'a'.repeat(64), ranges: [{ start: 3, end: 2 }] }).success).toBe(false);
		expect(transcriptEditApply.annotations?.destructiveHint).toBe(true);
	});
});
