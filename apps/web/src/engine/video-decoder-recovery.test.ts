import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoAsset } from '@diffusionstudio/assets';
const mocks = vi.hoisted(() => ({ videoTrack: vi.fn(), floor: vi.fn() }));
vi.mock('mediabunny', async (original) => ({ ...await original<typeof import('mediabunny')>(),
  Input: class { getPrimaryVideoTrack = mocks.videoTrack; dispose() {} },
  EncodedPacketSink: class {}, CanvasSink: class {},
}));
vi.mock('../../../../packages/runtime/src/media/keyframe-index', () => ({ getKeyframeIndex: () => ({ floor: mocks.floor }) }));
vi.mock('../../../../packages/runtime/src/media/frame-cache', () => ({
  FrameCache: class {
    readonly atlas = {}; rotation = 0; leftFrameIndex = 0; rightFrameIndex: number; readonly frames = new Set<number>();
    constructor(readonly config: { pixels: number; count: number }) { this.rightFrameIndex = config.count - 1; }
    has(index: number) { return this.frames.has(index); }
    insert(_frame: unknown, index: number) { this.frames.add(index); }
    findNearest() { return undefined; }
    findTile() { return undefined; }
    dispose() { this.frames.clear(); }
  },
}));
import { clearVideoTrackCache, VideoBuffer } from '../../../../packages/runtime/src/media/video';

const FPS = 30;
const GOP = 28;

// An iPhone HEVC clip as measured in Electron: an IDR first, then a CRA every GOP followed by two RASL pictures.
type Kind = 'idr' | 'cra' | 'rasl' | 'trail';
type Chunk = { type: 'key' | 'delta'; kind: Kind; index: number; timestamp: number };
function packet(index: number) {
  const kind: Kind = index === 0 ? 'idr' : index % GOP === 0 ? 'cra' : index % GOP <= 2 ? 'rasl' : 'trail';
  const type = kind === 'idr' || kind === 'cra' ? 'key' as const : 'delta' as const;
  const micros = Math.round((index / FPS) * 1e6);
  return { type, timestamp: index / FPS, microsecondTimestamp: micros, toEncodedVideoChunk: (): Chunk => ({ type, kind, index, timestamp: micros }) };
}
const sink = {
  getKeyPacket: async (seconds: number) => packet(Math.floor(Math.round(seconds * FPS) / GOP) * GOP),
  packets: async function* (start: { timestamp: number }) { for (let i = Math.round(start.timestamp * FPS); i < 300; i++) yield packet(i); },
};
const keyFloor = (seconds: number) => (Math.floor(Math.round(seconds * FPS) / GOP) * GOP) / FPS;

// A hardware HEVC decoder, to the extent that matters here. After configure() or reset() it takes a keyframe first.
// A CRA that starts the stream has its RASL pictures dropped. A CRA reached by a jump on a decoder that is already
// running does not: its RASL pictures are decoded against the wrong references and the decoder stops with a
// "Decoding error." for good. A decoder holds back its newest frame until the next chunk or a flush pushes it out.
class FakeHevcDecoder {
  static instances: FakeHevcDecoder[] = [];
  static fault: ((decoder: FakeHevcDecoder, chunk: number) => 'error' | 'throw' | 'stall' | 'slow' | undefined) | null = null;
  static isConfigSupported = async () => ({ supported: true });

  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  decodeQueueSize = 0;
  readonly log: string[] = [];
  private total = 0;
  private sinceConfigure = 0;
  private keyRequired = true;
  private previous = -2;
  private leading: 'play' | 'drop' | 'broken' = 'play';
  private held: number | null = null;
  private stalled = false;
  private dequeued: (() => void) | null = null;

