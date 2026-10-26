import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entity, World } from 'koota';

const mocks = vi.hoisted(() => ({ flush: vi.fn(), compile: vi.fn() }));
vi.mock('@/projects/edits', () => ({ flushProjectEdits: mocks.flush }));
vi.mock('@/projects', () => ({ isDesktop: () => true, compileProject: mocks.compile }));
vi.mock('@/lib/db', () => ({ loadProjectBundle: vi.fn() }));
vi.mock('@diffusionstudio/reconciler', () => ({ mount: vi.fn() }));
vi.mock('@diffusionstudio/runtime', () => ({}));

import { createCapture } from './capture';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flush.mockResolvedValue(undefined);
	// Stop after the compile boundary: these tests exercise save ordering,
	// not the DOM/video renderer covered by the export tests.
	mocks.compile.mockResolvedValue({ ok: false, error: 'Compile reached' });
});

describe('capture save barrier', () => {
	it('waits for the last edit before compiling source for export', async () => {
		let release!: () => void;
		mocks.flush.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
		const capture = createCapture({} as World, {} as Entity, { dir: '/project' });
		expect(mocks.flush).toHaveBeenCalledWith('/project');
		expect(mocks.compile).not.toHaveBeenCalled();
		release();
		await expect(capture).rejects.toThrow('Compile reached');
		expect(mocks.compile).toHaveBeenCalledWith('/project');
	});

	it('refuses capture when edits have not been saved', async () => {
		mocks.flush.mockRejectedValue(new Error('Drive disconnected'));
		await expect(createCapture({} as World, {} as Entity, { dir: '/project' })).rejects.toThrow('Drive disconnected');
		expect(mocks.compile).not.toHaveBeenCalled();
	});
});
