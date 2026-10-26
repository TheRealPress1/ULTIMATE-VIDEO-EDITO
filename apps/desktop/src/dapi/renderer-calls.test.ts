import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { DAPI_WIRE } from '@diffusionstudio/dapi';
const { ipc } = vi.hoisted(() => ({ ipc: { on: vi.fn() } }));
vi.mock('electron', () => ({ ipcMain: ipc }));
import { RendererCalls } from './renderer-calls';
import { pinProject } from './output-policy';

function fixture(loading = false, host: { fresh?: boolean; lastProject?: string | null; projectRoot?: string | null } = {}) {
  const contents = Object.assign(new EventEmitter(), { isLoading: () => loading, isCrashed: () => false, send: vi.fn() });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }) as unknown as BrowserWindow;
  const acquire = vi.fn(() => ({ window, fresh: host.fresh ?? false }));
  const calls = new RendererCalls({ acquire, lastProject: () => host.lastProject ?? null, projectRoot: () => host.projectRoot ?? null }); calls.start();
  return { calls, contents, acquire, window,
    ready() { loading = false; contents.emit('did-finish-load'); },
    startNavigation(isSameDocument: boolean, isMainFrame = true) {
      loading = true;
      contents.emit('did-start-loading');
      contents.emit('did-start-navigation', { isSameDocument, isMainFrame });
    },
    stopLoading() { loading = false; contents.emit('did-stop-loading'); },
    reply(data: unknown) {
      const request = contents.send.mock.calls.find(call => call[0] === DAPI_WIRE.CALL)![1];
      ipc.on.mock.calls[0]![1]({}, { id: request.id, ok: true, data });
    },
  };
}
beforeEach(() => vi.clearAllMocks());
describe('renderer long-call cancellation', () => {
  it('never creates a window for an already canceled call', async () => {
    const { calls, acquire } = fixture();
    await expect(calls.call('reframe', {}, AbortSignal.abort())).rejects.toThrow('canceled');
    expect(acquire).not.toHaveBeenCalled();
  });
  it('does not start analysis canceled while the window was loading', async () => {
    const { calls, contents, ready } = fixture(true); const controller = new AbortController();
    const work = calls.call('reframe', {}, controller.signal);
    controller.abort(); ready();
    await expect(work).rejects.toThrow('canceled'); expect(contents.send).not.toHaveBeenCalled();
  });
  it('forwards cancellation of an active request and ignores its late reply', async () => {
    const { calls, contents } = fixture(); const controller = new AbortController();
    const work = calls.call('quality_review', { id: 'scene' }, controller.signal);
    await vi.waitFor(() => expect(contents.send).toHaveBeenCalledWith(DAPI_WIRE.CALL, expect.anything()));
    const request = contents.send.mock.calls[0]![1];
    const rejected = expect(work).rejects.toThrow('canceled'); controller.abort(); await rejected;
    expect(contents.send).toHaveBeenLastCalledWith(DAPI_WIRE.CANCEL, { id: request.id });
    ipc.on.mock.calls[0]![1]({}, { id: request.id, ok: true, data: 'late' });
  });
});

describe('renderer navigation lifecycle', () => {
  it('keeps an open reply alive across the packaged app hash route change', async () => {
    const f = fixture();
    const work = f.calls.call('open', { dir: '/test/project' }, new AbortController().signal);
    await vi.waitFor(() => expect(f.contents.send).toHaveBeenCalledWith(DAPI_WIRE.CALL, expect.anything()));
    f.startNavigation(true);
    f.stopLoading();
    f.reply({ dir: '/test/project' });
    await expect(work).resolves.toEqual({ dir: '/test/project' });
  });

  it('does not reject main-frame tools because a child frame starts navigating', async () => {
    const f = fixture();
    const work = f.calls.call('context', {}, new AbortController().signal);
    await vi.waitFor(() => expect(f.contents.send).toHaveBeenCalled());
    f.startNavigation(false, false);
    f.reply('context');
    await expect(work).resolves.toBe('context');
  });

  it('rejects pending work on a real reload and waits for the replacement document', async () => {
    const f = fixture();
    const first = f.calls.call('check', {}, new AbortController().signal);
    await vi.waitFor(() => expect(f.contents.send).toHaveBeenCalled());
    const rejected = expect(first).rejects.toThrow('reloaded before replying');
    f.startNavigation(false);
    await rejected;
    f.contents.send.mockClear();
    const second = f.calls.call('context', {}, new AbortController().signal);
    await Promise.resolve();
    expect(f.contents.send).not.toHaveBeenCalled();
    f.ready();
    await vi.waitFor(() => expect(f.contents.send).toHaveBeenCalled());
    f.reply('ready');
    await expect(second).resolves.toBe('ready');
  });

  it('does not wait for a document load event after a hash-only loading cycle', async () => {
    const f = fixture(true);
    const work = f.calls.call('context', {}, new AbortController().signal);
    f.stopLoading();
    await vi.waitFor(() => expect(f.contents.send).toHaveBeenCalled());
    f.reply('ready');
    await expect(work).resolves.toBe('ready');
  });

  it.each(['render-process-gone', 'closed'])('still rejects outstanding work after %s', async (event) => {
    const f = fixture();
    const work = f.calls.call('export', {}, new AbortController().signal);
    await vi.waitFor(() => expect(f.contents.send).toHaveBeenCalled());
    const rejected = expect(work).rejects.toThrow(event === 'closed' ? 'closed' : 'crashed');
    (event === 'closed' ? f.window : f.contents).emit(event);
    await rejected;
  });
});

describe('reopening the last project in a new window', () => {
  const sent = (contents: { send: { mock: { calls: unknown[][] } } }) =>
    contents.send.mock.calls.filter((call) => call[0] === DAPI_WIRE.CALL).map((call) => (call[1] as { tool: string; args: unknown }));

  it('reopens the project the agent was working on before the call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dapi-reopen-'));
    try {
      const f = fixture(false, { fresh: true, lastProject: dir, projectRoot: pinProject(dir) });
      void f.calls.call('context', {}, new AbortController().signal);
      await vi.waitFor(() => expect(sent(f.contents)[0]).toMatchObject({ tool: 'open', args: { dir } }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reopen a project whose folder was swapped for a link since it was opened', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dapi-reopen-'));
    try {
      const dir = join(parent, 'show');
      mkdirSync(dir);
      const pinned = pinProject(dir);
      renameSync(dir, join(parent, 'away'));
      symlinkSync(tmpdir(), dir);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = fixture(false, { fresh: true, lastProject: dir, projectRoot: pinned });
      void f.calls.call('context', {}, new AbortController().signal);
      await vi.waitFor(() => expect(sent(f.contents).length).toBe(1));
      expect(sent(f.contents)[0]).toMatchObject({ tool: 'context' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed on disk'));
      warn.mockRestore();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
