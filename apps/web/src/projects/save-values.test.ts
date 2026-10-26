import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ unregister: vi.fn(), register: vi.fn() }));
vi.mock('./edits', () => ({ registerProjectSaveParticipant: mocks.register }));
import { DurableProjectValue } from './save-values';

let storage: Map<string, string>;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.register.mockReturnValue(mocks.unregister);
	storage = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => { storage.set(key, value); },
		removeItem: (key: string) => { storage.delete(key); },
	});
});
afterEach(() => vi.unstubAllGlobals());
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe('manifest and settings recovery', () => {
	it('serializes full values and flushes the latest value before resolving', async () => {
		const first = gate();
		const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
		const value = new DurableProjectValue('/project', 'config', write);
		value.set({ preset: 'portrait' });
		const saving = value.flush();
		value.set({ preset: 'landscape' });
		expect(write).toHaveBeenCalledTimes(1);
		first.resolve();
		await saving;
		expect(write.mock.calls.map(([value]) => value)).toEqual([{ preset: 'portrait' }, { preset: 'landscape' }]);
		expect(value.state().status).toBe('saved');
		expect(storage.size).toBe(0);
	});

	it('retains a failed detached write and requires explicit retry', async () => {
		const write = vi.fn().mockRejectedValueOnce(new Error('Disk full')).mockResolvedValue(undefined);
		const value = new DurableProjectValue('/project', 'manifest', write);
		value.set({ assets: ['clip.mov'] });
		await expect(value.flush()).rejects.toThrow('Disk full');
		value.dispose();
		expect(mocks.unregister).not.toHaveBeenCalled();
		await expect(value.flush()).rejects.toThrow('Disk full');
		expect(write).toHaveBeenCalledTimes(1);
		await value.retry();
		expect(write).toHaveBeenCalledTimes(2);
		expect(mocks.unregister).toHaveBeenCalledOnce();
	});

	it('recovers the latest full value after a renderer restart', async () => {
		const first = new DurableProjectValue('/project', 'config', vi.fn());
		first.set({ export: { resolution: 2160 } });
		const write = vi.fn().mockResolvedValue(undefined);
		const recovered = new DurableProjectValue('/project', 'config', write);
		await recovered.flush();
		expect(write).toHaveBeenCalledWith({ export: { resolution: 2160 } });
		expect(storage.size).toBe(0);
	});

	it('keeps broken recovery records visible and refuses to overwrite them', async () => {
		storage.set('cutroom:pending-value:v1:manifest:/project', 'broken');
		const write = vi.fn();
		const recovered = new DurableProjectValue('/project', 'manifest', write);
		expect(recovered.state().status).toBe('error');
		expect(() => recovered.set({ assets: [] })).toThrow('recovery record');
		await expect(recovered.retry()).rejects.toThrow('recovery record');
		expect(write).not.toHaveBeenCalled();
		expect(storage.values().next().value).toBe('broken');
	});

	it('does not send unjournaled changes when storage is unavailable', async () => {
		const write = vi.fn();
		const value = new DurableProjectValue('/project', 'config', write);
		localStorage.setItem = () => { throw new Error('Quota'); };
		expect(() => value.set({ initialized: true })).toThrow('recovery');
		await expect(value.flush()).rejects.toThrow('recovery');
		expect(write).not.toHaveBeenCalled();
	});

	it('retries reading the original journal after a temporary storage failure', async () => {
		const key = 'cutroom:pending-value:v1:config:/project';
		const journal = JSON.stringify({ version: 1, value: { export: { resolution: 2160 } } });
		storage.set(key, journal);
		const getItem = localStorage.getItem;
		localStorage.getItem = () => { throw new Error('Storage unavailable'); };
		const write = vi.fn().mockResolvedValue(undefined);
		const value = new DurableProjectValue('/project', 'config', write);
		expect(value.state().status).toBe('error');
		await expect(value.retry()).rejects.toThrow('Storage unavailable');
		expect(storage.get(key)).toBe(journal);
		expect(write).not.toHaveBeenCalled();
		localStorage.getItem = getItem;
		await value.retry();
		expect(write).toHaveBeenCalledWith({ export: { resolution: 2160 } });
		expect(value.state().status).toBe('saved');
		expect(storage.size).toBe(0);
	});

	it('releases a detached writer after retrying failed journal cleanup', async () => {
		const removeItem = localStorage.removeItem;
		localStorage.removeItem = () => { throw new Error('Storage unavailable'); };
		const write = vi.fn().mockResolvedValue(undefined);
		const value = new DurableProjectValue('/project', 'config', write);
		value.set({ initialized: true });
		await expect(value.flush()).rejects.toThrow('Storage unavailable');
		value.dispose();
		expect(mocks.unregister).not.toHaveBeenCalled();
		localStorage.removeItem = removeItem;
		await value.retry();
		expect(mocks.unregister).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledOnce();
		expect(value.state().status).toBe('saved');
	});
});
