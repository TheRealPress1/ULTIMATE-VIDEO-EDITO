/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The silences of a media file's audio, found off the main thread: the
// stretch asked about is decoded block by block and each block is folded
// into the loudness envelope before the next is decoded, so nothing more than
// one block of samples is ever held. PCM formats are unpacked in JS, which
// would stall the UI for a long file. One worker per request.

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';

import { Envelope, findSilences } from './detect';

import type { SilenceOptions, Span } from './detect';

export interface SilenceRequest {
	file: Blob;
	/** The stretch of the file to look in, in seconds. */
	start: number;
	end: number;
	options: SilenceOptions;
}

export type SilenceResponse = { silences: Span[] | null } | { error: string };

// The app's lib is the DOM's, so the worker scope is narrowed by hand.
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<SilenceRequest>) => void) | null;
	postMessage(message: SilenceResponse): void;
};

scope.onmessage = async ({ data }) => {
	try {
		scope.postMessage({ silences: await detect(data) });
	} catch (error) {
		scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};

/** The silences between `start` and `end` of the file's primary audio track, or null when it has none. */
async function detect({ file, start, end, options }: SilenceRequest): Promise<Span[] | null> {
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return null;

		const envelope = new Envelope(start, end, options);
		const sink = new AudioSampleSink(track);

		for await (const sample of sink.samples(start, end)) {
			// Everything the sample holds is taken before it is closed, and it
			// is closed however that goes: they are decoder resources.
			try {
				const size = sample.allocationSize({ format: 'f32', planeIndex: 0 });
				const floats = new Float32Array(size / Float32Array.BYTES_PER_ELEMENT);
				sample.copyTo(floats, { format: 'f32', planeIndex: 0 });
				envelope.push(floats, sample.numberOfChannels, sample.sampleRate, sample.timestamp);
			} finally {
				sample.close();
			}
		}
		envelope.flush();

		return findSilences(envelope, options);
	} finally {
		input.dispose();
	}
}
