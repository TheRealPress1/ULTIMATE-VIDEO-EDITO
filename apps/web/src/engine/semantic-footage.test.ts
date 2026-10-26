import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisualService } from './visual-footage';
import { CLIP_KEY } from '@/lib/semantic/model';
import { semanticKey } from '@/lib/semantic/math';
const mocks = vi.hoisted(() => ({ request: vi.fn(), dispose: vi.fn(), read: vi.fn(), write: vi.fn(), inputDispose: vi.fn(), canvases: vi.fn(), firstTimestamp: vi.fn() }));
vi.mock('@/lib/semantic/client', () => ({ SemanticClient: class { request = mocks.request; dispose = mocks.dispose; } }));
vi.mock('@/lib/semantic/cache', () => ({ readSemanticRecord: mocks.read, writeSemanticRecord: mocks.write }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class {
  dispose = mocks.inputDispose;
  getPrimaryVideoTrack = async () => ({ canDecode: async () => true, getFirstTimestamp: mocks.firstTimestamp });
}, CanvasSink: class { canvasesAtTimestamps = mocks.canvases; } }));
import { SemanticFootage } from './semantic-footage';
const fingerprint = 'a'.repeat(64);
const vector = () => Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
function fixture() {
  const item = { assetId: 'source', path: 'source.mp4', status: 'ready', fingerprint,
    analysis: { sourceStart: 0, duration: 8, width: 100, height: 100, sampleInterval: 5, samples: [0, 5].map((time) => ({ time, mediaTime: time, labels: [], text: [], people: 0 })) } };
  const source = { handle: { getFile: vi.fn(async () => new Blob()) } };
  const visual = { disposed: false, assertCurrent: vi.fn(), load: vi.fn(async () => {}), snapshot: () => ({ indexing: false, items: [item] }), validateMatch: vi.fn(async () => source) };
  const service = new SemanticFootage(visual as unknown as VisualService);
  return { service, visual, item, source };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.firstTimestamp.mockResolvedValue(0); mocks.read.mockResolvedValue(undefined); mocks.write.mockResolvedValue(undefined);
  mocks.request.mockImplementation(async (request) => request.type === 'image' || request.type === 'text' ? vector() : true);
  mocks.canvases.mockImplementation(async function* (times: number[]) { for (let i = 0; i < 2; i++) yield { timestamp: times[i]! - 0.000001, canvas: { width: 2, height: 2, getContext: () => ({ getImageData: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }) }) } }; });
});
describe('description footage pipeline', () => {
  it('only explicit download passes download=true; source indexing uses exact observed times', async () => {
    const f = fixture(); await f.service.download(); await f.service.index();
    expect(mocks.request.mock.calls.filter(([request]) => request.download === true)).toHaveLength(1);
    expect(mocks.canvases).toHaveBeenCalledWith([0.000001, 5.000001]);
    expect(f.visual.validateMatch).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ fingerprint, model: CLIP_KEY, times: [0, 5], vectors: [vector(), vector()] }));
    expect(mocks.inputDispose).toHaveBeenCalledOnce(); f.service.dispose();
  });
  it.each([0.033, 2, 4])('indexes an offset MP4 clock %s using the exact native frame PTS', async (first) => {
    const f = fixture(); mocks.firstTimestamp.mockResolvedValueOnce(first);
    f.item.analysis.sourceStart = first;
    f.item.analysis.samples[1]!.time = 4.971266666666667 - 0.033;
    f.item.analysis.samples.forEach((sample) => { sample.mediaTime = first + sample.time; });
    await f.service.index();
    expect(mocks.canvases).toHaveBeenCalledWith(f.item.analysis.samples.map((sample) => sample.mediaTime + 0.000001));
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ times: f.item.analysis.samples.map((sample) => sample.time) }));
    expect(mocks.inputDispose).toHaveBeenCalledOnce();
  });
  it('rejects changed clock metadata without saving mismatched evidence', async () => {
    const f = fixture(); mocks.firstTimestamp.mockResolvedValueOnce(4);
    await expect(f.service.index()).rejects.toThrow('presentation clock changed');
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.canvases).not.toHaveBeenCalled();
  });
  it('rejects a decoder returning the preceding frame instead of silently mixing evidence', async () => {
    const f = fixture();
    mocks.canvases.mockImplementationOnce(async function* () { yield { timestamp: 0.033, canvas: {} }; });
    await expect(f.service.index()).rejects.toThrow('different frames');
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.inputDispose).toHaveBeenCalledOnce();
  });
  it('never persists an embedding if the source changes during decoding', async () => {
    const f = fixture(); f.visual.validateMatch.mockRejectedValueOnce(new Error('source changed'));
    await expect(f.service.index()).rejects.toThrow('source changed'); expect(mocks.write).not.toHaveBeenCalled();
    f.visual.validateMatch.mockResolvedValueOnce(f.source).mockRejectedValueOnce(new Error('source changed after decode'));
    await expect(f.service.index()).rejects.toThrow('after decode'); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.inputDispose).toHaveBeenCalledOnce();
  });
  it('rejects cancellation/navigation without persisting partial vectors and releases decoder', async () => {
    const f = fixture(); const controller = new AbortController();
    mocks.request.mockImplementation(async (request) => { if (request.type === 'image') controller.abort(); return request.type === 'image' ? vector() : true; });
    await expect(f.service.index(undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.inputDispose).toHaveBeenCalledOnce(); expect(f.service.snapshot().busy).toBe(false);
    f.visual.assertCurrent.mockImplementation(() => { throw new Error('project changed'); });
    await expect(f.service.search('news')).rejects.toThrow('project changed');
  });
  it('reuses valid vectors, never decodes cached footage, and refreshes before returning a semantic match', async () => {
    const f = fixture(); mocks.read.mockResolvedValue({ key: semanticKey(fingerprint), fingerprint, model: CLIP_KEY, times: [0, 5], vectors: [vector(), vector()], usedAt: 1 });
    await f.service.index(); expect(mocks.canvases).not.toHaveBeenCalled();
    expect((await f.service.search('television studio')).matches).toHaveLength(2);
    expect(f.visual.load).toHaveBeenCalledTimes(3);
    f.visual.load.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { f.item.fingerprint = 'b'.repeat(64); });
    expect((await f.service.search('television studio')).matches).toHaveLength(0);
  });
  it('restores model-download action after cache corruption or model-load failure', async () => {
    const f = fixture(); await f.service.status(); expect(f.service.snapshot().available).toBe(true);
    mocks.request.mockRejectedValueOnce(new Error('Download model first'));
    await expect(f.service.index()).rejects.toThrow('Download');
    expect(f.service.snapshot()).toMatchObject({ available: false, busy: false });
  });
});
