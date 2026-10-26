import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { World } from 'koota';
import type { ToolContext } from '../handler';
import type { EditorSession } from '../session';
import { beginEditorLoad, editorSession, setEditorSession, waitForEditorSession } from '../session';
import { open } from './open';

const project = { id: 'project-id', name: 'Test project', dir: '/test/project' };
const makeSession = (dir = project.dir): EditorSession => ({ world: {} as World, project: { dir: () => dir }, engine: {} } as EditorSession);
const context = (signal = new AbortController().signal): ToolContext => ({
  signal, session: editorSession, requireSession: () => editorSession()!,
  app: { openProject: vi.fn().mockResolvedValue(project) },
});
beforeEach(() => setEditorSession(null));
afterEach(() => { setEditorSession(null); vi.useRealTimers(); });

describe('open project readiness', () => {
  it('waits for the requested session and its compiled mount before replying', async () => {
    const old = makeSession('/old/project');
    setEditorSession(old);
    beginEditorLoad(old.world).ready();
    const completed = vi.fn();
    const work = open({ dir: project.dir }, context());
    void work.then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();

    const next = makeSession();
    setEditorSession(next);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    const load = beginEditorLoad(next.world);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    load.ready();
    await expect(work).resolves.toEqual(project);
    expect(editorSession()).toBe(next);
  });

  it('allows an already mounted project without waiting for media decoding or background jobs', async () => {
    const current = makeSession();
    Object.defineProperty(current, 'engine', { get: () => { throw new Error('Do not wait for decoding'); } });
    setEditorSession(current);
    beginEditorLoad(current.world).ready();
    await expect(open({ dir: project.dir }, context())).resolves.toEqual(project);
  });

  it('propagates folder-open errors without waiting for a session', async () => {
    const ctx = context();
    vi.mocked(ctx.app.openProject).mockRejectedValue(new Error('Drive unavailable'));
    await expect(open({ dir: project.dir }, ctx)).rejects.toThrow('Drive unavailable');
  });

  it.each(['Project failed to compile: syntax error', 'Project failed to render', 'Cannot read the media library'])('propagates load failure: %s', async (message) => {
    const current = makeSession();
    const work = open({ dir: project.dir }, context());
    const rejected = expect(work).rejects.toThrow(message);
    await Promise.resolve();
    setEditorSession(current);
    beginEditorLoad(current.world).fail(new Error(message));
    await rejected;
  });

  it('ignores a superseded compile completion', async () => {
    const current = makeSession();
    setEditorSession(current);
    const old = beginEditorLoad(current.world);
    const latest = beginEditorLoad(current.world);
    const completed = vi.fn();
    const work = open({ dir: project.dir }, context());
    void work.then(completed);
    old.ready();
    old.fail(new Error('stale failure'));
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    latest.ready();
    await expect(work).resolves.toEqual(project);
  });

  it('does not navigate when the caller already canceled', async () => {
    const ctx = context(AbortSignal.abort());
    await expect(open({ dir: project.dir }, ctx)).rejects.toMatchObject({ code: 'canceled' });
    expect(ctx.app.openProject).not.toHaveBeenCalled();
  });

  it('cancels the pending readiness wait and removes its timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const work = open({ dir: project.dir }, context(controller.signal));
    const rejected = expect(work).rejects.toMatchObject({ code: 'canceled' });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a route that never publishes an editor session', async () => {
    vi.useFakeTimers();
    const work = open({ dir: project.dir }, context());
    const rejected = expect(work).rejects.toThrow('did not finish opening within 30 seconds');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects if the requested session closes before its mount finishes', async () => {
    const current = makeSession();
    setEditorSession(current);
    beginEditorLoad(current.world);
    const work = waitForEditorSession(project.dir, new AbortController().signal);
    const rejected = expect(work).rejects.toMatchObject({ code: 'canceled' });
    setEditorSession(null);
    await rejected;
  });

  it('rejects a relative project path without navigating', async () => {
    const ctx = context();
    await expect(open({ dir: 'relative/project' }, ctx)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(ctx.app.openProject).not.toHaveBeenCalled();
  });
});
