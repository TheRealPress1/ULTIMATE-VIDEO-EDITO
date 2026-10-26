import { describe, expect, it } from 'vitest';
import { AssetLibrary } from '../src/library';
import type { FsEntry, ProjectFS } from '../src/fs';

function fileSystem(files: Record<string, File>, folders: Record<string, FsEntry[]> = {}): ProjectFS {
	return {
		readManifest: async () => null,
		writeManifest: async () => {},
		list: async (path) => folders[path] ?? [],
		stat: async (path) => files[path] ? { size: files[path].size, mtime: files[path].lastModified } : null,
		file: async (path) => {
			if (!files[path]) throw new Error(`Missing ${path}`);
			return files[path];
		},
		write: async () => {},
		remove: async () => {},
	};
}

const entry = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({ name, kind, size: 1, mtime: 1 });
const transcript = (text: string) => new File([`WEBVTT\n\n00:00.000 --> 00:01.000\n${text}\n`], `${text}.vtt`, { type: 'text/vtt' });

describe('import reporting', () => {
	it('preserves selected file order when the second file finishes first', async () => {
		const fs = fileSystem({ '/slow.vtt': transcript('slow'), '/fast.vtt': transcript('fast') });
		const read = fs.file;
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
		fs.file = async (path) => {
			if (path === '/slow.vtt') await slowGate;
			return read(path);
		};
		const library = new AssetLibrary(fs);
		try {
			const pending = library.import(['/slow.vtt', '/fast.vtt']);
			// The second import shares the in-flight link and resolves only once
			// fast.vtt is fully registered, while slow.vtt is still gated.
			await library.import(['/fast.vtt']);
			releaseSlow();
			const result = await pending;
			expect(result.assets.map((asset) => asset.source)).toEqual(['/slow.vtt', '/fast.vtt']);
			expect(result.failed).toEqual([]);
		} finally {
			releaseSlow();
			await library.dispose();
		}
	});

	it('keeps different files with the same basename addressable after a concurrent import', async () => {
		const library = new AssetLibrary(fileSystem({
			'/camera-a/clip.vtt': transcript('camera-a'),
			'/camera-b/clip.vtt': transcript('camera-b'),
		}));
		try {
			const result = await library.import(['/camera-a/clip.vtt', '/camera-b/clip.vtt']);
			expect(result.failed).toEqual([]);
			expect(new Set(result.assets.map((asset) => asset.path)).size).toBe(2);
			for (const asset of result.assets) expect(library.get(asset.path)?.source).toBe(asset.source);
		} finally {
			await library.dispose();
		}
	});

	it('reports nested folder failures alongside the files that did import', async () => {
		const fs = fileSystem({ '/clips/good.vtt': transcript('good') }, {
			'/clips': [entry('good.vtt'), entry('nested', 'directory')],
			'/clips/nested': [entry('missing.mp4')],
		});
		const library = new AssetLibrary(fs);
		try {
			const result = await library.import(['/clips']);
			expect(result.assets.map((asset) => asset.path)).toEqual(['clips/good.vtt']);
			expect(result.failed.map((failure) => failure.source)).toEqual(['/clips/nested/missing.mp4']);
			expect(result.failed[0]?.error.message).toContain('No such file');
		} finally {
			await library.dispose();
		}
	});
});
