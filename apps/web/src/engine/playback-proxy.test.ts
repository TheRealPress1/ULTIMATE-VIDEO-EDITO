import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoAsset } from '@diffusionstudio/assets';
import type { World } from 'koota';
import type { PlaybackProxyRequest, PlaybackProxyResult } from '@desktop/playback-proxy-types';
const mocks = vi.hoisted(() => ({ library: vi.fn(), call: vi.fn(), prepare: vi.fn(), firstTimestamp: vi.fn() }));
vi.mock('@diffusionstudio/runtime', async () => ({ getLibrary: mocks.library, PlaybackProxies: 'proxies',
  ...await import('../../../../packages/runtime/src/media/playback-proxy') }));
vi.mock('@/lib/ipc', () => ({ mainBridge: { call: mocks.call } }));
vi.mock('@/lib/playback-proxy', () => ({ preparePlaybackProxy: mocks.prepare }));
vi.mock('@/lib/electron-file-handle', () => ({ ElectronFileHandle: class { constructor(readonly path: string) {} getFile = async () => new Blob(); } }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { dispose() {} getPrimaryVideoTrack = async () => ({ getFirstTimestamp: mocks.firstTimestamp }); } }));
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { PlaybackProxyService, needsPlaybackProxy } from './playback-proxy';

