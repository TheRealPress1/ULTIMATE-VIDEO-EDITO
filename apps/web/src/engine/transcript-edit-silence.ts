import { DEFAULT_SILENCE_OPTIONS } from './silence/detect';
import type { SilenceRequest, SilenceResponse } from './silence/worker';
import type { TimelineRange } from './transcript-edit-plan';

/** Analyze the actual scene mix, releasing the decoder worker on every exit. */
export async function detectTranscriptEditSilences(file: Blob, duration: number, signal?: AbortSignal): Promise<TimelineRange[]> {
	signal?.throwIfAborted();
	const worker = new Worker(new URL('./silence/worker.ts', import.meta.url), { type: 'module' });
	let abort: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await new Promise<TimelineRange[]>((resolve, reject) => {
			abort = () => reject(signal?.reason ?? new DOMException('Audio analysis canceled.', 'AbortError'));
			signal?.addEventListener('abort', abort, { once: true });
			timeout = setTimeout(() => reject(new Error('Quiet-pause analysis timed out. Try a shorter scene.')), 120_000);
			worker.onmessage = ({ data }: MessageEvent<SilenceResponse>) => {
				if ('error' in data) reject(new Error(data.error));
				else resolve((data.silences ?? []).map(([start, end]) => ({ start, end })));
			};
			worker.onerror = (event) => reject(new Error(event.message || 'Quiet-pause analysis failed.'));
			if (signal?.aborted) { abort(); return; }
			worker.postMessage({ file, start: 0, end: duration, options: DEFAULT_SILENCE_OPTIONS } satisfies SilenceRequest);
		});
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abort) signal?.removeEventListener('abort', abort);
		worker.terminate();
	}
}
