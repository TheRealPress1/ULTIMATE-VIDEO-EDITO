import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackProxyProgress, PlaybackProxyRequest } from '@desktop/playback-proxy-types';
const mocks = vi.hoisted(() => ({ call: vi.fn(), handle: vi.fn(), stop: vi.fn() }));
vi.mock('./ipc', () => ({ mainBridge: { call: mocks.call, handle: mocks.handle } }));
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { preparePlaybackProxy } from './playback-proxy';
const request: PlaybackProxyRequest = { dir: '/project', source: '/media/video.mov', duration: 300, sourceStart: 0, width: 3840, height: 2160, frameRate: 30, sessionId: 'session' };
beforeEach(() => { vi.clearAllMocks(); mocks.handle.mockReturnValue(mocks.stop); });
describe('cancellable local playback bridge', () => {
  it('cancels native work and waits for its reply before releasing its listener', async () => {
    let finish!: () => void;
    mocks.call.mockImplementation((channel) => channel === MAIN_CHANNELS.PLAYBACK_PROXY_PREPARE ? new Promise((resolve) => { finish = () => resolve({ status: 'ready' }); }) : Promise.resolve());
    const controller = new AbortController(); const progress = vi.fn();
    const pending = preparePlaybackProxy(request, { signal: controller.signal, onProgress: progress });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const job = mocks.call.mock.calls[0]![1]; controller.abort();
    expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.PLAYBACK_PROXY_CANCEL, { id: job.id });
    expect(mocks.stop).not.toHaveBeenCalled();
    mocks.handle.mock.calls[0]![1]({ id: job.id, phase: 'encoding', completed: 5, total: 300 } satisfies PlaybackProxyProgress);
    expect(progress).not.toHaveBeenCalled();
    finish(); await rejection; expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it('routes overlapping project progress by job and tears down only after both finish', async () => {
    const finishes: Array<() => void> = [];
    mocks.call.mockImplementation(() => new Promise((resolve) => { finishes.push(() => resolve({ status: 'ready' })); }));
    const firstProgress = vi.fn(), secondProgress = vi.fn();
    const a = preparePlaybackProxy(request, { onProgress: firstProgress });
    const b = preparePlaybackProxy({ ...request, dir: '/next' }, { onProgress: secondProgress });
    expect(mocks.handle).toHaveBeenCalledOnce();
    const progress = { id: mocks.call.mock.calls[1]![1].id, phase: 'encoding', completed: 5, total: 300 } satisfies PlaybackProxyProgress;
    mocks.handle.mock.calls[0]![1](progress);
    expect(firstProgress).not.toHaveBeenCalled(); expect(secondProgress).toHaveBeenCalledWith(progress);
    finishes[0]!(); await a; expect(mocks.stop).not.toHaveBeenCalled();
    finishes[1]!(); await b; expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
