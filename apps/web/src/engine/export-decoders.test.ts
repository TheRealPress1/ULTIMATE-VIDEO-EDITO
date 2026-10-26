import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetLibrary, AudioAsset, VideoAsset } from '@diffusionstudio/assets';
import type { World } from 'koota';

const mocks = vi.hoisted(() => ({ videoTrack: vi.fn(), canvases: vi.fn(), audioTrack: vi.fn(), buffers: vi.fn() }));
vi.mock('mediabunny', async (original) => ({
  ...await original<typeof import('mediabunny')>(),
  Input: class {
    getPrimaryVideoTrack = mocks.videoTrack;
    getPrimaryAudioTrack = mocks.audioTrack;
    dispose() {}
  },
  CanvasSink: class { canvases = mocks.canvases; },
  AudioBufferSink: class { buffers = mocks.buffers; },
}));

import { VideoExporter } from '../../../../packages/runtime/src/media/video';
import { AudioDecoder } from '../../../../packages/runtime/src/media/audio';
import type { AudioBus } from '../../../../packages/runtime/src/media/audio-bus';
import { playbackSystem } from '../../../../packages/runtime/src/systems/playback';
import { createRuntimeWorld } from '../../../../packages/runtime/src/world/create-world';
import { createEntity } from '../../../../packages/runtime/src/actions/entities';
import { Audio, AssetId, ChildOf, Computed, FramePromises, Geometry, Library, Mode, Muted, Name, Paint, Root, Scene } from '../../../../packages/runtime/src/traits';
import { PaintType } from '../../../../packages/runtime/src/constants';

const worlds: World[] = [];
beforeEach(() => {
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('HTMLCanvasElement', class {});
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Invalid image bytes')));
  mocks.videoTrack.mockResolvedValue({ getFirstTimestamp: async () => 0 });
  mocks.canvases.mockImplementation(async function* () { yield { timestamp: 0, duration: 1, canvas: {} }; });
  mocks.audioTrack.mockResolvedValue(null);
});
afterEach(() => { worlds.splice(0).forEach((world) => world.destroy()); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function asset(type: Asset['type'] = 'VIDEO'): Asset {
  return { id: crypto.randomUUID(), type, path: 'interview.mp4', source: 'footage/interview.mp4', frameRate: 30, channels: type === 'AUDIO' ? 2 : undefined, sampleRate: type === 'AUDIO' ? 48000 : undefined, duration: 1,
    handle: { getFile: async () => new File(['bytes'], 'interview.mp4') },
  } as Asset;
}

function fixture(source: Asset) {
  const world = createRuntimeWorld('export-decoders');
  worlds.push(world);
  world.set(Mode, { value: 'offline-video' });
  world.set(FramePromises, { list: [] });
  world.set(Library, { get: (id: string) => id === source.id ? source : undefined } as AssetLibrary);
  const scene = createEntity(world);
  scene.add(Scene, Geometry, ChildOf(world.get(Root)!));
  const clip = createEntity(world);
  clip.add(Geometry, Name({ value: 'Opening interview' }), AssetId({ value: source.id }), ChildOf(scene));
  if (source.type === 'AUDIO') clip.add(Audio);
  else clip.add(Paint({ value: source.type === 'IMAGE' ? PaintType.IMAGE : PaintType.VIDEO }));
  return { world, scene, clip };
}

describe('offline media failures', () => {
  it('rejects missing video instead of completing with an empty picture', async () => {
    const source = asset('VIDEO') as VideoAsset;
    source.handle.getFile = async () => { throw new Error('File was moved'); };
    const decoder = new VideoExporter(source);
    await expect(decoder.seekTo(0, 30)).rejects.toThrow('File was moved');
    decoder.dispose();
  });

  it('propagates a video decode failure with the clip and source names', async () => {
    // eslint-disable-next-line require-yield -- This decoder fails before producing its first frame.
    mocks.canvases.mockImplementation(async function* () { throw new Error('Corrupt video packet'); });
    const { world } = fixture(asset());
    playbackSystem(world);
    await expect(Promise.all(world.get(FramePromises)!.list!)).rejects.toThrow(/Opening interview.*interview.mp4.*Corrupt video packet/);
  });

  it('rejects an unreadable video track with no decoded frames', async () => {
    mocks.canvases.mockImplementation(async function* () {});
    const decoder = new VideoExporter(asset('VIDEO') as VideoAsset);
    await expect(decoder.seekTo(0, 30)).rejects.toThrow('No video frame');
    decoder.dispose();
  });

  it('lets a decoded video frame pass the barrier', async () => {
    const { world } = fixture(asset('VIDEO'));
    await expect((async () => { playbackSystem(world); await Promise.all(world.get(FramePromises)!.list!); })()).resolves.toBeUndefined();
  });

  it('rejects corrupt images after their decoder reports failed', async () => {
    const { world } = fixture(asset('IMAGE'));
    playbackSystem(world);
    await expect(Promise.all(world.get(FramePromises)!.list!)).rejects.toThrow(/Opening interview.*Image source could not be decoded/);
  });

  it('rejects missing audio tracks with a named error', async () => {
    const { world } = fixture(asset('AUDIO'));
    playbackSystem(world);
    await expect(Promise.all(world.get(FramePromises)!.list!)).rejects.toThrow(/Opening interview.*Audio track not found/);
  });

  it.each(['empty', 'corrupt'] as const)('does not silently render an %s audio decode', async (kind) => {
    mocks.audioTrack.mockResolvedValue({ computeDuration: async () => 1 });
    // eslint-disable-next-line require-yield -- Both fixtures intentionally produce no samples.
    mocks.buffers.mockImplementation(async function* () { if (kind === 'corrupt') throw new Error('Corrupt audio packet'); });
    const decoder = new AudioDecoder(asset('AUDIO') as AudioAsset);
    await decoder.init();
    await expect(decoder.playTo({} as AudioBus, {
      relativeFrom: 0, relativeTo: 0.5, trimStart: 0, trimEnd: 1,
      playbackRate: 1, currentTime: 0, relativeDelay: 0,
    })).rejects.toThrow(kind === 'empty' ? 'No audio samples could be decoded' : 'Corrupt audio packet');
    decoder.reset();
  });

  it('allows the silent tail after a shorter audio track ends', async () => {
    mocks.audioTrack.mockResolvedValue({ computeDuration: async () => 0.2 });
    mocks.buffers.mockImplementation(async function* () {});
    const decoder = new AudioDecoder(asset('AUDIO') as AudioAsset);
    await decoder.init();
    await expect(decoder.playTo({} as AudioBus, {
      relativeFrom: 0.5, relativeTo: 0.75, trimStart: 0, trimEnd: 1,
      playbackRate: 1, currentTime: 0.5, relativeDelay: 0,
    })).resolves.toBeUndefined();
    decoder.reset();
  });

  it.each(['outside', 'muted'] as const)('does not decode %s audio', async (reason) => {
    const { world, clip } = fixture(asset('AUDIO'));
    if (reason === 'muted') clip.add(Muted);
    else clip.set(Computed, { start: 30, end: 60 });
    playbackSystem(world);
    await Promise.all(world.get(FramePromises)!.list!);
    expect(mocks.audioTrack).not.toHaveBeenCalled();
  });
});
