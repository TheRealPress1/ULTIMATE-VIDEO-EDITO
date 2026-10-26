import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEdits } from '@desktop/edit';

const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('./host', () => ({ writeProject: mocks.write }));
vi.mock('@/engine/editor', () => ({ getDocumentEditor: vi.fn() }));
vi.mock('somoto', () => ({ toast: { error: vi.fn() } }));

const source = 'export default () => <scene id="original" width={1920} height={1080}><video id="footage" src="clip.mp4" /><captions id="l46k4w" src="Captions 3.json" preset="whisper" selected>{""}</captions></scene>;\n';
let dir: string;
let storage: Map<string, string>;
beforeEach(async () => {
	vi.resetModules();
	mocks.write.mockReset().mockImplementation((folder, edits) => applyEdits({ dir: folder }, edits));
	dir = await mkdtemp(join(tmpdir(), 'caption-recovery-regression-'));
	await writeFile(join(dir, 'index.tsx'), source);
	storage = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

describe('caption recovery startup boundary', () => {
	it('leaves selected captions untouched when there is no pending edit journal', async () => {
		const { recoverProjectEdits } = await import('./edits');
		await recoverProjectEdits(dir);
		expect(mocks.write).not.toHaveBeenCalled();
		expect(await readFile(join(dir, 'index.tsx'), 'utf8')).toBe(source);
	});

	it('replays a previously journaled caption removal on startup even when source was restored externally', async () => {
		// Models a removal queued in an earlier renderer before shutdown. The
		// current recovery format has no file revision to distinguish an external
		// restoration from an edit that has simply not reached disk yet.
		storage.set(`cutroom:pending-edits:v1:${dir}`, JSON.stringify({
			version: 1, dir, unrolls: [], inserts: [], moves: [], props: [], texts: [],
			removes: ['index.tsx:l46k4w'], variables: [], inflight: [], sent: [],
		}));
		await writeFile(join(dir, 'index.tsx'), source);
		const { recoverProjectEdits } = await import('./edits');
		await recoverProjectEdits(dir);
		expect(mocks.write).toHaveBeenCalledWith(dir, [{ kind: 'remove', source: 'index.tsx:l46k4w' }], expect.any(String));
		const after = await readFile(join(dir, 'index.tsx'), 'utf8');
		expect(after).not.toContain('<captions');
		expect(after).toContain('<video id="footage"');
		expect(storage.size).toBe(0);
	});
});
