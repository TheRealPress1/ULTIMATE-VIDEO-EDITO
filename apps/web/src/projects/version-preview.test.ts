import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '@/engine/create-engine';
import { captureVersionPreview, createVersionPreview, versionPreviewFrame } from './version-preview';

const mocks = vi.hoisted(() => ({ active: vi.fn(), capture: vi.fn(), encoder: vi.fn() }));
vi.mock('@diffusionstudio/runtime', () => ({ Computed: 'computed', FrameRate: 'fps', Workarea: 'workarea', getActiveEntity: mocks.active, isScene: () => true }));
vi.mock('@/engine/capture', () => ({ createCapture: mocks.capture }));
vi.mock('@diffusionstudio/encoder', () => ({ createImageEncoder: mocks.encoder }));

const bitmap = { width: 1920, height: 1080, close: vi.fn() };
let canvases: Array<{ width: number; height: number; getContext: ReturnType<typeof vi.fn>; toDataURL: ReturnType<typeof vi.fn> }>;
let encode: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	bitmap.width = 1920; bitmap.height = 1080;
	canvases = [];
	encode = vi.fn().mockReturnValue('data:image/png;base64,small');
	vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
	vi.stubGlobal('document', { createElement: vi.fn(() => {
		const canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage: vi.fn() })), toDataURL: encode };
		canvases.push(canvas); return canvas;
	}) });
});

afterEach(() => vi.unstubAllGlobals());

describe('saved version canvas previews', () => {
	it('keeps a missing image optional without allocating a decoder or canvas', async () => {
		await expect(createVersionPreview(async () => null)).resolves.toBeUndefined();
		expect(createImageBitmap).not.toHaveBeenCalled();
		expect(canvases).toHaveLength(0);
	});
	it('bounds landscape preview width while retaining aspect and releases the bitmap', async () => {
		await expect(createVersionPreview(async () => new Blob(['image']))).resolves.toBe('data:image/png;base64,small');
		expect(canvases[0]).toMatchObject({ width: 960, height: 540 });
		expect(bitmap.close).toHaveBeenCalledOnce();
	});
	it('reduces oversized encoded data and omits a preview when every bounded attempt remains too large', async () => {
		encode.mockReturnValue('x'.repeat(1_000_001));
		await expect(createVersionPreview(async () => new Blob(['image']))).resolves.toBeUndefined();
		expect(canvases.length).toBeLessThanOrEqual(4);
		expect(canvases.at(-1)!.width).toBeLessThan(canvases[0]!.width);
		expect(bitmap.close).toHaveBeenCalledOnce();
	});
	it('releases decoded pixels even when encoding fails so saving can fall back without a preview', async () => {
		encode.mockImplementation(() => { throw new Error('Canvas unavailable'); });
		await expect(createVersionPreview(async () => new Blob(['image']))).rejects.toThrow('Canvas unavailable');
		expect(bitmap.close).toHaveBeenCalledOnce();
	});
});

describe('active scene version previews', () => {
  function fixture() {
    const current = { localTime: 720, end: 1800, duration: 1800 };
    const scene = { isAlive: () => true, get: (trait: string) => trait === 'computed' ? current : trait === 'workarea' ? { start: 300, end: 1500 } : undefined };
    const world = { get: () => ({ value: 60 }) };
    const engine = { world, snapshot: vi.fn(async () => new Blob(['canvas fallback'])) } as unknown as Pick<Engine, 'world' | 'snapshot'>;
    const target = { world: { name: 'offline world' }, dispose: vi.fn() };
    const encoder = { bounds: { width: 1080, height: 1920 }, resize: vi.fn(), render: vi.fn(async () => ({ type: 'success', data: [{ png: new Uint8Array([1, 2, 3]), timecode: '12s00f' }] })) };
    mocks.active.mockReturnValue(scene); mocks.capture.mockResolvedValue(target); mocks.encoder.mockResolvedValue(encoder);
    return { engine, scene, current, world, target, encoder };
  }

  it('maps seconds using the capture frame rate and subtracts the workarea origin exactly once', () => {
    expect(versionPreviewFrame(12, 60, 300, 1800)).toBe(420);
    expect(versionPreviewFrame(12, 24, 120, 720)).toBe(168);
    expect(versionPreviewFrame(2, 30, 150, 900)).toBe(-90);
    expect(versionPreviewFrame(30, 30, 150, 900)).toBe(749);
  });

  it('renders only the active scene at its original clock without invoking the live canvas', async () => {
    const f = fixture();
    await expect(captureVersionPreview(f.engine, '/project')).resolves.toBe('data:image/png;base64,small');
    expect(mocks.capture).toHaveBeenCalledWith(f.world, f.scene, { dir: '/project', frameRate: 60 });
    expect(mocks.encoder).toHaveBeenCalledWith(f.target.world, { frames: [420], resolution: 720 });
    expect(f.encoder.resize).toHaveBeenCalledWith(960);
    expect(f.current.localTime).toBe(720);
    expect(f.engine.snapshot).not.toHaveBeenCalled();
    expect(f.target.dispose).toHaveBeenCalledOnce();
  });

  it('preserves the initial playback position while compilation is pending', async () => {
    const f = fixture();
    mocks.capture.mockImplementation(async () => { f.current.localTime = 900; return f.target; });
    await captureVersionPreview(f.engine, '/project');
    expect(mocks.encoder).toHaveBeenCalledWith(f.target.world, { frames: [420], resolution: 720 });
  });

  it('falls back to a canvas preview when no scene is active', async () => {
    const f = fixture(); mocks.active.mockReturnValue(null);
    await expect(captureVersionPreview(f.engine, '/project')).resolves.toBe('data:image/png;base64,small');
    expect(f.engine.snapshot).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('disposes an offline world when encoder setup fails before using the canvas fallback', async () => {
    const f = fixture(); mocks.encoder.mockRejectedValueOnce(new Error('Media unavailable'));
    await expect(captureVersionPreview(f.engine, '/project')).resolves.toBe('data:image/png;base64,small');
    expect(f.target.dispose).toHaveBeenCalledOnce();
    expect(f.engine.snapshot).toHaveBeenCalledOnce();
    expect(f.target.dispose.mock.invocationCallOrder[0]).toBeLessThan((f.engine.snapshot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it('disposes an offline world when rendering fails before using the canvas fallback', async () => {
    const f = fixture(); f.encoder.render.mockResolvedValueOnce({ type: 'error', error: new Error('Decode failed') } as never);
    await expect(captureVersionPreview(f.engine, '/project')).resolves.toBe('data:image/png;base64,small');
    expect(f.target.dispose).toHaveBeenCalledOnce();
    expect(f.engine.snapshot).toHaveBeenCalledOnce();
  });

  it('falls back without attempting to dispose a world when capture creation fails', async () => {
    const f = fixture(); mocks.capture.mockRejectedValueOnce(new Error('Compile failed'));
    await expect(captureVersionPreview(f.engine, '/project')).resolves.toBe('data:image/png;base64,small');
    expect(f.target.dispose).not.toHaveBeenCalled();
    expect(f.engine.snapshot).toHaveBeenCalledOnce();
  });
});
