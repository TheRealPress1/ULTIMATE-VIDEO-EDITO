import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrary } from '../src/library';
import type { ProjectFS } from '../src/fs';

function fs(): ProjectFS {
	return { readManifest: async () => null, writeManifest: vi.fn().mockResolvedValue(undefined), list: async () => [], stat: async () => null, file: vi.fn(), write: vi.fn(), remove: vi.fn() };
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

describe('asset manifest saving', () => {
	it('reports failed writes and retains the dirty manifest for retry', async () => {
		vi.useFakeTimers();
		const disk = fs();
		const write = vi.mocked(disk.writeManifest).mockRejectedValueOnce(new Error('Drive gone'));
		const library = new AssetLibrary(disk);
		library.createFolder('Interviews');
		await expect(library.flush()).rejects.toThrow('Drive gone');
		await library.flush();
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]![0].folders).toEqual(['Interviews']);
		await library.dispose();
	});

	it('serializes overlapping changes and drains the latest manifest', async () => {
		vi.useFakeTimers();
		const disk = fs();
		const first = gate<void>();
		const write = vi.mocked(disk.writeManifest).mockReturnValueOnce(first.promise);
		const library = new AssetLibrary(disk);
		library.createFolder('A');
		const saving = library.flush();
		library.createFolder('B');
		const again = library.flush();
		expect(write).toHaveBeenCalledTimes(1);
		first.resolve();
		await Promise.all([saving, again]);
		expect(write.mock.calls[1]![0].folders).toEqual(['A', 'B']);
		await library.dispose();
	});

	it('does not replace a new library edit with a slow external reload', async () => {
		vi.useFakeTimers();
		const disk = fs();
		const reading = gate<unknown>();
		disk.readManifest = () => reading.promise;
		const library = new AssetLibrary(disk);
		const loading = library.load();
		await Promise.resolve();
		library.createFolder('New work');
		reading.resolve({ version: 1, folders: ['Old'], assets: [] });
		await loading;
		expect([...library.folders()]).toEqual(['New work']);
		await library.dispose();
	});
});
