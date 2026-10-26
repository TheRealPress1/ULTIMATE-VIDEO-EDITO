import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@diffusionstudio/assets';
import type { World } from 'koota';
const mocks = vi.hoisted(() => ({ library: vi.fn(), call: vi.fn(), index: vi.fn(), session: vi.fn(), firstTimestamp: vi.fn() }));
vi.mock('@diffusionstudio/runtime', () => ({ getLibrary: mocks.library }));
vi.mock('@desktop/main-channels', () => ({ MAIN_CHANNELS: { VISUAL_GET: 'get' } }));
vi.mock('@/lib/ipc', () => ({ mainBridge: { call: mocks.call } }));
vi.mock('@/lib/visual-index', () => ({ indexVisualLocally: mocks.index }));
vi.mock('@/dapi/session', () => ({ editorSession: mocks.session }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { dispose() {} getPrimaryVideoTrack = async () => ({ getFirstTimestamp: mocks.firstTimestamp }); } }));
import { VisualService, disposeVisualService, getVisualService } from './visual-footage';
const analysis = { sourceStart: 0, duration: 10, width: 1920, height: 1080, sampleInterval: 5, samples: [0, 5].map((time) => ({ time, mediaTime: time, labels: [{ text: 'bicycle', confidence: 0.9 }], text: [], people: 1 })) };
const result = (indexed: boolean, fingerprint = 'a'.repeat(64)) => ({ fingerprint, analysis: indexed ? analysis : null, indexedAt: indexed ? '2026-10-25' : null, engine: 'apple-vision-labels-ocr-v2' });
function fixture(indexed = false) {
  const world = {} as World;
  const asset = { id: 'video', path: 'Ride.mp4', source: '/media/Ride.mp4', type: 'VIDEO', sourceStart: 0, duration: 10, width: 1920, height: 1080, handle: { getFile: async () => new Blob() } } as unknown as Asset;
  const assets = [asset];
  const library = { list: () => assets, get: (key: string) => assets.find((item) => item.id === key || item.path === key), bySource: (source: string) => assets.find((item) => item.source === source) };
  mocks.library.mockReturnValue(library);
  mocks.session.mockReturnValue({ world, project: { dir: () => '/project' } });
  mocks.call.mockResolvedValue(result(indexed));
  mocks.index.mockResolvedValue(result(true));
  return { world, asset, assets, library, service: new VisualService(world, '/project') };
}
beforeEach(() => { vi.clearAllMocks(); mocks.firstTimestamp.mockResolvedValue(0); });
describe('project-scoped visual footage service', () => {
  it('loads persisted indexes across reopen without rescanning or modifying assets', async () => {
    const f = fixture(true);
    await f.service.indexPaths();
    expect(f.service.search('bike')).toHaveLength(2);
    const reopened = new VisualService(f.world, '/project'); await reopened.load();
    expect(reopened.search('bike')).toEqual(f.service.search('bike'));
    expect(mocks.index).not.toHaveBeenCalled();
    expect(f.assets).toEqual([f.asset]);
  });
  it('indexes local videos and reports per-file progress via the shared native job', async () => {
    const f = fixture(); await f.service.indexPaths(['Ride.mp4']);
    expect(mocks.index).toHaveBeenCalledWith({ dir: '/project', source: '/media/Ride.mp4', duration: 10, sourceStart: 0 }, expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }));
    expect(f.service.snapshot().items[0]).toMatchObject({ status: 'ready' });
  });
  it.each([0.033, 2, -0.033])('passes the runtime-normalized track origin %s to native cache and indexing', async (first) => {
    const f = fixture(); mocks.firstTimestamp.mockResolvedValue(first);
    await f.service.indexPaths(['Ride.mp4']);
    const expected = Math.max(0, first);
    expect(mocks.call).toHaveBeenCalledWith('get', expect.objectContaining({ sourceStart: expected }));
    expect(mocks.index).toHaveBeenCalledWith(expect.objectContaining({ sourceStart: expected }), expect.any(Object));
  });
  it('waits for the native cancellation reply before releasing the busy owner', async () => {
    const f = fixture();
    let finish!: (value: ReturnType<typeof result>) => void;
    mocks.index.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = f.service.indexPaths();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.index).toHaveBeenCalledOnce());
    f.service.cancel();
    expect(f.service.snapshot().indexing).toBe(true);
    await expect(f.service.indexPaths()).rejects.toThrow('already being processed');
    finish(result(true)); await rejected;
    expect(f.service.snapshot().indexing).toBe(false);
    expect(f.service.search('bike')).toEqual([]);
  });
  it('rejects navigation or relinking during a scan without publishing evidence to another project', async () => {
    const f = fixture();
    mocks.index.mockImplementation(async () => { mocks.session.mockReturnValue({ world: {}, project: { dir: () => '/other' } }); return result(true); });
    await expect(f.service.indexPaths()).rejects.toThrow('open project changed');
    expect(f.service.search('bike')).toEqual([]);
    const g = fixture();
    mocks.index.mockImplementation(async () => { g.asset.source = '/media/replacement.mp4'; return result(true); });
    await g.service.indexPaths();
    expect(g.service.snapshot().items[0]).toMatchObject({ status: 'error', error: expect.stringContaining('moved or changed') });
  });
  it('revalidates fingerprint before preview or copying a candidate range', async () => {
    const f = fixture(true); await f.service.load(); const match = f.service.search('bike')[0]!;
    mocks.call.mockResolvedValue(result(false, 'b'.repeat(64)));
    await expect(f.service.validateMatch(match)).rejects.toThrow('source changed');
    expect(f.service.search('bike')).toEqual([]);
  });
  it('disposes shared per-world ownership on project close', () => {
    const f = fixture(); const service = getVisualService(f.world, '/project');
    expect(getVisualService(f.world, '/project')).toBe(service);
    disposeVisualService(f.world, '/project'); expect(service.disposed).toBe(true);
    expect(getVisualService(f.world, '/project')).not.toBe(service);
  });
});
