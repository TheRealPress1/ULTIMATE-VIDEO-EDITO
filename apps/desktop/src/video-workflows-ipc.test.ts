import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_CHANNELS as C } from './main-channels';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (data: any, event: any) => any>(),
  get: vi.fn(), prepare: vi.fn(), cancel: vi.fn(), pin: vi.fn(), release: vi.fn(), dispose: vi.fn(),
  source: vi.fn(async (_dir: string, source: string) => source),
}));
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', getPath: () => '/cache', on: vi.fn() }, BrowserWindow: { fromWebContents: () => null } }));
vi.mock('node:fs/promises', () => ({ realpath: async (path: string) => path }));
vi.mock('./projects', () => ({ realPathEntry: mocks.source }));
vi.mock('./main-manager', () => ({ mainBridge: { handle: (name: string, fn: any) => mocks.handlers.set(name, fn), emit: vi.fn() } }));
vi.mock('./reference-index', () => ({ LocalReferenceStyleService: class { get = vi.fn(); analyze = vi.fn(); cancel = vi.fn(); dispose = vi.fn(); } }));
vi.mock('./playback-proxy', () => ({ LocalPlaybackProxyService: class { get = mocks.get; prepare = mocks.prepare; cancel = mocks.cancel; pin = mocks.pin; release = mocks.release; dispose = mocks.dispose; } }));
import { registerVideoWorkflows } from './video-workflows-ipc';
class Sender extends EventEmitter { id = 7; dead = false; isDestroyed() { return this.dead; } }
const request = (sessionId = '00000000-0000-4000-8000-000000000001', dir = '/project') => ({ sessionId, dir, source: '/video.mp4', sourceStart: 0, duration: 150, width: 1920, height: 1080, frameRate: 30 });
const ready = { status: 'ready', fingerprint: 'f', sourceSignature: 's', proxy: { path: '/cache/playback-cache/p.mp4' } };
const invoke = (channel: string, data: any, sender: Sender) => mocks.handlers.get(channel)!(data, { sender });
let sender: Sender;
beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); sender = new Sender(); mocks.get.mockResolvedValue(ready); mocks.prepare.mockResolvedValue(ready); registerVideoWorkflows(); });
afterEach(() => { sender.dead = true; sender.emit('destroyed'); });

describe('playback IPC project ownership', () => {
  it('pins a cached result and releases only its generation', async () => {
    await invoke(C.PLAYBACK_PROXY_GET, request(), sender);
    const other = request('00000000-0000-4000-8000-000000000002');
    await invoke(C.PLAYBACK_PROXY_GET, other, sender);
    await invoke(C.PLAYBACK_PROXY_RELEASE, request(), sender);
    expect(mocks.pin).toHaveBeenCalledWith(`7:${other.sessionId}`, ready.proxy.path);
    expect(mocks.release.mock.calls.map(([owner]) => owner)).toEqual([`7:${request().sessionId}`]);
    await expect(invoke(C.PLAYBACK_PROXY_GET, request(), sender)).rejects.toThrow('closed');
  });
  it('does not pin a late GET after project release', async () => {
    let finish!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = invoke(C.PLAYBACK_PROXY_GET, request(), sender);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await invoke(C.PLAYBACK_PROXY_RELEASE, request(), sender);
    finish(ready);
    await expect(pending).rejects.toThrow('closed'); expect(mocks.pin).not.toHaveBeenCalled();
  });
  it('rejects reusing a session for a different directory', async () => {
    await invoke(C.PLAYBACK_PROXY_GET, request(), sender);
    await expect(invoke(C.PLAYBACK_PROXY_GET, request(request().sessionId, '/other'), sender)).rejects.toThrow('closed');
  });
  it('retires old generations on reload while allowing new ones', async () => {
    await invoke(C.PLAYBACK_PROXY_GET, request(), sender); sender.emit('did-start-loading');
    await expect(invoke(C.PLAYBACK_PROXY_GET, request(), sender)).rejects.toThrow('closed');
    await expect(invoke(C.PLAYBACK_PROXY_GET, request('00000000-0000-4000-8000-000000000003'), sender)).resolves.toEqual(ready);
  });
  it('cancels only jobs owned by the requesting renderer', async () => {
    let finish!: (value: unknown) => void;
    mocks.prepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = invoke(C.PLAYBACK_PROXY_PREPARE, { ...request(), id: 'job' }, sender);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const other = new Sender(); other.id = 99;
    invoke(C.PLAYBACK_PROXY_CANCEL, { id: 'job' }, other); expect(mocks.cancel).not.toHaveBeenCalled();
    await invoke(C.PLAYBACK_PROXY_RELEASE, request(), sender); expect(mocks.cancel).toHaveBeenCalledWith('job');
    finish(ready); await expect(pending).rejects.toThrow('canceled'); expect(mocks.pin).not.toHaveBeenCalled();
  });
  it('rejects missing generation identifiers', async () => {
    await expect(invoke(C.PLAYBACK_PROXY_GET, { ...request(), sessionId: undefined }, sender)).rejects.toThrow('Invalid playback');
  });
});
