import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ call: vi.fn(), handle: vi.fn(), stop: vi.fn() }));
vi.mock('./ipc', () => ({ mainBridge: { call: mocks.call, handle: mocks.handle } }));
import { MAIN_CHANNELS as C } from '@desktop/main-channels';
import { analyzeSpeakersLocally } from './local-speaker';
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); mocks.handle.mockReturnValue(mocks.stop); });
describe('local speaker lifecycle', () => {
  it('does not start an already canceled job', async () => {
    await expect(analyzeSpeakersLocally('/project', 'source.mp4', 0, 30, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.handle).not.toHaveBeenCalled();
  });
  it('sends cancellation immediately, ignores late progress and rejects a late native success', async () => {
    const pending = deferred(), controller = new AbortController(), progress = vi.fn();
    mocks.call.mockImplementation(channel => channel === C.SPEAKER_ANALYZE ? pending.promise : Promise.resolve());
    const task = analyzeSpeakersLocally('/project', 'source.mp4', 0, 90, { sourceStart: 2, signal: controller.signal, onProgress: progress });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' }), request = mocks.call.mock.calls[0]![1];
    expect(request).toMatchObject({ sourceStart: 2, start: 0, end: 90 });
    mocks.handle.mock.calls[0]![1]({ id: request.id, completedChunks: 1 }); expect(progress).toHaveBeenCalledOnce();
    controller.abort(); expect(mocks.call).toHaveBeenLastCalledWith(C.SPEAKER_CANCEL, { id: request.id });
    mocks.handle.mock.calls[0]![1]({ id: request.id, completedChunks: 2 }); expect(progress).toHaveBeenCalledOnce();
    pending.resolve({ samples: [] }); await rejected; expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it('routes concurrent progress only to its request and retains the listener until both jobs end', async () => {
    const a = deferred(), b = deferred(), progressA = vi.fn(), progressB = vi.fn();
    mocks.call.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = analyzeSpeakersLocally('/project', 'a.mp4', 0, 30, { onProgress: progressA });
    const second = analyzeSpeakersLocally('/project', 'b.mp4', 0, 30, { onProgress: progressB });
    const listener = mocks.handle.mock.calls[0]![1], id = mocks.call.mock.calls[1]![1].id;
    listener({ id, completedChunks: 1 }); expect(progressA).not.toHaveBeenCalled(); expect(progressB).toHaveBeenCalledOnce();
    a.resolve({ samples: [] }); await first; expect(mocks.stop).not.toHaveBeenCalled();
    b.resolve({ samples: [] }); await second; expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
