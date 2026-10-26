/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Finding the silent stretches of a recording. The audio is reduced, as it
 * streams past, to a loudness envelope — one RMS level in dBFS per hop of a
 * few milliseconds, taken after a high-pass that drops rumble and DC — and
 * the decisions are made on that envelope, which is small enough to keep
 * whole: an hour of it is a megabyte and a half.
 *
 * What counts as silent is worked out from the recording itself rather than
 * a fixed level: the noise floor (a low percentile of the envelope) and the
 * level of the sound (a high one) are measured, and the threshold sits a
 * fraction of the way up from the one to the other, clamped to a sane range.
 * A quiet room and a noisy one are then cut the same way, and a recording
 * with no contrast between the two — music, constant noise — is left alone.
 *
 * The envelope is then gated with hysteresis, so a level hovering around the
 * threshold does not chatter; bursts of sound too short to be speech (a
 * click, a knock) are folded into the silence around them; silences too short
 * to be anything but a pause are kept; and what is cut is pulled back from
 * the sound either side, so words keep their breath and their decay.
 */

export type SilenceOptions = {
	/** The envelope's hop, in seconds. */
	hop: number;
	/** Below this, in Hz, the signal is filtered out before it is measured. */
	highpass: number;
	/** Where the threshold sits between the noise floor (0) and the sound (1). */
	sensitivity: number;
	/** The quietest the threshold may be, in dBFS. */
	minThreshold: number;
	/** The loudest the threshold may be, in dBFS: nothing above it is ever silence. */
	maxThreshold: number;
	/**
	 * How far, in dB, the sound must stand above the noise floor for there to
	 * be a threshold between them at all.
	 */
	minContrast: number;
	/** How far, in dB, the level has to fall below the threshold to close the gate again. */
	hysteresis: number;
	/** Silence shorter than this, in seconds, is a pause, and stays. */
	minSilence: number;
	/** Sound shorter than this, in seconds, between two silences is cut with them. */
	minSound: number;
	/** Kept either side of the sound, in seconds, out of the silence around it. */
	padding: number;
};

/**
 * Tuned on speech: a pause has to last half a second to be cut, and a quarter
 * of a second of it (an eighth either side) is left in, which is about the
 * gap a speaker leaves between sentences.
 */
export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
	hop: 0.01,
	highpass: 80,
	sensitivity: 0.3,
	minThreshold: -60,
	maxThreshold: -30,
	minContrast: 10,
	hysteresis: 4,
	minSilence: 0.5,
	minSound: 0.1,
	padding: 0.12,
};

/** A stretch of time, in seconds. */
export type Span = [start: number, end: number];

/** What the envelope reads where there is nothing: digital silence, or no audio at all. */
const FLOOR_DB = -100;

/** The resolution, in dB, the levels are measured at. */
const BIN_DB = 0.5;

/**
 * Reduces audio to the loudness envelope, a block at a time and in the order
 * it plays. Placed by timestamp rather than appended, so a track with a gap
 * in it, or one that starts before `start`, still lines up with the time it
 * is measured against; hops nothing reached read as silent.
 */
export class Envelope {
	readonly levels: Float32Array;
	readonly start: number;
	readonly hop: number;

	private readonly highpass: number;
	/** The filter's coefficients, for the sample rate they were made for. */
	private coefficients: { rate: number; b0: number; b1: number; b2: number; a1: number; a2: number } | null = null;
	/** The filter's state: the last two inputs and outputs. */
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;
	/** Where the next sample is expected, in seconds, to tell a gap from a continuation. */
	private expected = -Infinity;
	private index = -1;
	private sum = 0;
	private count = 0;

	constructor(start: number, end: number, options: Pick<SilenceOptions, 'hop' | 'highpass'>) {
		this.start = start;
		this.hop = options.hop;
		this.highpass = options.highpass;
		this.levels = new Float32Array(Math.max(0, Math.ceil((end - start) / options.hop))).fill(FLOOR_DB);
	}

	/**
	 * Takes in one block of interleaved samples starting at `timestamp`
	 * seconds. Channels are averaged, which is how a listener would hear a
	 * mono fold of them.
	 */
	push(samples: Float32Array, channels: number, rate: number, timestamp: number): void {
		const filter = this.filter(rate);
		const frames = Math.floor(samples.length / channels);

		// A block that does not pick up where the last one stopped follows a
		// gap (or a seek): the filter's memory is of audio that isn't adjacent.
		if (Math.abs(timestamp - this.expected) > 1 / rate * 2) {
			this.x1 = this.x2 = this.y1 = this.y2 = 0;
		}
		this.expected = timestamp + frames / rate;

		for (let frame = 0; frame < frames; frame++) {
			let x = 0;
			for (let channel = 0; channel < channels; channel++) x += samples[frame * channels + channel]!;
			x /= channels;

			const y = filter.b0 * x + filter.b1 * this.x1 + filter.b2 * this.x2 - filter.a1 * this.y1 - filter.a2 * this.y2;
			this.x2 = this.x1;
			this.x1 = x;
			this.y2 = this.y1;
			this.y1 = y;

			const index = Math.floor((timestamp + frame / rate - this.start) / this.hop);
			if (index !== this.index) {
				this.flush();
				this.index = index;
			}
			this.sum += y * y;
			this.count++;
		}
	}

