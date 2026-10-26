import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
		workers[0]!.onmessage!({ data: { silences: [[2, 4], [7, 8]] } });
		await expect(promise).resolves.toEqual([{ start: 2, end: 4 }, { start: 7, end: 8 }]);
		expect(workers[0]!.terminate).toHaveBeenCalledOnce();
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