  constructor(private readonly init: { output(frame: { timestamp: number; close(): void }): void; error(error: unknown): void }) {
    FakeHevcDecoder.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) { if (type === 'dequeue') this.dequeued = listener; }
  configure() { this.state = 'configured'; this.keyRequired = true; this.sinceConfigure = 0; this.previous = -2; this.held = null; this.log.push('configure'); }
  reset() { this.state = 'unconfigured'; this.held = null; this.log.push('reset'); }
  close() { this.state = 'closed'; }
  async flush() { this.release(); this.keyRequired = true; }
  decode(chunk: Chunk) {
    if (this.state !== 'configured') throw new DOMException('The codec is not configured.', 'InvalidStateError');
    this.log.push(`${chunk.kind}@${chunk.index}`);
    const fault = FakeHevcDecoder.fault?.(this, ++this.total);
    if (fault === 'throw') throw new DOMException('The decoder refused the chunk.', 'InvalidStateError');
    // Takes the chunks and never answers: the queue only grows, with no output and no dequeue.
    if (fault === 'stall') this.stalled = true;
    if (this.stalled) { this.decodeQueueSize++; return; }
    // Backed up for a second, then catches up.
    if (fault === 'slow') {
      this.decodeQueueSize = 3;
      setTimeout(() => { this.decodeQueueSize = 0; this.dequeued?.(); }, 1000);
    }
    if (chunk.type === 'delta' && this.keyRequired) throw new DOMException('A key frame is required after configure() or flush().', 'DataError');

    let broken = fault === 'error';
    if (chunk.type === 'key') {
      this.keyRequired = false;
      this.leading = this.sinceConfigure === 0 ? 'drop' : chunk.index === this.previous + 1 ? 'play' : 'broken';
    } else if (chunk.kind === 'rasl') {
      broken ||= this.leading === 'broken';
    }
    this.sinceConfigure++;
    this.previous = chunk.index;

    if (broken) {
      queueMicrotask(() => {
        if (this.state === 'closed') return;
        this.state = 'closed';
        this.init.error(new DOMException('Decoding error.', 'EncodingError'));
      });
      return;
    }
    if (chunk.kind === 'rasl' && this.leading === 'drop') return;
    this.release();
    this.held = chunk.timestamp;
  }
  private release() {
    const timestamp = this.held;
    this.held = null;
    if (timestamp !== null) queueMicrotask(() => { if (this.state === 'configured') this.init.output({ timestamp, close() {} }); });
  }
}

const buffers: VideoBuffer[] = [];
function clip(): VideoAsset {
  return { id: 'iphone-hlg', type: 'VIDEO', path: 'clips/IMG_2109.MOV', source: '/media/IMG_2109.MOV', duration: 10, width: 1080, height: 1920, frameRate: FPS,
    stat: { size: 1, mtime: 1 }, handle: { getFile: async () => new File(['bytes'], 'IMG_2109.MOV') } } as VideoAsset;
}
async function open() {
  const buffer = new VideoBuffer(clip()); buffers.push(buffer);
  await buffer.initialized;
  buffer.packetSink = sink as unknown as typeof buffer.packetSink;
  return buffer;
}
const frames = (buffer: VideoBuffer) => (buffer.cache as unknown as { frames: Set<number> }).frames;
const decoders = () => FakeHevcDecoder.instances;

beforeEach(() => {
  FakeHevcDecoder.instances = []; FakeHevcDecoder.fault = null;
  mocks.floor.mockReset().mockReturnValue(null);
  vi.stubGlobal('OffscreenCanvas', class { width = 0; height = 0; getContext = () => ({ clearRect() {} }); });
  vi.stubGlobal('VideoDecoder', FakeHevcDecoder);
  mocks.videoTrack.mockResolvedValue({ getFirstTimestamp: async () => 0, getDecoderConfig: async () => ({ codec: 'hev1.2.4.L120.B0' }), rotation: 0 });
});
afterEach(() => {
  buffers.splice(0).forEach((buffer) => buffer.dispose());
  clearVideoTrackCache(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('HEVC playback after the playhead jumps', () => {
  it('starts the decoder over when a seek lands on another keyframe', async () => {
    const buffer = await open();
    buffer.seekTo(0, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(20)).toBe(true));

    buffer.seekTo(150, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(160)).toBe(true));

    expect(buffer.errored).toBe(false);
    expect(decoders()).toHaveLength(1);
    const log = decoders()[0]!.log; const jump = log.indexOf('cra@140');
    expect(log.slice(jump - 2, jump)).toEqual(['reset', 'configure']);
  });

  it('keeps decoding after scrubbing across keyframes and stopping', async () => {
    mocks.floor.mockImplementation(keyFloor);
    const buffer = await open();
    buffer.seekTo(0, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(20)).toBe(true));

    buffer.seekTo(100, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(84)).toBe(true));
    buffer.seekTo(200, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(196)).toBe(true));
    // The drag stops: the exact frame is walked to from its keyframe.
    await vi.waitFor(() => expect(frames(buffer).has(205)).toBe(true));

    expect(buffer.errored).toBe(false);
    expect(decoders()).toHaveLength(1);
  });

  it('shows the keyframe of a scrub step straight away', async () => {
    mocks.floor.mockImplementation(keyFloor);
    const buffer = await open();
    buffer.seekTo(0, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(20)).toBe(true));

    buffer.seekTo(100, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(84)).toBe(true), { timeout: 100 });
    // Nothing after the keyframe was submitted, so the decoder only gave it up when flushed.
    expect(decoders()[0]!.log.filter((entry) => entry.startsWith('trail') || entry.startsWith('rasl')).some((entry) => entry.endsWith('@85'))).toBe(false);
  });
});

