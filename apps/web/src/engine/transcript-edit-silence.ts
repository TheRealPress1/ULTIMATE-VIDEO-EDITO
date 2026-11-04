import { DEFAULT_SILENCE_OPTIONS } from './silence/detect';
import type { SilenceOptions } from './silence/detect';
import type { SilenceLevels, SilenceRequest, SilenceResponse } from './silence/worker';
import type { TimelineRange } from './transcript-edit-plan';

/** Quiet spans of the scene mix, with the levels the detector drew its line between (null without audio). */
export interface TranscriptEditPauses { silences: TimelineRange[]; levels: SilenceLevels | null }

/** Analyze the actual scene mix, releasing the decoder worker on every exit. */
export async function detectTranscriptEditSilences(file: Blob, duration: number, signal?: AbortSignal, options: SilenceOptions = DEFAULT_SILENCE_OPTIONS): Promise<TranscriptEditPauses> {
	signal?.throwIfAborted();
	const worker = new Worker(new URL('./silence/worker.ts', import.meta.url), { type: 'module' });
	let abort: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await new Promise<TranscriptEditPauses>((resolve, reject) => {
			abort = () => reject(signal?.reason ?? new DOMException('Audio analysis canceled.', 'AbortError'));
			signal?.addEventListener('abort', abort, { once: true });
			timeout = setTimeout(() => reject(new Error('Quiet-pause analysis timed out. Try a shorter scene.')), 120_000);
			worker.onmessage = ({ data }: MessageEvent<SilenceResponse>) => {
				if ('error' in data) reject(new Error(data.error));
				else resolve({ silences: (data.silences ?? []).map(([start, end]) => ({ start, end })), levels: data.levels ?? null });
			};
			worker.onerror = (event) => reject(new Error(event.message || 'Quiet-pause analysis failed.'));
			if (signal?.aborted) { abort(); return; }
			worker.postMessage({ file, start: 0, end: duration, options } satisfies SilenceRequest);
		});
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abort) signal?.removeEventListener('abort', abort);
		worker.terminate();
	}
}
