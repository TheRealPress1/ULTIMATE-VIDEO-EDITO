import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ call: vi.fn(), handle: vi.fn(), stop: vi.fn() }));
vi.mock('./ipc', () => ({ mainBridge: mocks }));
import { analyzeReframeLocally } from './local-reframe';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { ReframeAnalysisResult } from '@desktop/reframe-types';

const result: ReframeAnalysisResult = { duration: 2, width: 1920, height: 1080, sampleInterval: 0.5, samples: [] };
function deferred() {
  let resolve!: (value: ReframeAnalysisResult) => void;
  const promise = new Promise<ReframeAnalysisResult>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.clearAllMocks(); mocks.handle.mockReturnValue(mocks.stop); });

describe('local reframe bridge', () => {
  it('does not start an already canceled analysis', async () => {
    await expect(analyzeReframeLocally('/project', 'assets/source.mp4', 0, 2, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it('waits for canceled native work to settle and rejects its late result', async () => {
    const work = deferred();
    mocks.call.mockImplementation((channel) => channel === MAIN_CHANNELS.REFRAME_ANALYZE ? work.promise : Promise.resolve());
    const controller = new AbortController();
    const promise = analyzeReframeLocally('/project', 'assets/source.mp4', 0, 2, { signal: controller.signal });
    const check = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const id = mocks.call.mock.calls[0][1].id;
    controller.abort();
    expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.REFRAME_CANCEL, { id });
    expect(mocks.stop).not.toHaveBeenCalled();
    work.resolve(result);
    await check;
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it('routes overlapping progress by job ID and releases only the final subscription', async () => {
    const first = deferred(), second = deferred();
    mocks.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const progress1 = vi.fn(), progress2 = vi.fn();
    const p1 = analyzeReframeLocally('/project', 'one.mp4', 0, 2, { onProgress: progress1 });
    const p2 = analyzeReframeLocally('/project', 'two.mp4', 0, 2, { onProgress: progress2 });
    const [id1, id2] = mocks.call.mock.calls.map((call) => call[1].id);
    const dispatch = mocks.handle.mock.calls[0][1];
    dispatch({ id: id2, completed: 1, total: 4 });
    expect(progress1).not.toHaveBeenCalled();
    expect(progress2).toHaveBeenCalledOnce();
    first.resolve(result); await p1;
    expect(mocks.stop).not.toHaveBeenCalled();
    dispatch({ id: id1, completed: 4, total: 4 });
    expect(progress1).not.toHaveBeenCalled();
    second.resolve(result); await p2;
    expect(mocks.handle).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
