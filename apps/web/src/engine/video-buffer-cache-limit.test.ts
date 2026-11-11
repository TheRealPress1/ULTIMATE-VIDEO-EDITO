import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoAsset } from '@diffusionstudio/assets';
const mocks = vi.hoisted(() => ({ videoTrack: vi.fn() }));
vi.mock('mediabunny', async (original) => ({ ...await original<typeof import('mediabunny')>(),
  Input: class { getPrimaryVideoTrack = mocks.videoTrack; dispose() {} },
  EncodedPacketSink: class {}, CanvasSink: class {},
}));
vi.mock('../../../../packages/runtime/src/media/keyframe-index', () => ({ getKeyframeIndex: () => ({ floor: () => null }) }));
import { clearVideoTrackCache, VideoBuffer } from '../../../../packages/runtime/src/media/video';

const buffers: VideoBuffer[] = [];
async function open(id: string) {
  const asset = { id, type: 'VIDEO', path: `clips/${id}.MOV`, source: `/media/${id}.MOV`, duration: 7, width: 1080, height: 1920, frameRate: 30,
    stat: { size: 1, mtime: 1 }, handle: { getFile: async () => new File(['bytes'], `${id}.MOV`) } } as VideoAsset;
  const buffer = new VideoBuffer(asset); buffers.push(buffer);
  await buffer.initialized;
  buffer.packetSink = { getKeyPacket: async () => null } as unknown as typeof buffer.packetSink;
  return buffer;
}
const modes = () => buffers.map((buffer) => buffer.mode);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.stubGlobal('OffscreenCanvas', class { width = 0; height = 0; getContext = () => ({ clearRect() {} }); });
  vi.stubGlobal('VideoDecoder', class { static isConfigSupported = async () => ({ supported: true }); });
  mocks.videoTrack.mockResolvedValue({ getFirstTimestamp: async () => 0, getDecoderConfig: async () => ({ codec: 'avc1' }), rotation: 0 });
});
afterEach(() => {
  buffers.splice(0).forEach((buffer) => buffer.dispose());
  clearVideoTrackCache(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('buffers holding a decoder and frame cache', () => {
  it('release the ones the playhead left behind once more than eight are live', async () => {
    for (let i = 0; i < 12; i++) await open(`clip-${i}`);
    // A drag across the timeline: each clip is touched once, a fifth of a second apart.
    for (const buffer of buffers) { buffer.seekTo(30, 30); await vi.advanceTimersByTimeAsync(200); }

    expect(modes()).toEqual([...Array(4).fill('idle'), ...Array(8).fill('alive')]);
  });

  it('keep every buffer that is still in use', async () => {
    for (let i = 0; i < 12; i++) await open(`clip-${i}`);
    // Twelve clips all touched within a tenth of a second are all playing.
    for (const buffer of buffers) { buffer.seekTo(30, 30); await vi.advanceTimersByTimeAsync(8); }

    expect(modes()).toEqual(Array(12).fill('alive'));
  });

  it('never release one that is still waiting on a seek', async () => {
    for (let i = 0; i < 10; i++) await open(`clip-${i}`);
    // The first clip's seek is still running when the playhead is long gone from it.
    buffers[0]!.packetSink = { getKeyPacket: () => new Promise(() => {}) } as unknown as typeof buffers[0]['packetSink'];
    for (const buffer of buffers) { buffer.seekTo(30, 30); await vi.advanceTimersByTimeAsync(200); }

    expect(modes()).toEqual(['alive', 'idle', 'idle', ...Array(7).fill('alive')]);
  });

  it('do not count a buffer that has been disposed', async () => {
    for (let i = 0; i < 9; i++) await open(`clip-${i}`);
    for (const buffer of buffers.slice(0, 8)) { buffer.seekTo(30, 30); await vi.advanceTimersByTimeAsync(200); }
    buffers[0]!.dispose();
    buffers[8]!.seekTo(30, 30);

    expect(modes()).toEqual(['discarded', ...Array(8).fill('alive')]);
  });

  it('wake a released buffer when the playhead comes back to it', async () => {
    for (let i = 0; i < 10; i++) await open(`clip-${i}`);
    for (const buffer of buffers) { buffer.seekTo(30, 30); await vi.advanceTimersByTimeAsync(200); }
    expect(buffers[0]!.mode).toBe('idle');

    buffers[0]!.seekTo(60, 30);

    expect(buffers[0]!.mode).toBe('alive');
    // Waking it pushes the limit again, and the buffer left behind longest goes instead.
    expect(buffers[1]!.mode).toBe('idle');
  });
});
