import { describe, expect, it } from 'vitest';
import { reframe } from './reframe';

describe('reframe tool contract', () => {
	const speakers = { id: 'index.tsx:scene', formats: ['vertical'], mode: 'speakers' };
	it('accepts scene-time corrections with a global preference and adjacent half-open ranges', () => {
		const speakerFraming = { preference: 'auto', overrides: [
			{ start: 20, end: 25, preference: 'hold' },
			{ start: 5.25, end: 12.5, preference: 'left' },
			{ start: 12.5, end: 20, preference: 'wide' },
		] };
		expect(reframe.input.parse({ ...speakers, speakerFraming })).toMatchObject({ speakerFraming });
		expect(reframe.input.parse({ ...speakers, speakerFraming: { overrides: [] } })).toMatchObject({ speakerFraming: { overrides: [] } });
	});
	it.each(['left', 'right', 'wide', 'auto'])('accepts global %s preference', preference => {
		expect(reframe.input.safeParse({ ...speakers, speakerFraming: { preference } }).success).toBe(true);
	});
	it('rejects a global hold, unknown keys, wrong modes, overlapping ranges and unbounded lists', () => {
		for (const speakerFraming of [
			{ preference: 'hold' }, { preference: 'named-person' }, { confidence: 1 },
			{ overrides: [{ start: 0, end: 2, preference: 'left', trackId: 'guessed' }] },
			{ overrides: [{ start: 0, end: 2, preference: 'left' }, { start: 1.5, end: 3, preference: 'right' }] },
			{ overrides: Array.from({ length: 101 }, (_, index) => ({ start: index, end: index + 1, preference: 'auto' })) },
		]) expect(reframe.input.safeParse({ ...speakers, speakerFraming }).success).toBe(false);
		for (const mode of ['follow', 'center', undefined]) expect(reframe.input.safeParse({ ...speakers, mode, speakerFraming: { preference: 'left' } }).success).toBe(false);
	});
	it.each([[-1, 2], [2, 2], [3, 2], [0, Infinity], [NaN, 3], [0, NaN]])('rejects invalid scene-time range %s–%s', (start, end) => {
		expect(reframe.input.safeParse({ ...speakers, speakerFraming: { overrides: [{ start, end, preference: 'hold' }] } }).success).toBe(false);
	});
	it('defaults to local face following and permits all supported formats', () => {
		expect(reframe.input.parse({ id: 'index.tsx:scene', formats: ['vertical', 'square', 'landscape'] })).toEqual({ id: 'index.tsx:scene', formats: ['vertical', 'square', 'landscape'], mode: 'follow' });
	});
	it.each([[], ['vertical', 'vertical'], ['portrait'], ['vertical', 'square', 'landscape', 'vertical']].map((formats) => ({ formats })))('rejects invalid format selection $formats', ({ formats }) => {
		expect(reframe.input.safeParse({ id: 'index.tsx:scene', formats }).success).toBe(false);
	});
	it('accepts an explicit center crop and trims a version name', () => {
		expect(reframe.input.parse({ id: 'index.tsx:scene', formats: ['square'], mode: 'center', name: '  Campaign  ' })).toMatchObject({ mode: 'center', name: 'Campaign' });
		expect(reframe.input.safeParse({ id: 'index.tsx:scene', formats: ['square'], name: '   ' }).success).toBe(false);
	});
	it('requires warnings and distinguishes no face coverage from no analysis', () => {
		const result = { variants: [{ sceneId: 'index.tsx:copy', name: 'Copy', width: 1080, height: 1920, warnings: [] }], warnings: [], faceCoverage: null, videoCount: 1 };
		expect(reframe.output.parse(result).faceCoverage).toBeNull();
		expect(reframe.output.parse({ ...result, faceCoverage: 0 }).faceCoverage).toBe(0);
		expect(reframe.output.safeParse({ ...result, faceCoverage: 2 }).success).toBe(false);
		const summary = { coverage: 0, switches: 0, analyzedSeconds: 20, fallbackSeconds: 0, manualSeconds: 20, heldSeconds: 5, wideSeconds: 0, evidenceSeconds: 0 };
		expect(reframe.output.parse({ ...result, speakerSummary: summary }).speakerSummary).toEqual(summary);
	});
});