describe('a decoder that fails', () => {
  it('is restarted instead of leaving the clip frozen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeHevcDecoder.fault = (decoder, chunk) => (decoder === decoders()[0] && chunk === 6 ? 'error' : undefined);
    const buffer = await open();

    buffer.seekTo(0, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(20)).toBe(true));

    expect(buffer.errored).toBe(false);
    expect(decoders()).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('clips/IMG_2109.MOV');
    expect(error).not.toHaveBeenCalled();
  });

  it('is restarted when it refuses a chunk outright', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    FakeHevcDecoder.fault = (decoder, chunk) => (decoder === decoders()[0] && chunk === 3 ? 'throw' : undefined);
    const buffer = await open();

    buffer.seekTo(0, FPS);
    await vi.waitFor(() => expect(frames(buffer).has(20)).toBe(true));

    expect(buffer.errored).toBe(false);
    expect(decoders()).toHaveLength(2);
  });

  it('gets its allowance back each time the preview receives the frame it asked for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Five decoders in a row each deliver the target frame, then fail. More failures than the allowance, never in a row without a frame.
    FakeHevcDecoder.fault = (decoder, chunk) => (decoders().indexOf(decoder) < 5 && chunk === 6 ? 'error' : undefined);
    const buffer = await open();

    buffer.seekTo(0, FPS);
    await vi.waitFor(() => expect(decoders()).toHaveLength(6));
    await vi.waitFor(() => expect(frames(buffer).has(20)).toBe(true));

    expect(buffer.errored).toBe(false);
  });

  it('is restarted when it stops responding without an error', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    FakeHevcDecoder.fault = (decoder, chunk) => (decoder === decoders()[0] && chunk === 3 ? 'stall' : undefined);
    const buffer = await open();

    buffer.seekTo(0, FPS);
    await vi.advanceTimersByTimeAsync(5000);

    expect(buffer.errored).toBe(false);
    expect(decoders()).toHaveLength(2);
    expect(frames(buffer).has(20)).toBe(true);
    expect(warn.mock.calls[0]![0]).toContain('stopped responding');
  });

  it('is left alone while it is merely slow', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    FakeHevcDecoder.fault = (decoder, chunk) => (decoder === decoders()[0] && chunk === 3 ? 'slow' : undefined);
    const buffer = await open();

    buffer.seekTo(0, FPS);
    await vi.advanceTimersByTimeAsync(5000);

    expect(decoders()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(frames(buffer).has(20)).toBe(true);
  });

  it('counts a scrub keyframe the preview was waiting for as a frame that arrived', async () => {
    const buffer = await open();
    const inner = buffer as unknown as { decoderFailures: number; currentFrame: number; pendingScrub: Set<number>; frameCallback(frame: { timestamp: number; close(): void }): void };
    const frame = (index: number) => ({ timestamp: Math.round((index / FPS) * 1e6), close() {} });
    inner.currentFrame = 100;

    inner.decoderFailures = 3;
    inner.frameCallback(frame(10));
    expect(inner.decoderFailures).toBe(3);

    inner.pendingScrub.add(84);
    inner.frameCallback(frame(84));
    expect(inner.decoderFailures).toBe(0);

    inner.decoderFailures = 2;
    inner.frameCallback(frame(102));
    expect(inner.decoderFailures).toBe(0);
  });

  it('is reported as failed once restarting stops helping', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeHevcDecoder.fault = () => 'error';
    const buffer = await open();

    buffer.seekTo(0, FPS);
    await vi.advanceTimersByTimeAsync(3000);

    expect(buffer.errored).toBe(true);
    expect(decoders()).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('clips/IMG_2109.MOV');
  });

  it('does not restart a buffer that has been disposed', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    FakeHevcDecoder.fault = () => 'error';
    const buffer = await open();

    buffer.seekTo(0, FPS);
    await vi.advanceTimersByTimeAsync(10);
    buffer.dispose();
    const count = decoders().length;
    await vi.advanceTimersByTimeAsync(3000);

    expect(decoders()).toHaveLength(count);
  });
});
