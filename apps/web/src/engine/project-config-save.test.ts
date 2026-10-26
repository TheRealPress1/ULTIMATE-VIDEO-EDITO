import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entity, World } from 'koota';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), register: vi.fn() }));
vi.mock('@/projects/host', () => ({ readProjectConfig: mocks.read, writeProjectConfig: mocks.write }));
vi.mock('@/projects/edits', () => ({ registerProjectSaveParticipant: mocks.register }));
vi.mock('@diffusionstudio/runtime', () => ({ Source: 'source' }));
vi.mock('@diffusionstudio/jsx', () => ({ parseSource: () => ({ locator: 'scene' }) }));
vi.mock('@diffusionstudio/koota-solid', () => ({ useTrait: vi.fn(), useWorld: vi.fn() }));
vi.mock('./traits', () => ({ ProjectConfig: 'project-config' }));
import { ProjectConfig } from './project-config';

const world = { get: () => null, set: vi.fn() } as unknown as World;
const scene = { get: () => ({ value: 'index.tsx:scene' }) } as unknown as Entity;
let storage: Map<string, string>;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.register.mockReturnValue(vi.fn());
	mocks.read.mockResolvedValue({});
	mocks.write.mockResolvedValue(undefined);
	storage = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => { storage.set(key, value); },
		removeItem: (key: string) => { storage.delete(key); },
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('project settings durability', () => {
	it('reports a save failure to the caller and the shared save participant', async () => {
		const config = new ProjectConfig(world, '/project');
		await config.load();
		mocks.write.mockRejectedValueOnce(new Error('Disk full'));
		await expect(config.setExport(scene, { format: 'mp4' })).rejects.toThrow('Disk full');
		const participant = mocks.register.mock.calls[0]![1];
		expect(participant.state()).toMatchObject({ status: 'error', error: 'Disk full' });
		await participant.retry();
		expect(mocks.write).toHaveBeenCalledTimes(2);
		expect(participant.state().status).toBe('saved');
		config.dispose();
	});

	it('preserves new settings while an older external reload is still reading', async () => {
		const config = new ProjectConfig(world, '/project');
		await config.load();
		let resolve!: (value: unknown) => void;
		mocks.read.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
		const loading = config.load();
		await Promise.resolve();
		await config.setExport(scene, { video: { resolution: 2160 } });
		resolve({ export: { scene: { video: { resolution: 720 } } } });
		await loading;
		expect(config.exportOf(scene)?.video?.resolution).toBe(2160);
		config.dispose();
	});

	it('recovers pending settings before reading or displaying the disk settings', async () => {
		storage.set('cutroom:pending-value:v1:config:/project', JSON.stringify({ version: 1, value: { export: { scene: { format: 'webm' } } } }));
		let written = false;
		mocks.write.mockImplementation(async () => { written = true; });
		mocks.read.mockImplementation(async () => {
			expect(written).toBe(true);
			return { export: { scene: { format: 'webm' } } };
		});
		const config = new ProjectConfig(world, '/project');
		await config.load();
		expect(config.exportOf(scene)?.format).toBe('webm');
		expect(storage.size).toBe(0);
		config.dispose();
	});

	it('keeps loaded settings after a failed external read and refuses a replacement until a fresh read succeeds', async () => {
		mocks.read.mockResolvedValueOnce({ custom: { keep: true }, export: { scene: { video: { resolution: 2160 } } } });
		const config = new ProjectConfig(world, '/project');
		await config.load();
		mocks.read.mockRejectedValue(new Error('Drive disconnected'));
		await expect(config.load()).rejects.toThrow('Drive disconnected');
		expect(config.exportOf(scene)?.video?.resolution).toBe(2160);
		await expect(config.setExport(scene, { format: 'webm' })).rejects.toThrow('Drive disconnected');
		expect(mocks.write).not.toHaveBeenCalled();
		expect(config.exportOf(scene)?.video?.resolution).toBe(2160);

		mocks.read.mockResolvedValue({ custom: { keep: 'fresh external value' }, export: { scene: { video: { resolution: 1080 } } } });
		await config.setExport(scene, { format: 'webm' });
		expect(mocks.write).toHaveBeenCalledWith('/project', { custom: { keep: 'fresh external value' }, export: { scene: { format: 'webm' } } });
		config.dispose();
	});

	it('cannot initialize or save export settings using defaults after the first read fails', async () => {
		const config = new ProjectConfig(world, '/project');
		mocks.read.mockRejectedValue(new Error('Unreadable settings'));
		await expect(config.load()).rejects.toThrow('Unreadable settings');
		await expect(config.markInitialized()).rejects.toThrow('Unreadable settings');
		await expect(config.setExport(scene, { format: 'mp4' })).rejects.toThrow('Unreadable settings');
		expect(config.loaded()).toBe(false);
		expect(config.initialized()).toBe(false);
		expect(mocks.write).not.toHaveBeenCalled();
		expect(storage.size).toBe(0);
		config.dispose();
	});

	it.each([[], 'invalid', 3, false])('preserves malformed existing settings instead of replacing them with defaults: %j', async (value) => {
		const config = new ProjectConfig(world, '/project');
		mocks.read.mockResolvedValue(value);
		await expect(config.load()).rejects.toThrow('existing settings have been kept');
		await expect(config.setExport(scene, { format: 'mp4' })).rejects.toThrow('existing settings have been kept');
		expect(config.loaded()).toBe(false);
		expect(mocks.write).not.toHaveBeenCalled();
		expect(storage.size).toBe(0);
		config.dispose();
	});
});
