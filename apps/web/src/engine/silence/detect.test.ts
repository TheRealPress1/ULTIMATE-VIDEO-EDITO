/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SILENCE_OPTIONS, Envelope, findSilences, measureSilences, pauseSilenceOptions, silenceThreshold } from './detect';

/** An envelope of 10 ms hops at the given levels, `[dBFS, seconds]` at a time. */
function envelope(runs: Array<[db: number, seconds: number]>): Envelope {
	const total = runs.reduce((sum, [, seconds]) => sum + seconds, 0);
	const result = new Envelope(0, total, { hop: 0.01, highpass: 80 });
	let at = 0;
	for (const [db, seconds] of runs) {
		const hops = Math.round(seconds / 0.01);
		result.levels.fill(db, at, at + hops);
		at += hops;
	}
	return result;
}

const rounded = (spans: Array<[number, number]>) => spans.map((span) => span.map((value) => Math.round(value * 1000) / 1000));

describe('pause detection settings', () => {
	it('maps a tight search onto the detector and keeps the speech tuning otherwise', () => {
		expect(pauseSilenceOptions({ minSeconds: 0.5, keepSeconds: 0.12, thresholdDb: null })).toEqual(DEFAULT_SILENCE_OPTIONS);
		expect(pauseSilenceOptions({ minSeconds: 0.12, keepSeconds: 0, thresholdDb: -32 })).toEqual({ ...DEFAULT_SILENCE_OPTIONS, minSilence: 0.12, padding: 0, minThreshold: -32, maxThreshold: -32 });
	});

	it('finds every quiet stretch of 0.12 s or more and cuts it to the sound edge with no padding', () => {
		const speech = envelope([[-20, 1], [-65, 0.15], [-20, 0.8], [-65, 0.09], [-20, 0.6], [-65, 0.4], [-20, 0.5]]);
		const tight = pauseSilenceOptions({ minSeconds: 0.12, keepSeconds: 0, thresholdDb: null });
		// The 0.09 s gap is shorter than the minimum and stays.
		expect(rounded(findSilences(speech, tight))).toEqual([[1, 1.15], [2.64, 3.04]]);
		// The default keeps an eighth of a second either side and ignores pauses under half a second.
		expect(rounded(findSilences(speech))).toEqual([]);
		expect(rounded(findSilences(envelope([[-20, 1], [-65, 0.6], [-20, 1]])))).toEqual([[1.12, 1.48]]);
	});

	it('holds a fixed threshold even where the recording has too little contrast for a measured one', () => {
		// A noisy room: the pauses sit only 8 dB under the speech.
		const noisy = envelope([[-30, 1], [-38, 0.3], [-30, 1]]);
		expect(silenceThreshold(noisy.levels, DEFAULT_SILENCE_OPTIONS)).toBeNull();
		expect(findSilences(noisy, pauseSilenceOptions({ minSeconds: 0.12, keepSeconds: 0, thresholdDb: null }))).toEqual([]);
		const fixed = pauseSilenceOptions({ minSeconds: 0.12, keepSeconds: 0, thresholdDb: -33 });
		expect(silenceThreshold(noisy.levels, fixed)).toBe(-33);
		expect(rounded(findSilences(noisy, fixed))).toEqual([[1, 1.3]]);
	});

	it('reports the floor, sound and threshold it decided between', () => {
		const measured = measureSilences(envelope([[-20, 1.5], [-70, 0.6], [-20, 1]]));
		expect(measured).toMatchObject({ floor: -70, sound: -20 });
		expect(measured.threshold).toBeCloseTo(-55, 0);
		expect(measured.silences).toHaveLength(1);
		expect(measureSilences(envelope([[-30, 1], [-36, 1]]))).toEqual({ silences: [], floor: -36, sound: -30, threshold: null });
	});
});
