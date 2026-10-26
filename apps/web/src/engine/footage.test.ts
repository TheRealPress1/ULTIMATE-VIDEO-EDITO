import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@diffusionstudio/assets';
import type { World } from 'koota';
import type { TranscriptCutOptions } from './transcript-cut';

const mocks = vi.hoisted(() => ({ library: vi.fn(), file: vi.fn(), call: vi.fn(), transcribe: vi.fn(), session: vi.fn(), cut: vi.fn() }));
vi.mock('@diffusionstudio/runtime', () => ({ getLibrary: mocks.library, getAssetFile: mocks.file }));
vi.mock('@desktop/main-channels', () => ({ MAIN_CHANNELS: { FOOTAGE_INDEX_GET: 'get', FOOTAGE_INDEX_PUT: 'put', FOOTAGE_INDEX_CANCEL: 'cancel' } }));
vi.mock('@/lib/ipc', () => ({ mainBridge: { call: mocks.call } }));
vi.mock('@/lib/local-transcription', () => ({ MAX_TRANSCRIPTION_SECONDS: 7200, transcribeLocally: mocks.transcribe }));
vi.mock('@/dapi/session', () => ({ editorSession: mocks.session }));
vi.mock('./transcript-cut', () => ({ createTranscriptCut: mocks.cut }));

import { FootageService, disposeFootageService, getFootageService } from './footage';

const transcript = [{ text: 'Original words.', words: [{ text: 'Original', start: 1, end: 2 }, { text: 'words.', start: 2, end: 3 }] }];
const result = (indexed: boolean, fingerprint = 'hash') => ({ fingerprint, transcript: indexed ? transcript : null, engine: 'whisper-base-v1', indexedAt: indexed ? '2026-10-25' : null });
const ref = { assetId: 'video', fingerprint: 'hash', sourceIn: 1, sourceOut: 3 };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function fixture(indexed = false) {
	const world = {} as World;
	const asset = { id: 'video', path: 'Interview.mp4', source: '/media/Interview.mp4', type: 'VIDEO', duration: 30, width: 1920, height: 1080, handle: {} } as Asset;
	const assets = [asset];
	const library = {
		list: () => assets,
		get: (key: string) => assets.find((item) => item.id === key || item.path === key),
		bySource: (source: string) => assets.find((item) => item.source === source),
	};
	mocks.library.mockReturnValue(library);
	mocks.session.mockReturnValue({ world, project: { dir: () => '/project' } });
	mocks.call.mockImplementation(async (channel: string) => result(channel === 'put' || indexed));
	mocks.transcribe.mockResolvedValue(transcript);
	mocks.file.mockResolvedValue(new Blob(['audio']));
	mocks.cut.mockImplementation(async (_world: World, _dir: string, _passages: unknown, options: TranscriptCutOptions) => {
		options.assertCurrent?.();
		await options.validateSources?.();
		options.assertCurrent?.();
		return { sceneId: 'project.tsx:10', duration: 2, clipCount: 1 };
	});
	return { world, asset, assets, library, service: new FootageService(world, '/project') };
}
beforeEach(() => vi.clearAllMocks());

