import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handle: vi.fn(), emit: vi.fn(), appOn: vi.fn(), resolve: vi.fn(), analyze: vi.fn(), speakerCancel: vi.fn(), dispose: vi.fn(), cacheGet: vi.fn(), cachePut: vi.fn(), footageGet: vi.fn(), footagePut: vi.fn(), chunksGet: vi.fn(), chunkPut: vi.fn() }));
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', on: mocks.appOn }, BrowserWindow: { fromWebContents: () => ({}) } }));
vi.mock('./main-manager', () => ({ mainBridge: { handle: mocks.handle, emit: mocks.emit } }));
vi.mock('./projects', () => ({ realPathEntry: mocks.resolve }));
vi.mock('./speaker-analysis', () => ({ LocalSpeakerAnalysisService: class { analyze = mocks.analyze; cancel = mocks.speakerCancel; dispose = mocks.dispose; } }));
vi.mock('./analysis-cache', () => ({ LocalAnalysisCache: class { get = mocks.cacheGet; put = mocks.cachePut; } }));
vi.mock('./footage-index', () => ({ loadFootageTranscript: mocks.footageGet, saveFootageTranscript: mocks.footagePut, loadFootageChunks: mocks.chunksGet, saveFootageChunk: mocks.chunkPut }));
import { registerInterviewAnalysis } from './interview-analysis-ipc';
import { MAIN_CHANNELS as C } from './main-channels';
class Sender extends EventEmitter { readonly id: number; constructor(id: number) { super(); this.id = id; } isDestroyed() { return false; } }
type Handler = (request: Record<string, unknown>, event: { sender: Sender }) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler>();
const id = '5d7d7b25-3078-4fd1-91f3-c43ff9e7a805';
const call = (channel: string, sender: Sender, request: Record<string, unknown> = { id }) => handlers.get(channel)!(request, { sender });
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear();
  mocks.handle.mockImplementation((channel, handler) => { handlers.set(channel, handler); });
  mocks.resolve.mockResolvedValue('/project/interview.mp4');
  for (const method of [mocks.cacheGet, mocks.cachePut, mocks.footageGet, mocks.footagePut, mocks.chunksGet, mocks.chunkPut]) method.mockResolvedValue({ completed: true });
  mocks.analyze.mockResolvedValue({ samples: [] }); registerInterviewAnalysis();
});
const jobs = [
  [C.ANALYSIS_CACHE_GET, C.ANALYSIS_CACHE_CANCEL, mocks.cacheGet], [C.ANALYSIS_CACHE_PUT, C.ANALYSIS_CACHE_CANCEL, mocks.cachePut],
  [C.FOOTAGE_INDEX_GET, C.FOOTAGE_INDEX_CANCEL, mocks.footageGet], [C.FOOTAGE_INDEX_PUT, C.FOOTAGE_INDEX_CANCEL, mocks.footagePut],
  [C.FOOTAGE_INDEX_CHUNKS_GET, C.FOOTAGE_INDEX_CANCEL, mocks.chunksGet], [C.FOOTAGE_INDEX_CHUNK_PUT, C.FOOTAGE_INDEX_CANCEL, mocks.chunkPut],
] as const;
describe('renderer-owned interview analysis', () => {
  it.each(jobs)('%s rejects late completion after owner cancellation and ignores foreign cancellation', async (channel, cancel, method) => {
    const pending = deferred(), owner = new Sender(1), other = new Sender(2); method.mockReturnValue(pending.promise);
    const task = call(channel, owner) as Promise<unknown>, rejected = expect(task).rejects.toThrow('Analysis canceled');
    const signal = method.mock.calls[0]![1] as AbortSignal;
    call(cancel, other); expect(signal.aborted).toBe(false);
    call(cancel, owner); expect(signal.aborted).toBe(true);
    pending.resolve({ stale: true }); await rejected;
    expect(owner.eventNames()).toEqual([]);
  });
  it.each(['destroyed', 'render-process-gone', 'did-start-loading'])('aborts a source hash on renderer %s and removes every lifecycle listener', async event => {
    const pending = deferred(), owner = new Sender(1); mocks.footageGet.mockReturnValue(pending.promise);
    const task = call(C.FOOTAGE_INDEX_GET, owner) as Promise<unknown>, rejected = expect(task).rejects.toThrow('Analysis canceled');
    owner.emit(event); expect(mocks.footageGet.mock.calls[0]![1].aborted).toBe(true);
    pending.resolve({ stale: true }); await rejected; expect(owner.eventNames()).toEqual([]);
  });
  it('rejects duplicate active IDs without replacing ownership and permits reuse after settlement', async () => {
    const pending = deferred(), owner = new Sender(1), other = new Sender(2); mocks.cacheGet.mockReturnValueOnce(pending.promise);
    const task = call(C.ANALYSIS_CACHE_GET, owner) as Promise<unknown>;
    await expect(call(C.ANALYSIS_CACHE_GET, other)).rejects.toThrow('already running');
    call(C.ANALYSIS_CACHE_CANCEL, other); expect(mocks.cacheGet.mock.calls[0]![1].aborted).toBe(false);
    pending.resolve({ ok: true }); await expect(task).resolves.toEqual({ ok: true });
    await expect(call(C.ANALYSIS_CACHE_GET, other)).resolves.toEqual({ completed: true });
    expect(owner.eventNames()).toEqual([]); expect(other.eventNames()).toEqual([]);
  });
  it('keeps independent speech and review cache requests in separate cancellation namespaces', async () => {
    const first = deferred(), second = deferred(), owner = new Sender(1);
    mocks.cacheGet.mockReturnValue(first.promise); mocks.footageGet.mockReturnValue(second.promise);
    const a = call(C.ANALYSIS_CACHE_GET, owner) as Promise<unknown>, b = call(C.FOOTAGE_INDEX_GET, owner) as Promise<unknown>;
    const rejected = expect(a).rejects.toThrow('Analysis canceled'); call(C.ANALYSIS_CACHE_CANCEL, owner);
    expect(mocks.footageGet.mock.calls[0]![1].aborted).toBe(false);
    first.resolve({}); second.resolve({ footage: true }); await rejected; await expect(b).resolves.toEqual({ footage: true });
  });
  it('validates IDs before invoking disk or native cache methods', () => {
    expect(() => call(C.FOOTAGE_INDEX_GET, new Sender(1), { id: 'invalid' })).toThrow('identifier');
    expect(mocks.footageGet).not.toHaveBeenCalled();
  });
  it('does not start native speaker analysis after cancellation while resolving its source', async () => {
    const pending = deferred(), owner = new Sender(1); mocks.resolve.mockReturnValue(pending.promise);
    const task = call(C.SPEAKER_ANALYZE, owner) as Promise<unknown>, rejected = expect(task).rejects.toThrow('Analysis canceled');
    call(C.SPEAKER_CANCEL, new Sender(2)); expect(mocks.speakerCancel).not.toHaveBeenCalled();
    call(C.SPEAKER_CANCEL, owner); expect(mocks.speakerCancel).toHaveBeenCalledWith(id);
    pending.resolve('/project/source.mp4'); await rejected; expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it('stops native progress and rejects native success delivered after cancellation', async () => {
    const pending = deferred(), owner = new Sender(1); mocks.analyze.mockReturnValue(pending.promise);
    const task = call(C.SPEAKER_ANALYZE, owner) as Promise<unknown>, rejected = expect(task).rejects.toThrow('Analysis canceled');
    await vi.waitFor(() => expect(mocks.analyze).toHaveBeenCalled());
    const progress = mocks.analyze.mock.calls[0]![1]; progress({ id, completedChunks: 1 }); expect(mocks.emit).toHaveBeenCalledOnce();
    call(C.SPEAKER_CANCEL, owner); progress({ id, completedChunks: 2 }); expect(mocks.emit).toHaveBeenCalledOnce();
    pending.resolve({ samples: [] }); await rejected; expect(owner.eventNames()).toEqual([]);
  });
  it('cancels every outstanding cache job and disposes native jobs on application quit', async () => {
    const pending = deferred(), owner = new Sender(1); mocks.cacheGet.mockReturnValue(pending.promise);
    const task = call(C.ANALYSIS_CACHE_GET, owner) as Promise<unknown>, rejected = expect(task).rejects.toThrow('Analysis canceled');
    mocks.appOn.mock.calls.find(([event]) => event === 'will-quit')![1]();
    expect(mocks.dispose).toHaveBeenCalledOnce(); expect(mocks.cacheGet.mock.calls[0]![1].aborted).toBe(true);
    pending.resolve({}); await rejected;
  });
});
