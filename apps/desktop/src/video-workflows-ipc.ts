import { app, BrowserWindow, type WebContents } from 'electron';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { mainBridge } from './main-manager';
import { MAIN_CHANNELS } from './main-channels';
import { realPathEntry } from './projects';
import { LocalReferenceStyleService } from './reference-index';
import { LocalPlaybackProxyService } from './playback-proxy';
import type { PlaybackProxyRequest, PlaybackProxyResult } from './playback-proxy-types';

/** Renderer-owned jobs: navigation cancels work; project generations own cache pins. */
export function registerVideoWorkflows(): void {
  const reference = new LocalReferenceStyleService({ runtimePath: join(app.getAppPath(), 'dist', 'reference-style') });
  const playback = new LocalPlaybackProxyService({ runtimePath: join(app.getAppPath(), 'dist', 'playback-proxy'), cacheDir: join(app.getPath('userData'), 'playback-cache') });
  const references = new Map<string, { owner: number; cancel: () => void }>();
  mainBridge.handle(MAIN_CHANNELS.REFERENCE_GET, async (request) => {
    const source = await realPathEntry(request.dir, request.source);
    if (!source) throw new Error('Relink this reference to a local video first.');
    return reference.get({ ...request, source });
  });
  mainBridge.handle(MAIN_CHANNELS.REFERENCE_ANALYZE, async (request, event) => {
    if (references.has(request.id)) throw new Error('This reference is already being analyzed.');
    const sender = event.sender, window = BrowserWindow.fromWebContents(sender);
    let canceled = false;
    const cancel = () => { canceled = true; reference.cancel(request.id); };
    references.set(request.id, { owner: sender.id, cancel });
    sender.once('destroyed', cancel); sender.once('render-process-gone', cancel); sender.once('did-start-loading', cancel);
    try {
      const source = await realPathEntry(request.dir, request.source);
      if (canceled) throw new Error('Reference analysis canceled.');
      if (!source) throw new Error('Relink this reference to a local video first.');
      return await reference.analyze({ ...request, source }, (value) => { if (!canceled && !sender.isDestroyed()) mainBridge.emit(window, MAIN_CHANNELS.REFERENCE_PROGRESS, value); });
    } finally {
      references.delete(request.id);
      sender.removeListener('destroyed', cancel); sender.removeListener('render-process-gone', cancel); sender.removeListener('did-start-loading', cancel);
    }
  });
  mainBridge.handle(MAIN_CHANNELS.REFERENCE_CANCEL, ({ id }, event) => { const job = references.get(id); if (job?.owner === event.sender.id) job.cancel(); });

  type Scope = { key: string; dir: Promise<string>; alive: boolean };
  type Owner = { sessions: Map<string, Scope>; cleanup: () => void };
  const owners = new Map<number, Owner>();
  const jobs = new Map<string, { scope: Scope; sender: number; cancel: () => void }>();
  const release = (scope: Scope) => {
    scope.alive = false;
    for (const job of jobs.values()) if (job.scope === scope) job.cancel();
    playback.release(scope.key);
  };
  function ownerFor(sender: WebContents): Owner {
    const existing = owners.get(sender.id); if (existing) return existing;
    const owner: Owner = { sessions: new Map(), cleanup: () => {
      for (const scope of owner.sessions.values()) release(scope);
      // Keep retired generations until the renderer is destroyed. A late IPC
      // request must never resurrect a disposed project's pins.
      if (sender.isDestroyed()) owners.delete(sender.id);
    } };
    owners.set(sender.id, owner);
    sender.once('destroyed', owner.cleanup); sender.on('render-process-gone', owner.cleanup); sender.on('did-start-loading', owner.cleanup);
    return owner;
  }
  function scopeFor(sender: WebContents, request: { dir: string; sessionId?: string }): Scope {
    if (!request || typeof request.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.sessionId) || typeof request.dir !== 'string') throw new Error('Invalid playback session.');
    const owner = ownerFor(sender);
    let scope = owner.sessions.get(request.sessionId);
    if (!scope) {
      scope = { key: `${sender.id}:${request.sessionId}`, dir: realpath(request.dir), alive: true };
      // The awaited consumer handles directory failures.
      void scope.dir.catch(() => {});
      owner.sessions.set(request.sessionId, scope);
    }
    return scope;
  }
  async function sourceFor(scope: Scope, request: PlaybackProxyRequest): Promise<PlaybackProxyRequest> {
    const [dir, expected] = await Promise.all([realpath(request.dir), scope.dir]);
    if (!scope.alive || dir !== expected) throw new Error('This playback session has closed.');
    const source = await realPathEntry(dir, request.source);
    if (!scope.alive) throw new Error('This playback session has closed.');
    if (!source) throw new Error('This video is unavailable. Continue with the original or relink it.');
    return { ...request, dir, source };
  }
  function pin(scope: Scope, result: PlaybackProxyResult): PlaybackProxyResult {
    if (!scope.alive) throw new Error('This playback session has closed.');
    if (result.proxy) playback.pin(scope.key, result.proxy.path);
    return result;
  }
  mainBridge.handle(MAIN_CHANNELS.PLAYBACK_PROXY_GET, async (request, event) => {
    const scope = scopeFor(event.sender, request);
    return pin(scope, await playback.get(await sourceFor(scope, request)));
  });
  mainBridge.handle(MAIN_CHANNELS.PLAYBACK_PROXY_PREPARE, async (request, event) => {
    if (jobs.has(request.id)) throw new Error('This playback job is already running.');
    const sender = event.sender, scope = scopeFor(sender, request), window = BrowserWindow.fromWebContents(sender);
    let canceled = false;
    const cancel = () => { canceled = true; playback.cancel(request.id); };
    jobs.set(request.id, { scope, sender: sender.id, cancel });
    try {
      const source = await sourceFor(scope, request);
      if (canceled) throw new Error('Playback preparation canceled.');
      const result = await playback.prepare({ ...source, id: request.id }, (value) => {
        if (!canceled && scope.alive && !sender.isDestroyed()) mainBridge.emit(window, MAIN_CHANNELS.PLAYBACK_PROXY_PROGRESS, value);
      });
      if (canceled) throw new Error('Playback preparation canceled.');
      return pin(scope, result);
    } finally { jobs.delete(request.id); }
  });
  mainBridge.handle(MAIN_CHANNELS.PLAYBACK_PROXY_CANCEL, ({ id }, event) => { const job = jobs.get(id); if (job?.sender === event.sender.id) job.cancel(); });
  mainBridge.handle(MAIN_CHANNELS.PLAYBACK_PROXY_RELEASE, async (request, event) => {
    const scope = scopeFor(event.sender, request);
    const [actual, expected] = await Promise.all([realpath(request.dir).catch(() => request.dir), scope.dir.catch(() => request.dir)]);
    if (actual === expected) release(scope);
  });
  app.on('will-quit', () => { reference.dispose(); playback.dispose(); });
}