describe('persistent footage service', () => {
	it('cancels an initial source hash when indexing is waiting for library loading', async () => {
		const f = fixture(), pending = deferred<ReturnType<typeof result>>();
		mocks.call.mockImplementation((channel) => channel === 'get' ? pending.promise : Promise.resolve(undefined));
		const loading = f.service.load(); const loadingRejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' }); const controller = new AbortController();
		const task = f.service.indexPaths(undefined, controller.signal);
		const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledWith('get', expect.any(Object)));
		controller.abort(); expect(mocks.call).toHaveBeenCalledWith('cancel', expect.objectContaining({ id: expect.any(String) }));
		pending.resolve(result(false)); await loadingRejected; await rejected;
		expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it('loads persisted transcripts across service restarts without retranscribing', async () => {
		const f = fixture(true);
		await f.service.indexAll();
		expect(f.service.search('original')[0]).toMatchObject({ ...ref, text: 'Original words.' });
		const reopened = new FootageService(f.world, '/project');
		await reopened.load();
		expect(reopened.search('original')).toEqual(f.service.search('original'));
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.file).not.toHaveBeenCalled();
	});

	it('reads fresh media and commits transcription with the fingerprint checked before reading', async () => {
		const f = fixture();
		await f.service.indexPaths(['Interview.mp4']);
		expect(mocks.file).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: f.asset.source }), true);
		expect(mocks.call).toHaveBeenCalledWith('put', expect.objectContaining({ dir: '/project', source: f.asset.source, duration: 30, expectedFingerprint: 'hash', transcript }));
		expect(f.service.snapshot().items[0]).toMatchObject({ status: 'ready', fingerprint: 'hash' });
	});

	it('does not commit transcript results after cancellation', async () => {
		const f = fixture();
		const pending = deferred<typeof transcript>();
		mocks.transcribe.mockReturnValue(pending.promise);
		const task = f.service.indexAll();
		const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledOnce());
		f.service.cancel();
		pending.resolve(transcript);
		await rejected;
		expect(mocks.call.mock.calls.some(([channel]) => channel === 'put')).toBe(false);
		expect(f.service.snapshot()).toMatchObject({ indexing: false, error: 'Indexing stopped. Completed speech sections are saved; resume to continue.' });
	});

	it('does no disk work when the caller is already canceled', async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(f.service.indexPaths(undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
		expect(mocks.call).not.toHaveBeenCalled();
	});

	it('rejects navigation after speech recognition returns without saving in either project', async () => {
		const f = fixture();
		mocks.transcribe.mockImplementation(async () => {
			mocks.session.mockReturnValue({ world: {}, project: { dir: () => '/other' } });
			return transcript;
		});
		await expect(f.service.indexAll()).rejects.toThrow('open project changed');
		expect(mocks.call.mock.calls.some(([channel]) => channel === 'put')).toBe(false);
	});

	it('detects an in-place source relink during transcription', async () => {
		const f = fixture();
		mocks.transcribe.mockImplementation(async () => { f.asset.source = '/media/Replaced.mp4'; return transcript; });
		await f.service.indexAll();
		expect(mocks.call.mock.calls.some(([channel]) => channel === 'put')).toBe(false);
		expect(f.service.snapshot().items[0]).toMatchObject({ status: 'error', error: expect.stringContaining('moved or changed') });
	});

	it('detects in-place rename during source verification and refuses the cut', async () => {
		const f = fixture(true);
		mocks.call.mockImplementation(async () => { f.asset.path = 'Renamed.mp4'; return result(true); });
		await expect(f.service.createCut([ref])).rejects.toThrow('moved or changed');
		expect(mocks.cut).not.toHaveBeenCalled();
	});

	it('refreshes an overlapping import/removal before the shared load promise resolves', async () => {
		const f = fixture(true);
		const pending = deferred<ReturnType<typeof result>>();
		mocks.call.mockReturnValueOnce(pending.promise);
		const first = f.service.load();
		f.assets.splice(0, 1, { ...f.asset, id: 'new', path: 'New.mp4', source: '/media/New.mp4' });
		const second = f.service.load();
		expect(second).toBe(first);
		pending.resolve(result(true));
		await second;
		expect(f.service.snapshot().items.map((item) => item.assetId)).toEqual(['new']);
		expect(f.service.search('original')[0]!.assetId).toBe('new');
	});

	it('derives captions from persisted words and ignores caller-supplied invented text', async () => {
		const f = fixture(true);
		await f.service.createCut([{ ...ref, words: [{ text: 'Invented', start: 1, end: 3 }], text: 'Invented' } as typeof ref]);
		expect(mocks.cut.mock.calls[0]![2][0].words).toEqual(transcript[0]!.words);
		expect(mocks.call.mock.calls.filter(([channel]) => channel === 'get')).toHaveLength(2);
	});

	it('rejects a changed fingerprint at the final pre-insertion validation', async () => {
		const f = fixture(true);
		mocks.call.mockResolvedValueOnce(result(true)).mockResolvedValueOnce(result(false, 'changed'));
		await expect(f.service.createCut([ref])).rejects.toThrow('changed or is no longer indexed');
		expect(f.service.snapshot().items[0]).toMatchObject({ status: 'stale', fingerprint: 'changed' });
	});

	it('keeps the submitted passage range stable when the UI selection changes mid-request', async () => {
		const f = fixture(true);
		const pending = deferred<ReturnType<typeof result>>();
		mocks.call.mockReturnValueOnce(pending.promise);
		const mutable = { ...ref };
		const task = f.service.createCut([mutable]);
		mutable.sourceOut = 20;
		pending.resolve(result(true));
		await task;
		expect(mocks.cut.mock.calls[0]![2][0].sourceOut).toBe(3);
	});

	it('serializes cut/index operations and disposes the project-scoped singleton', async () => {
		const f = fixture(true);
		const pending = deferred<ReturnType<typeof result>>();
		mocks.call.mockReturnValueOnce(pending.promise);
		const service = getFootageService(f.world, '/project');
		const task = service.createCut([ref]);
		await expect(service.createCut([ref])).rejects.toThrow('current footage operation');
		await expect(service.indexAll()).rejects.toThrow('already being processed');
		pending.resolve(result(true));
		await task;
		disposeFootageService(f.world, '/project');
		expect(service.disposed).toBe(true);
		expect(getFootageService(f.world, '/project')).not.toBe(service);
	});
});