	/** Writes out the hop still being summed. Call once the last block is in. */
	flush(): void {
		if (this.count > 0 && this.index >= 0 && this.index < this.levels.length) {
			this.levels[this.index] = Math.max(FLOOR_DB, 10 * Math.log10(this.sum / this.count));
		}
		this.sum = 0;
		this.count = 0;
	}

	/** A second-order Butterworth high-pass at the cutoff, for `rate`. */
	private filter(rate: number) {
		if (this.coefficients?.rate === rate) return this.coefficients;

		const w = (2 * Math.PI * Math.min(this.highpass, rate / 4)) / rate;
		const alpha = Math.sin(w) / Math.SQRT2;
		const cos = Math.cos(w);
		const a0 = 1 + alpha;

		this.coefficients = {
			rate,
			b0: (1 + cos) / 2 / a0,
			b1: -(1 + cos) / a0,
			b2: (1 + cos) / 2 / a0,
			a1: (-2 * cos) / a0,
			a2: (1 - alpha) / a0,
		};
		return this.coefficients;
	}
}

/** The level `fraction` of the envelope's hops are at or below, in dB. */
function percentile(levels: Float32Array, fraction: number): number {
	const bins = new Uint32Array(Math.ceil(-FLOOR_DB / BIN_DB) + 1);
	for (const level of levels) {
		bins[Math.min(bins.length - 1, Math.max(0, Math.round((level - FLOOR_DB) / BIN_DB)))]!++;
	}

	const target = fraction * levels.length;
	let seen = 0;
	for (let bin = 0; bin < bins.length; bin++) {
		seen += bins[bin]!;
		if (seen >= target) return FLOOR_DB + bin * BIN_DB;
	}
	return 0;
}

/**
 * The level below which the envelope is silent, or null when it has no
 * silence to tell apart: sound and floor are too close together for a line
 * between them to mean anything. A recording that is quiet throughout is
 * silent throughout, and gets the loudest threshold allowed.
 */
export function silenceThreshold(levels: Float32Array, options: SilenceOptions): number | null {
	if (levels.length === 0) return null;

	const floor = percentile(levels, 0.1);
	const sound = percentile(levels, 0.95);

	if (sound <= options.minThreshold) return options.maxThreshold;
	if (sound - floor < options.minContrast) return null;

	const threshold = floor + (sound - floor) * options.sensitivity;
	return Math.min(options.maxThreshold, Math.max(options.minThreshold, threshold));
}

/** Runs of equal values in `gate`, as [value, from, to) in hops. */
function runs(gate: Uint8Array): [value: number, from: number, to: number][] {
	const result: [number, number, number][] = [];
	let from = 0;
	for (let i = 1; i <= gate.length; i++) {
		if (i === gate.length || gate[i] !== gate[from]) {
			result.push([gate[from]!, from, i]);
			from = i;
		}
	}
	return result;
}

/**
 * The silent stretches of the envelope worth cutting, in seconds of the
 * source, already pulled back from the sound either side by the padding. A
 * silence at either end of the envelope keeps no padding on that side: there
 * is no sound beyond it to lead into.
 */
export function findSilences(envelope: Envelope, options: SilenceOptions = DEFAULT_SILENCE_OPTIONS): Span[] {
	const { levels, hop, start } = envelope;
	const threshold = silenceThreshold(levels, options);
	if (threshold === null) return [];

	// 1 is sound. Opens above the threshold and closes only once the level
	// has fallen clearly below it.
	const gate = new Uint8Array(levels.length);
	let open = false;
	for (let i = 0; i < levels.length; i++) {
		const level = levels[i]!;
		open = open ? level >= threshold - options.hysteresis : level > threshold;
		gate[i] = open ? 1 : 0;
	}

	// A burst of sound too short to be speech, with silence either side, is
	// part of that silence. One at the very edge has silence on one side only
	// and is still a click.
	const minSound = Math.round(options.minSound / hop);
	for (const [value, from, to] of runs(gate)) {
		if (value === 1 && to - from < minSound) gate.fill(0, from, to);
	}

	const minSilence = Math.round(options.minSilence / hop);
	const silences: Span[] = [];

	for (const [value, from, to] of runs(gate)) {
		if (value === 1 || to - from < minSilence) continue;

		const head = from === 0 ? 0 : options.padding;
		const tail = to === levels.length ? 0 : options.padding;
		const cutFrom = start + from * hop + head;
		const cutTo = start + to * hop - tail;
		if (cutTo - cutFrom >= hop) silences.push([cutFrom, cutTo]);
	}

	return silences;
}
