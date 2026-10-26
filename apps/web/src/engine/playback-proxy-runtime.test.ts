import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetLibrary, VideoAsset } from '@diffusionstudio/assets';
import type { World } from 'koota';
const mocks = vi.hoisted(() => ({ videoTrack: vi.fn(), canvases: vi.fn() }));
vi.mock('mediabunny', async (original) => ({ ...await original<typeof import('mediabunny')>(),
  Input: class { getPrimaryVideoTrack = mocks.videoTrack; dispose() {} },
  EncodedPacketSink: class {}, CanvasSink: class { canvases = mocks.canvases; },
}));
vi.mock('../../../../packages/runtime/src/media/keyframe-index', () => ({ getKeyframeIndex: () => ({ floor: () => null }) }));
import { clearVideoTrackCache, resolveVideoDecoder, VideoBuffer, VideoExporter } from '../../../../packages/runtime/src/media/video';
import { playbackAssetIdentity, playbackProxyFor } from '../../../../packages/runtime/src/media/playback-proxy';
import { createRuntimeWorld } from '../../../../packages/runtime/src/world/create-world';
import { createEntity } from '../../../../packages/runtime/src/actions/entities';
import { AssetId, Library, Mode, PlaybackProxies } from '../../../../packages/runtime/src/traits';

