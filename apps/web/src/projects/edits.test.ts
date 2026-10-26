import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { World } from 'koota';
import type { WriteResult } from './host';

const mocks = vi.hoisted(() => ({
	write: vi.fn(), restamp: vi.fn(), unsettle: vi.fn(), discard: vi.fn(), toast: vi.fn(),
}));
vi.mock('./host', () => ({ writeProject: mocks.write }));
vi.mock('@/engine/editor', () => ({ getDocumentEditor: () => ({ restamp: mocks.restamp, unsettle: mocks.unsettle, discardPending: mocks.discard }) }));
vi.mock('somoto', () => ({ toast: { error: mocks.toast } }));

const world = {} as World;
let storage: Map<string, string>;
let api: typeof import('./edits');
const key = (dir: string) => `cutroom:pending-edits:v1:${dir}`;
const prop = (value: number) => ({ kind: 'prop' as const, source: 'index.tsx:clip', name: 'x', value });
const insert = { kind: 'insert' as const, source: 'pending#1', parent: 'index.tsx:scene', tag: 'text', props: {}, text: 'Title' };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.useFakeTimers();
	storage = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (name: string) => storage.get(name) ?? null,
		setItem: (name: string, value: string) => { storage.set(name, value); },
		removeItem: (name: string) => { storage.delete(name); },
	});
	mocks.write.mockReset().mockResolvedValue({ skipped: [] });
	api = await import('./edits');
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('durable source saving', () => {
	it('journals a buffered gesture immediately and flushes without waiting for debounce', async () => {
		const writer = api.createEditWriter('/project', world);
		writer.push(prop(7));
		expect(api.projectSaveState('/project').status).toBe('saving');
		expect(JSON.parse(storage.get(key('/project'))!).props[0][1]).toEqual({ x: 7 });
		expect(mocks.write).not.toHaveBeenCalled();
		await api.flushProjectEdits('/project');
		expect(mocks.write).toHaveBeenCalledWith('/project', [{ kind: 'set', source: 'index.tsx:clip', props: { x: 7 } }], expect.any(String));
		expect(api.projectSaveState('/project').status).toBe('saved');
		expect(storage.has(key('/project'))).toBe(false);
	});

	it('serializes writes and includes edits arriving during an in-flight flush', async () => {
		const first = deferred<WriteResult>();
		mocks.write.mockReturnValueOnce(first.promise);
		const writer = api.createEditWriter('/project', world);
		writer.push(prop(1));
		const flushing = writer.flush();
		writer.push(prop(2));
		writer.push(prop(3));
		await vi.advanceTimersByTimeAsync(500);
		expect(mocks.write).toHaveBeenCalledTimes(1);
		first.resolve({ skipped: [] });
		await flushing;
		expect(mocks.write).toHaveBeenCalledTimes(2);
		expect(mocks.write.mock.calls[1]![1]).toEqual([{ kind: 'set', source: 'index.tsx:clip', props: { x: 3 } }]);
		expect(api.projectSaveState('/project').status).toBe('saved');
	});

	it('retains an uncertain insert and retries its exact operation before newer edits', async () => {
		const first = deferred<WriteResult>();
		mocks.write.mockReturnValueOnce(first.promise);
		const writer = api.createEditWriter('/project', world);
		writer.push(insert);
		const flushing = writer.flush();
		writer.push({ kind: 'text', source: 'pending#1', value: 'Updated title' });
		first.reject(new Error('Response lost after writing'));
		await expect(flushing).rejects.toThrow('Response lost');
		const original = structuredClone(mocks.write.mock.calls[0]);
		expect(api.projectSaveState('/project')).toMatchObject({ status: 'error', error: 'Response lost after writing' });
		expect(mocks.discard).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.write).toHaveBeenCalledTimes(1);
		await expect(api.flushProjectEdits('/project')).rejects.toThrow('Response lost');
		mocks.write.mockResolvedValueOnce({ skipped: [], ids: { 'pending#1': 'index.tsx:title' } });
		await api.retryProjectEdits('/project');
		expect(mocks.write.mock.calls[1]).toEqual(original);
		expect(mocks.write.mock.calls[2]![1]).toEqual([{ kind: 'set', source: 'index.tsx:title', props: {}, text: 'Updated title' }]);
		expect(mocks.write.mock.calls[2]![2]).not.toBe(original[2]);
		expect(mocks.restamp).toHaveBeenCalledWith({ 'pending#1': 'index.tsx:title' });
	});

	it('renames a child queued during its parent insert before writing the child', async () => {
		const first = deferred<WriteResult>();
		mocks.write.mockReturnValueOnce(first.promise);
		const writer = api.createEditWriter('/project', world);
		writer.push({ ...insert, tag: 'group' });
		const flushing = writer.flush();
		writer.push({ ...insert, source: 'pending#2', parent: 'pending#1' });
		first.resolve({ skipped: [], ids: { 'pending#1': 'index.tsx:group' } });
		mocks.write.mockResolvedValueOnce({ skipped: [], ids: { 'pending#2': 'index.tsx:title' } });
		await flushing;
		expect(mocks.write.mock.calls[1]![1][0].parent).toBe('index.tsx:group');
	});

	it('does not claim skipped or failed edits were saved or discard pending elements', async () => {
		mocks.write.mockResolvedValueOnce({ skipped: ['pending#1'], error: 'Disk full' });
		const writer = api.createEditWriter('/project', world);
		writer.push(insert);
		await expect(writer.flush()).rejects.toThrow('Disk full');
		expect(api.projectSaveState('/project').status).toBe('error');
		expect(storage.has(key('/project'))).toBe(true);
		expect(mocks.discard).not.toHaveBeenCalled();
	});

	it('retains a failed detached writer until recovery succeeds', async () => {
		mocks.write.mockRejectedValueOnce(new Error('Drive disconnected'));
		const writer = api.createEditWriter('/project', world);
		writer.push(prop(4));
		writer.dispose();
		await vi.advanceTimersByTimeAsync(0);
		expect(api.projectSaveState('/project').status).toBe('error');
		await api.retryProjectEdits('/project');
		expect(api.projectSaveState('/project').status).toBe('saved');
		expect(storage.has(key('/project'))).toBe(false);
	});

	it('recovers an interrupted insert receipt and buffered follow-up after renderer restart', async () => {
		const uncertain = deferred<WriteResult>();
		mocks.write.mockReturnValueOnce(uncertain.promise);
		const writer = api.createEditWriter('/project', world);
		writer.push(insert);
		void writer.flush();
		writer.push({ kind: 'text', source: 'pending#1', value: 'Recovered title' });
		const originalId = mocks.write.mock.calls[0]![2];
		vi.clearAllTimers();
		vi.resetModules();
		api = await import('./edits');
		mocks.write.mockResolvedValueOnce({ skipped: [], ids: { 'pending#1': 'index.tsx:title' } });
		await api.recoverProjectEdits('/project');
		expect(mocks.write.mock.calls[1]![2]).toBe(originalId);
		expect(mocks.write.mock.calls[2]![1]).toEqual([{ kind: 'set', source: 'index.tsx:title', props: {}, text: 'Recovered title' }]);
		expect(mocks.restamp).not.toHaveBeenCalled();
		expect(storage.has(key('/project'))).toBe(false);
	});

	it('recovers edits journaled before the debounce ever sent them to main', async () => {
		const writer = api.createEditWriter('/project', world);
		writer.push(prop(42));
		vi.clearAllTimers();
		vi.resetModules();
		api = await import('./edits');
		await api.recoverProjectEdits('/project');
		expect(mocks.write).toHaveBeenCalledTimes(1);
		expect(mocks.write.mock.calls[0]![1][0].props).toEqual({ x: 42 });
	});

	it('blocks writing while the recovery journal cannot be stored and allows explicit retry', async () => {
		const setItem = localStorage.setItem;
		localStorage.setItem = () => { throw new Error('Storage quota exceeded'); };
		const writer = api.createEditWriter('/project', world);
		writer.push(prop(5));
		await expect(writer.flush()).rejects.toThrow('recovery record');
		expect(mocks.write).not.toHaveBeenCalled();
		expect(api.projectSaveState('/project').status).toBe('error');
		localStorage.setItem = setItem;
		await writer.retry();
		expect(mocks.write).toHaveBeenCalledTimes(1);
	});

	it('preserves an unreadable journal without overwriting the project', async () => {
		storage.set(key('/project'), '{invalid');
		await expect(api.recoverProjectEdits('/project')).rejects.toThrow('kept for recovery');
		expect(storage.get(key('/project'))).toBe('{invalid');
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it('keeps malformed map entries visible and retryable without losing their journal', async () => {
		const journal = {
			version: 1, dir: '/project', unrolls: [], inserts: [], moves: [],
			props: [42], texts: [], removes: [], variables: [], inflight: [], sent: [],
		};
		const stored = JSON.stringify(journal);
		storage.set(key('/project'), stored);
		await expect(api.recoverProjectEdits('/project')).rejects.toThrow('kept for recovery');
		expect(api.projectSaveState('/project').status).toBe('error');
		await expect(api.flushProjectEdits('/project')).rejects.toThrow('kept for recovery');
		expect(storage.get(key('/project'))).toBe(stored);
		expect(mocks.write).not.toHaveBeenCalled();

		storage.set(key('/project'), JSON.stringify({ ...journal, props: [['index.tsx:clip', { x: 9 }]] }));
		await api.retryProjectEdits('/project');
		expect(mocks.write).toHaveBeenCalledWith('/project', [{ kind: 'set', source: 'index.tsx:clip', props: { x: 9 } }], expect.any(String));
		expect(api.projectSaveState('/project').status).toBe('saved');
	});

	it('releases an empty recovery writer so a later journal can still be recovered', async () => {
		const journal = {
			version: 1, dir: '/project', unrolls: [], inserts: [], moves: [],
			props: [], texts: [], removes: [], variables: [], inflight: [], sent: [],
		};
		storage.set(key('/project'), JSON.stringify(journal));
		await api.recoverProjectEdits('/project');
		storage.set(key('/project'), JSON.stringify({ ...journal, props: [['index.tsx:clip', { x: 12 }]] }));
		await api.recoverProjectEdits('/project');
		expect(mocks.write).toHaveBeenCalledWith('/project', [{ kind: 'set', source: 'index.tsx:clip', props: { x: 12 } }], expect.any(String));
	});
});
