import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pauseSilenceOptions } from './silence/detect';
import { detectTranscriptEditSilences } from './transcript-edit-silence';

let workers: FakeWorker[];
class FakeWorker {
	onmessage?: (event: { data: unknown }) => void;
	onerror?: (event: { message: string }) => void;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() { workers.push(this); }
}
beforeEach(() => { workers = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => vi.unstubAllGlobals());

describe('scene-mix silence worker', () => {
	it('returns measured spans and releases its decoder worker', async () => {
		const promise = detectTranscriptEditSilences(new Blob(['mix']), 10);
		expect(workers[0]!.postMessage).toHaveBeenCalledWith(expect.objectContaining({ start: 0, end: 10, options: expect.objectContaining({ minSilence: 0.5, padding: 0.12 }) }));
		workers[0]!.onmessage!({ data: { silences: [[2, 4], [7, 8]], levels: { floor: -60, sound: -20, threshold: -48 } } });
		await expect(promise).resolves.toEqual({ silences: [{ start: 2, end: 4 }, { start: 7, end: 8 }], levels: { floor: -60, sound: -20, threshold: -48 } });
		expect(workers[0]!.terminate).toHaveBeenCalledOnce();
	});
	it('sends the requested detector settings and reports a mix without audio as no levels', async () => {
		const options = pauseSilenceOptions({ minSeconds: 0.12, keepSeconds: 0, thresholdDb: -38 });
		const promise = detectTranscriptEditSilences(new Blob(['mix']), 10, undefined, options);
		expect(workers[0]!.postMessage.mock.calls[0]![0].options).toBe(options);
		workers[0]!.onmessage!({ data: { silences: null } });
		await expect(promise).resolves.toEqual({ silences: [], levels: null });
	});
	it('terminates promptly on cancellation without a late worker reply', async () => {
		const controller = new AbortController();
		const promise = detectTranscriptEditSilences(new Blob(['mix']), 10, controller.signal);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
		expect(workers[0]!.terminate).toHaveBeenCalledOnce();
	});
	it('releases a failing worker instead of treating an error as silence', async () => {
		const promise = detectTranscriptEditSilences(new Blob(['mix']), 10);
		workers[0]!.onmessage!({ data: { error: 'Decode failed' } });
		await expect(promise).rejects.toThrow('Decode failed');
		expect(workers[0]!.terminate).toHaveBeenCalledOnce();
	});
});