function source(id = 'video'): VideoAsset {
  return { id, type: 'VIDEO', path: `${id}.mov`, source: `/media/${id}.mov`, duration: 300, width: 3840, height: 2160, frameRate: 30,
    stat: { size: 500, mtime: 10 }, handle: { getFile: async () => new Blob() } } as unknown as VideoAsset;
}
function ready(request: PlaybackProxyRequest): PlaybackProxyResult {
  return { status: 'ready', fingerprint: 'a'.repeat(64), sourceSignature: 'original-stats', proxy: {
    path: '/cache/video.mp4', fingerprint: 'a'.repeat(64), sourceSignature: 'original-stats', sourceStart: request.sourceStart,
    proxyStart: 0, duration: request.duration, width: 1280, height: 720, frameRate: request.frameRate,
    sourceWidth: request.width, sourceHeight: request.height, createdAt: '2026-10-25',
  } };
}
function fixture(assets = [source()]) {
  const traits = new Map();
  const world = { set: (key: unknown, value: unknown) => traits.set(key, value), get: (key: unknown) => traits.get(key) } as unknown as World;
  const library = { list: () => assets, get: (id: string) => assets.find((asset) => asset.id === id),
    fs: { stat: vi.fn(async (path: string) => assets.find((asset) => asset.source === path)?.stat ?? null) }, load: vi.fn() };
  mocks.library.mockReturnValue(library);
  const service = new PlaybackProxyService(world, '/project');
  return { world, traits, library, assets, service };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.firstTimestamp.mockResolvedValue(0);
  mocks.call.mockImplementation(async (channel: string, request: PlaybackProxyRequest) => channel === MAIN_CHANNELS.PLAYBACK_PROXY_GET
    ? { status: 'missing', fingerprint: request.source, sourceSignature: 'original-stats' } : undefined);
  mocks.prepare.mockImplementation(async (request: PlaybackProxyRequest) => ready(request));
});
describe('project-scoped automatic playback preparation', () => {
  it('prepares high-resolution and long HD sources, leaving small clips alone', async () => {
    const hd = { ...source('hd'), width: 1920, height: 1080 };
    const small = { ...source('small'), width: 1280, height: 720 };
    const short = { ...hd, id: 'short', duration: 30 };
    expect(needsPlaybackProxy(small)).toBe(false); expect(needsPlaybackProxy(short)).toBe(false);
    const f = fixture([source(), hd, small, short]); const original = [...f.assets];
    await f.service.refresh();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(f.service.snapshot().items.map((item) => item.status)).toEqual(['ready', 'ready']);
    expect(f.assets).toEqual(original);
    const proxy = f.traits.get('proxies').entries.get('video').asset;
    expect(proxy.width).toBe(1280); expect(f.assets[0]!.width).toBe(3840);
    expect(proxy.handle).not.toBe(f.assets[0]!.handle); expect(proxy.id).not.toBe('video');
  });
  it('accepts native cache hits after reopen and does not repeatedly check unchanged media', async () => {
    const f = fixture(); await f.service.refresh(); await f.service.refresh();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.call.mock.calls.filter(([channel]) => channel === MAIN_CHANNELS.PLAYBACK_PROXY_GET)).toHaveLength(0);
    const reopened = new PlaybackProxyService(f.world, '/project'); await reopened.refresh();
    expect(reopened.snapshot().items[0]?.status).toBe('ready'); expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });
  it('accepts filesystem sub-millisecond mtime precision matching the imported File timestamp', async () => {
    const f = fixture(); f.library.fs.stat.mockResolvedValue({ size: 500, mtime: 10.731 });
    await f.service.refresh(); await f.service.verifySources();
    expect(f.service.snapshot().items[0]?.status).toBe('ready');
    expect(f.library.load).not.toHaveBeenCalled();
  });
  it('serializes preparation and yields to export until native cancellation settles', async () => {
    const f = fixture([source('a'), source('b')]);
    let finish!: () => void;
    mocks.prepare.mockImplementationOnce((request) => new Promise((resolve) => { finish = () => resolve(ready(request)); }));
    const running = f.service.refresh();
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    const signal = mocks.prepare.mock.calls[0]![1].signal as AbortSignal;
    f.service.setPaused(true); expect(signal.aborted).toBe(true);
    f.service.setPaused(false);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    finish(); await running; await f.service.refresh();
    expect(mocks.prepare).toHaveBeenCalledTimes(3); // canceled a, then a and b
    expect(f.service.snapshot().items.every((item) => item.status === 'ready')).toBe(true);
  });
  it('keeps ready previews during export and defers preparation of newly imported media', async () => {
    const f = fixture(); await f.service.refresh();
    f.service.setPaused(true); f.assets.push(source('new')); await f.service.refresh();
    expect(f.traits.get('proxies').entries.has('video')).toBe(true);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    f.service.setPaused(false); await f.service.refresh();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(f.service.snapshot().items.every((item) => item.status === 'ready')).toBe(true);
  });
  it('cancels and releases only its session on navigation, ignoring a late native reply', async () => {
    const f = fixture(); let finish!: () => void;
    mocks.prepare.mockImplementationOnce((request) => new Promise((resolve) => { finish = () => resolve(ready(request)); }));
    const running = f.service.refresh(); await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    const request = mocks.prepare.mock.calls[0]![0];
    f.service.dispose(); expect(mocks.prepare.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(f.traits.get('proxies')).toBeNull();
    expect(mocks.call.mock.calls.some(([channel]) => channel === MAIN_CHANNELS.PLAYBACK_PROXY_RELEASE)).toBe(false);
    finish(); await running; await Promise.resolve();
    expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.PLAYBACK_PROXY_RELEASE, { dir: '/project', sessionId: request.sessionId });
    expect(f.service.snapshot().items[0]?.status).not.toBe('ready');
  });
  it('discards a stale relink result and prepares the replacement source', async () => {
    const f = fixture(); let finish!: () => void;
    mocks.prepare.mockImplementationOnce((request) => new Promise((resolve) => { finish = () => resolve(ready(request)); }));
    const running = f.service.refresh(); await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    f.assets[0]!.source = '/media/relinked.mov';
    void f.service.refresh(); finish(); await running; await f.service.refresh();
    expect(mocks.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ source: '/media/relinked.mov' }), expect.anything());
    expect(f.traits.get('proxies').entries.get('video').identity).toContain('/media/relinked.mov');
  });
  it('invalidates externally replaced linked files before rebuilding, without editing their source', async () => {
    const f = fixture(); await f.service.refresh();
    const stat = { size: 600, mtime: 20 }; f.library.fs.stat.mockResolvedValue(stat);
    let removedBeforeReload = false;
    f.library.load.mockImplementation(async () => { removedBeforeReload = f.traits.get('proxies').entries.size === 0; f.assets[0]!.stat = stat; });
    await f.service.verifySources();
    expect(removedBeforeReload).toBe(true); expect(f.library.load).toHaveBeenCalledOnce();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(f.assets[0]!.source).toBe('/media/video.mov');
  });
  it('uses originals when media is disconnected and does not silently retry failed preparation', async () => {
    const f = fixture(); await f.service.refresh(); f.library.fs.stat.mockResolvedValue(null);
    await f.service.verifySources();
    expect(f.traits.get('proxies').entries.size).toBe(0);
    expect(f.service.snapshot().items[0]?.status).toBe('error');
    await f.service.refresh(); expect(mocks.prepare).toHaveBeenCalledOnce();
    f.service.setEnabled(false); expect(f.traits.get('proxies').enabled).toBe(false);
  });
  it.each(['clock', 'geometry', 'duration'] as const)('rejects a proxy with mismatched %s', async (reason) => {
    const f = fixture();
    mocks.prepare.mockImplementation(async (request) => { const result = ready(request);
      if (reason === 'clock') result.proxy!.sourceStart = 2;
      if (reason === 'geometry') result.proxy!.sourceWidth = 1080;
      if (reason === 'duration') result.proxy!.duration += 5;
      return result; });
    await f.service.refresh();
    expect(f.traits.get('proxies').entries.size).toBe(0);
    expect(f.service.snapshot().items[0]?.status).toBe('error');
  });
});
