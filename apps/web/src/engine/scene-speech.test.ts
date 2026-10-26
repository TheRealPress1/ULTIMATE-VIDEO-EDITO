import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { World, Entity } from 'koota';
const mocks = vi.hoisted(() => ({ call: vi.fn(), audio: vi.fn(), transcribe: vi.fn(), library: vi.fn(), asset: vi.fn(), tree: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ mainBridge: { call: mocks.call } }));
vi.mock('@/lib/local-transcription', () => ({ transcribeLocally: mocks.transcribe }));
vi.mock('./scene-audio', () => ({ encodeSceneAudio: mocks.audio }));
vi.mock('@diffusionstudio/runtime', () => ({ AssetId: 'asset', FrameRate: 'rate', getLibrary: mocks.library, getAsset: mocks.asset, getEntityTree: mocks.tree }));
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { transcribeSceneSections } from './scene-speech';
const speech = [{ text: 'word', words: [{ text: 'word', start: 3, end: 3.5 }] }];
function fixture() {
  const world = { get: () => ({ value: 30 }) } as unknown as World, scene = {} as Entity;
  const asset = { id: 'source', source: 'interview.mp4', type: 'VIDEO', stat: { size: 100, mtime: 10 } };
  const library = { get: vi.fn(() => asset), fs: { stat: vi.fn(async () => ({ size: 100, mtime: 10 })) } };
  const chunks: Record<string, unknown> = {};
  mocks.library.mockReturnValue(library); mocks.asset.mockReturnValue(asset);
  mocks.tree.mockReturnValue([{ get: () => ({ value: 'source' }) }]);
  mocks.call.mockImplementation(async (channel, request) => {
    if (channel === MAIN_CHANNELS.ANALYSIS_CACHE_PUT) chunks[request.chunk] = request.value;
    return { fingerprint: 'hash', chunks: { ...chunks } };
  });
  mocks.audio.mockResolvedValue(new Blob(['audio'])); mocks.transcribe.mockResolvedValue(speech);
  const controller = new AbortController(), assertCurrent = vi.fn(), progress = vi.fn();
  const options = { duration: 360, snapshot: '<scene />', signal: controller.signal, assertCurrent, onProgress: progress };
  return { world, scene, asset, library, chunks, options, controller };
}
beforeEach(() => vi.clearAllMocks());
describe('long scene caption sections', () => {
  it('mixes bounded overlapping sections and returns scene-relative word timestamps', async () => {
    const f = fixture(); const result = await transcribeSceneSections(f.world, f.scene, '/project', f.options);
    expect(mocks.audio.mock.calls.map(call => call[3].window)).toEqual([{ start: 0, end: 122 }, { start: 118, end: 242 }, { start: 238, end: 360 }]);
    expect(result.flatMap(segment => segment.words.map(word => word.start))).toEqual([3, 121, 241]);
    expect(Object.keys(f.chunks)).toEqual(['speech-0', 'speech-1', 'speech-2']);
    expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.ANALYSIS_CACHE_GET, expect.objectContaining({ sources: ['interview.mp4'], key: expect.stringContaining('scene-whisper-base-overlap-v2') }));
  });
  it('resumes committed and no-speech sections after a later cancellation', async () => {
    const f = fixture(); let calls = 0;
    mocks.transcribe.mockImplementation(async () => { if (++calls === 2) { f.controller.abort(); throw new DOMException('Canceled', 'AbortError'); } return []; });
    await expect(transcribeSceneSections(f.world, f.scene, '/project', f.options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.chunks).toEqual({ 'speech-0': [] });
    mocks.transcribe.mockResolvedValue(speech); mocks.audio.mockClear();
    await transcribeSceneSections(f.world, f.scene, '/project', { ...f.options, signal: new AbortController().signal });
    expect(mocks.audio).toHaveBeenCalledTimes(2); expect(mocks.audio.mock.calls[0]![3].window.start).toBe(118);
    expect(Object.keys(f.chunks)).toHaveLength(3);
  });
  it('does not commit a section when its media changes during recognition', async () => {
    const f = fixture(); mocks.transcribe.mockImplementation(async () => { f.asset.source = 'relinked.mp4'; return speech; });
    await expect(transcribeSceneSections(f.world, f.scene, '/project', f.options)).rejects.toThrow('Scene media changed');
    expect(f.chunks).toEqual({});
  });
  it('cancels source hashing and ignores its late result', async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    mocks.call.mockImplementation((channel) => channel === MAIN_CHANNELS.ANALYSIS_CACHE_GET ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(undefined));
    const task = transcribeSceneSections(f.world, f.scene, '/project', f.options);
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled()); f.controller.abort();
    expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.ANALYSIS_CACHE_CANCEL, expect.objectContaining({ id: expect.any(String) }));
    finish({ fingerprint: 'hash', chunks: {} }); await rejected; expect(mocks.audio).not.toHaveBeenCalled();
  });
  it('reprocesses invalid cached word times and never reuses another composition key', async () => {
    const f = fixture(); f.chunks['speech-0'] = [{ text: 'invalid', words: [{ text: 'invalid', start: 1000, end: 1001 }] }];
    await transcribeSceneSections(f.world, f.scene, '/project', f.options);
    const first = mocks.call.mock.calls.find(call => call[0] === MAIN_CHANNELS.ANALYSIS_CACHE_GET)![1].key;
    await transcribeSceneSections(f.world, f.scene, '/project', { ...f.options, snapshot: '<scene volume={0.5} />' });
    const second = mocks.call.mock.calls.filter(call => call[0] === MAIN_CHANNELS.ANALYSIS_CACHE_GET)[1]![1].key;
    expect(first).not.toBe(second); expect(mocks.audio).toHaveBeenCalledTimes(3);
  });
});
