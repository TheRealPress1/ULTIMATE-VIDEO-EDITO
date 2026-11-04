/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('DOMMatrix', class {}); });

const mocks = vi.hoisted(() => ({ waveform: vi.fn(), resolve: vi.fn(), review: vi.fn(), scene: vi.fn() }));
vi.mock('@diffusionstudio/runtime', async (original) => ({ ...await original<typeof import('@diffusionstudio/runtime')>(), waveformAsset: mocks.waveform }));
vi.mock('../lib/assets', () => ({ resolveAsset: mocks.resolve }));
vi.mock('@/engine/quality-review', () => ({ reviewScene: mocks.review }));
vi.mock('../lib/scene', () => ({ requireScene: mocks.scene }));

import { decibelsForPeak, findSilentSpans, peakForDecibels, resolveSilenceSearch } from '@diffusionstudio/runtime';
import { qualityReview } from './quality-review';
import { waveform } from './waveform';
import type { ToolContext } from '../handler';
afterAll(() => vi.unstubAllGlobals());

const world = {}, session = { world, project: { dir: () => '/project' } };
const ctx = { signal: new AbortController().signal, session: () => session, requireSession: () => session } as unknown as ToolContext;
beforeEach(() => {
	vi.resetAllMocks();
	mocks.resolve.mockResolvedValue({ type: 'AUDIO' });
	mocks.waveform.mockResolvedValue({ dataUrl: 'data:image/png;base64,AA==', silences: [], silenceThresholdDb: -40, silenceMinSeconds: 0.12 });
	mocks.scene.mockReturnValue('scene');
	mocks.review.mockResolvedValue({ findings: [] });
});

describe('waveform silence settings', () => {
	it('passes the silence search through and reports the settings used', async () => {
		const result = await waveform({ path: 'a-roll/take.mp4', start: 10, end: 14, silence: { thresholdDb: -40, minSeconds: 0.12 } } as never, ctx);
		expect(mocks.waveform).toHaveBeenCalledWith({ type: 'AUDIO' }, { start: 10, end: 14, scale: undefined, silence: { thresholdDb: -40, minSeconds: 0.12 } });
		expect(result).toMatchObject({ silences: [], silenceThresholdDb: -40, silenceMinSeconds: 0.12 });
	});

	it('maps decibels onto the peak scale the waveform draws', () => {
		expect(resolveSilenceSearch()).toEqual({ threshold: 12, minSeconds: 0.4, thresholdDb: -53.1 });
		expect(peakForDecibels(-60)).toBeCloseTo(8.06, 2);
		expect(decibelsForPeak(peakForDecibels(-32))).toBeCloseTo(-32, 6);
		expect(resolveSilenceSearch({ thresholdDb: -40, minSeconds: 0.12 })).toMatchObject({ threshold: peakForDecibels(-40), minSeconds: 0.12, thresholdDb: -40 });
		expect(() => resolveSilenceSearch({ minSeconds: 0 })).toThrow('minSeconds');
	});

	it('finds shorter and louder silences with a custom search', () => {
		// 100 peaks a second: speech at 200, a 0.15 s dip to 20 (about -44 dBFS) and a 0.5 s dip to 5.
		const peaks = Uint8ClampedArray.from([...Array(100).fill(200), ...Array(15).fill(20), ...Array(100).fill(200), ...Array(50).fill(5), ...Array(35).fill(200)]);
		expect(findSilentSpans(peaks, 100)).toEqual([{ start: 215, end: 265 }]);
		expect(findSilentSpans(peaks, 100, peakForDecibels(-40), 0.12)).toEqual([{ start: 100, end: 115 }, { start: 215, end: 265 }]);
	});
});

describe('quality_review audio thresholds', () => {
	it('turns an audio object into review thresholds and keeps the boolean forms', async () => {
		await qualityReview({ id: 'reel', audio: { pauseThresholdDb: -45, minPauseSeconds: 0.25 } }, ctx);
		expect(mocks.review).toHaveBeenLastCalledWith(world, 'scene', '/project', expect.objectContaining({ audio: true, pauses: { thresholdDb: -45, minSeconds: 0.25 } }));
		await qualityReview({ id: 'reel', audio: false }, ctx);
		expect(mocks.review).toHaveBeenLastCalledWith(world, 'scene', '/project', expect.objectContaining({ audio: false, pauses: undefined }));
		await qualityReview({ id: 'reel', audio: true }, ctx);
		expect(mocks.review).toHaveBeenLastCalledWith(world, 'scene', '/project', expect.objectContaining({ audio: true, pauses: undefined }));
	});
});