const worlds: World[] = [];
const decoders: Array<VideoBuffer | VideoExporter> = [];
beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', class { width = 0; height = 0; getContext = () => ({ clearRect() {} }); });
  vi.stubGlobal('VideoDecoder', class { static isConfigSupported = async () => ({ supported: true }); });
  mocks.videoTrack.mockResolvedValue({ getFirstTimestamp: async () => 0, getDecoderConfig: async () => ({ codec: 'avc1' }), rotation: 0 });
  mocks.canvases.mockImplementation(async function* () { yield { timestamp: 0, duration: 1, canvas: {} }; });
});
afterEach(() => { decoders.splice(0).forEach((decoder) => decoder.dispose()); worlds.splice(0).forEach((world) => world.destroy()); clearVideoTrackCache(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function asset(id = 'original'): VideoAsset {
  return { id, type: 'VIDEO', path: 'interview.mov', source: `/media/${id}.mov`, duration: 300, width: 3840, height: 2160, frameRate: 29.97,
    stat: { size: 1234, mtime: 50 }, handle: { getFile: async () => new File(['bytes'], `${id}.mov`) } } as VideoAsset;
}
function fixture() {
  const source = asset(); const proxy = { ...asset('proxy'), width: 1280, height: 720 };
  const world = createRuntimeWorld('proxy-test'); worlds.push(world);
  world.set(Library, { get: (id: string) => id === source.id ? source : undefined } as AssetLibrary);
  const onFailure = vi.fn();
  const state = { enabled: true, entries: new Map([[source.id, { asset: proxy, identity: playbackAssetIdentity(source), onFailure }]]) };
  world.set(PlaybackProxies, state);
  const clip = createEntity(world); clip.add(AssetId({ value: source.id }));
  const resolve = () => { const decoder = resolveVideoDecoder(world, clip) as VideoBuffer | VideoExporter; decoders.push(decoder); return decoder; };
  return { world, source, proxy, state, onFailure, clip, resolve };
}
describe('playback-only decoder selection', () => {
  it('keeps original dimensions, timing metadata and library source while decoding the derivative', async () => {
    const f = fixture(); const decoder = f.resolve() as VideoBuffer; await decoder.initialized;
    expect(decoder).toBeInstanceOf(VideoBuffer);
    expect(decoder.asset).toBe(f.source);
    expect(decoder.asset.width).toBe(3840);
    expect(decoder.asset.frameRate).toBe(29.97);
    expect(decoder.playbackSource).toBe(f.proxy);
    expect(f.world.get(Library)!.get(f.source.id)).toBe(f.source);
  });
  it.each(['offline-video', 'offline-audio'] as const)('replaces an existing preview decoder with original media in %s', async (mode) => {
    const f = fixture(); const preview = f.resolve() as VideoBuffer; await preview.initialized;
    f.world.set(Mode, { value: mode });
    const offline = f.resolve(); await offline.initialized;
    expect(offline).toBeInstanceOf(VideoExporter);
    expect(offline.asset).toBe(f.source);
    expect(preview.mode).toBe('discarded');
    f.world.set(Mode, { value: 'realtime' });
    expect(f.resolve()).toBeInstanceOf(VideoBuffer);
  });
  it('invalidates in-place relinks and source stat changes', () => {
    const f = fixture();
    expect(playbackProxyFor('realtime', f.source, f.state)?.asset).toBe(f.proxy);
    f.source.source = '/media/relinked.mov';
    expect(playbackProxyFor('realtime', f.source, f.state)).toBeUndefined();
    f.source.source = '/media/original.mov'; f.source.stat!.mtime++;
    expect(playbackProxyFor('realtime', f.source, f.state)).toBeUndefined();
    expect(playbackProxyFor('offline-video', f.source, f.state)).toBeUndefined();
  });
  it('falls back once when a derivative fails and respects the original playback control', async () => {
    const f = fixture(); const preview = f.resolve() as VideoBuffer; await preview.initialized; preview.errored = true;
    const fallback = f.resolve() as VideoBuffer;
    expect(fallback.playbackSource).toBe(f.source);
    expect(f.state.entries.size).toBe(0); expect(f.onFailure).toHaveBeenCalledOnce();
    f.state.entries.set(f.source.id, { asset: f.proxy, identity: playbackAssetIdentity(f.source), onFailure: f.onFailure });
    f.state.enabled = false;
    expect(f.resolve()).toBe(fallback);
  });
  it('maps normalized proxy PTS to the same trimmed and speed-adjusted source frame', async () => {
    const f = fixture();
    const preview = f.resolve() as VideoBuffer; await preview.initialized;
    const original = new VideoBuffer(f.source); decoders.push(original); await original.initialized;
    // First real source frame follows a 2s MP4 empty edit; native proxy starts at 0.
    original.firstPacketTimestamp = 2; preview.firstPacketTimestamp = 0;
    type Clock = { framesToSeconds(frame: number): number; secondsToFrames(seconds: number): number };
    const a = original as unknown as Clock; const b = preview as unknown as Clock;
    // Playback system already applies clip trim and speed before decoder.seekTo.
    const trimmedTime = 17 + 5 * 1.5;
    const frame = Math.round(trimmedTime * f.source.frameRate);
    expect(a.framesToSeconds(frame) - b.framesToSeconds(frame)).toBeCloseTo(2, 8);
    expect(a.secondsToFrames(2 + trimmedTime)).toBe(b.secondsToFrames(trimmedTime));
  });
  it('does not resurrect a buffer disposed during asynchronous initialization', async () => {
    let finish!: (value: unknown) => void;
    mocks.videoTrack.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const f = fixture(); const preview = f.resolve() as VideoBuffer;
    await vi.waitFor(() => expect(mocks.videoTrack).toHaveBeenCalled());
    preview.dispose(); finish({ getFirstTimestamp: async () => 0, getDecoderConfig: async () => ({ codec: 'avc1' }), rotation: 0 });
    await preview.initialized;
    expect(preview.mode).toBe('discarded'); expect(preview.packetSink).toBeNull();
  });
  it('falls back after a packet read fails during playback', async () => {
    const f = fixture(); const preview = f.resolve() as VideoBuffer; await preview.initialized;
    preview.packetSink = { getKeyPacket: async () => { throw new Error('Cache file was removed'); } } as unknown as typeof preview.packetSink;
    preview.seekTo(20, 30);
    await vi.waitFor(() => expect(preview.errored).toBe(true));
    expect((f.resolve() as VideoBuffer).playbackSource).toBe(f.source);
    expect(f.onFailure).toHaveBeenCalledOnce();
  });
  it('does not restart packet decoding when a pending seek resolves after disposal', async () => {
    const f = fixture(); const preview = f.resolve() as VideoBuffer; await preview.initialized;
    let finish!: (packet: unknown) => void; const packets = vi.fn();
    preview.packetSink = { getKeyPacket: () => new Promise((resolve) => { finish = resolve; }), packets } as unknown as typeof preview.packetSink;
    preview.seekTo(20, 30); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    preview.dispose(); finish({ timestamp: 0, type: 'key' });
    await Promise.resolve(); await Promise.resolve();
    expect(packets).not.toHaveBeenCalled(); expect(preview.mode).toBe('discarded');
  });
});
