import { getLibrary, PlaybackProxies, playbackAssetIdentity, type PlaybackProxyState } from '@diffusionstudio/runtime';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { AssetLibrary, VideoAsset } from '@diffusionstudio/assets';
import type { World } from 'koota';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { PLAYBACK_PROXY_ENGINE, PLAYBACK_PROXY_MAX_SECONDS, type PlaybackProxyDescriptor, type PlaybackProxyProgress, type PlaybackProxyRequest } from '@desktop/playback-proxy-types';
import { mainBridge } from '@/lib/ipc';
import { preparePlaybackProxy } from '@/lib/playback-proxy';
import { ElectronFileHandle } from '@/lib/electron-file-handle';

export interface PlaybackProxyItem {
  assetId: string; path: string; identity: string;
  status: 'queued' | 'preparing' | 'ready' | 'error';
  error?: string; progress?: PlaybackProxyProgress;
}
export interface PlaybackProxySnapshot { enabled: boolean; paused: boolean; items: PlaybackProxyItem[] }
const services = new WeakMap<World, PlaybackProxyService>();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function needsPlaybackProxy(asset: VideoAsset): boolean {
  const pixels = asset.width * asset.height;
  return asset.duration > 0 && asset.duration <= PLAYBACK_PROXY_MAX_SECONDS && asset.frameRate > 0 &&
    (pixels > 1920 * 1080 || (asset.duration >= 120 && pixels > 1280 * 720));
}

export function getPlaybackProxyService(world: World, dir: string): PlaybackProxyService {
  let service = services.get(world);
  if (!service || service.dir !== dir || service.disposed) {
    service?.dispose();
    service = new PlaybackProxyService(world, dir);
    services.set(world, service);
  }
  return service;
}
export function disposePlaybackProxyService(world: World, dir: string): void {
  const service = services.get(world);
  if (service?.dir === dir) { service.dispose(); services.delete(world); }
}

/** Preview decoding is the only consumer of this derivative; library metadata stays original. */
export function playbackProxyAsset(source: VideoAsset, proxy: PlaybackProxyDescriptor): VideoAsset {
  // A cache rebuild at the same path must open fresh bytes, too.
  return { ...source, id: `playback:${PLAYBACK_PROXY_ENGINE}:${proxy.path}:${proxy.createdAt}`, source: proxy.path,
    handle: new ElectronFileHandle(proxy.path), width: proxy.width, height: proxy.height,
    channels: undefined, sampleRate: undefined, mimeType: 'video/mp4' };
}

/** One serial queue per project. All publication checks the source snapshot again after awaits. */
export class PlaybackProxyService {
  disposed = false;
  private readonly sessionId = crypto.randomUUID();
  private state: PlaybackProxySnapshot = { enabled: true, paused: false, items: [] };
  private readonly bindings: PlaybackProxyState = { enabled: true, entries: new Map() };
  private readonly listeners = new Set<() => void>();
  private controller?: AbortController;
  private running?: Promise<void>;
  private active?: PlaybackProxyItem;
  private verifying?: Promise<void>;
  constructor(private readonly world: World, readonly dir: string) { world.set(PlaybackProxies, this.bindings); }
  snapshot = (): PlaybackProxySnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<PlaybackProxySnapshot>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private put(item: PlaybackProxyItem): void {
    // A stale asynchronous result must not resurrect a removed/relinked item.
    if (!this.state.items.some((current) => current.assetId === item.assetId && current.identity === item.identity)) return;
    this.publish({ items: this.state.items.map((current) => current.assetId === item.assetId ? item : current) });
  }
  private guard(library: AssetLibrary, asset?: VideoAsset, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.disposed || getLibrary(this.world) !== library) throw new DOMException('Project closed', 'AbortError');
    if (asset) {
      const current = library.get(asset.id);
      if (current?.type !== 'VIDEO' || playbackAssetIdentity(current) !== playbackAssetIdentity(asset)) {
        throw new DOMException('Video source changed', 'AbortError');
      }
    }
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const library = getLibrary(this.world);
    const assets = library.list().filter((asset): asset is VideoAsset => asset.type === 'VIDEO' && needsPlaybackProxy(asset));
    const items = assets.map((asset) => {
      const identity = playbackAssetIdentity(asset);
      const prior = this.state.items.find((item) => item.assetId === asset.id && item.identity === identity);
      return prior ? { ...prior, path: asset.path } : { assetId: asset.id, path: asset.path, identity, status: 'queued' as const };
    });
    for (const [id, binding] of this.bindings.entries) {
      if (!items.some((item) => item.assetId === id && item.identity === binding.identity)) this.bindings.entries.delete(id);
    }
    if (this.active && !items.some((item) => item.assetId === this.active!.assetId && item.identity === this.active!.identity)) this.controller?.abort();
    this.publish({ items });
    return this.pump();
  }
  private pump(): Promise<void> {
    if (this.running) return this.running;
    if (this.disposed || this.state.paused || !this.state.enabled) return Promise.resolve();
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (!this.disposed && this.state.enabled && !this.state.paused && this.state.items.some((item) => item.status === 'queued')) void this.pump();
    });
    return this.running;
  }
  private async request(asset: VideoAsset): Promise<PlaybackProxyRequest> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await asset.handle.getFile()) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('This source has no video track.');
      const sourceStart = Math.max(0, (await track.getFirstTimestamp()) ?? 0);
      if (!Number.isFinite(sourceStart)) throw new Error('This source has an invalid video clock.');
      return { dir: this.dir, sessionId: this.sessionId, source: asset.source, sourceStart, duration: asset.duration,
        width: asset.width, height: asset.height, frameRate: asset.frameRate };
    } finally { input.dispose(); }
  }
  private async run(): Promise<void> {
    while (!this.disposed && this.state.enabled && !this.state.paused) {
      const item = this.state.items.find((item) => item.status === 'queued');
      if (!item) return;
      const library = getLibrary(this.world);
      const current = library.get(item.assetId);
      if (current?.type !== 'VIDEO') { this.publish({ items: this.state.items.filter((entry) => entry !== item) }); continue; }
      const asset = { ...current, stat: current.stat ? { ...current.stat } : undefined };
      const controller = new AbortController();
      this.controller = controller; this.active = item;
      const { signal } = controller;
      this.put({ ...item, status: 'preparing', error: undefined });
      try {
        this.guard(library, asset, signal);
        const request = await this.request(asset);
        this.guard(library, asset, signal);
        // Native preparation first checks its persistent cache. Doing the cache
        // check within the job also makes its initial full-source hash cancellable.
        const result = await preparePlaybackProxy(request, { signal,
          onProgress: (progress) => this.put({ ...item, status: 'preparing', progress }) });
        this.guard(library, asset, signal);
        const proxy = result.proxy;
        if (!proxy || result.status !== 'ready' || proxy.fingerprint !== result.fingerprint ||
          Math.abs(proxy.sourceStart - request.sourceStart) > 0.001 || Math.abs(proxy.proxyStart) > 0.001 ||
          proxy.sourceWidth !== asset.width || proxy.sourceHeight !== asset.height ||
          !(proxy.width > 0 && proxy.height > 0) || Math.abs(proxy.duration - asset.duration) > Math.max(0.2, 2 / asset.frameRate)) {
          throw new Error('Lighter playback could not preserve this video’s timing or dimensions.');
        }
        // A file may be replaced during native preparation without a library event.
        const stat = await library.fs.stat(asset.source);
        this.guard(library, asset, signal);
        if (!stat || (asset.stat && (stat.size !== asset.stat.size || Math.floor(stat.mtime) !== Math.floor(asset.stat.mtime)))) throw new Error('The source changed while lighter playback was being prepared.');
        this.bindings.entries.set(asset.id, { identity: item.identity, asset: playbackProxyAsset(asset, proxy),
          onFailure: () => this.put({ ...item, status: 'error', error: 'Lighter playback was unavailable. Using the original video.' }) });
        this.put({ ...item, status: 'ready' });
      } catch (error) {
        this.put({ ...item, status: signal.aborted ? 'queued' : 'error', error: signal.aborted ? undefined : message(error) });
      } finally {
        this.controller = undefined; this.active = undefined;
      }
    }
  }
  setPaused(paused: boolean): void {
    if (this.state.paused === paused) return;
    this.publish({ paused });
    if (paused) this.controller?.abort(); else void this.pump();
  }
  setEnabled(enabled: boolean): void {
    this.bindings.enabled = enabled;
    this.publish({ enabled });
    if (!enabled) this.controller?.abort(); else void this.pump();
  }
  retry(): void {
    this.publish({ items: this.state.items.map((item) => item.status === 'error' ? { ...item, status: 'queued', error: undefined } : item) });
    void this.pump();
  }
  /** Linked files outside the project do not emit project watcher events. */
  verifySources(): Promise<void> {
    if (this.verifying || this.disposed) return this.verifying ?? Promise.resolve();
    this.verifying = (async () => {
      const library = getLibrary(this.world);
      let reload = false;
      for (const item of [...this.state.items]) {
        const asset = library.get(item.assetId);
        if (asset?.type !== 'VIDEO') continue;
        const identity = playbackAssetIdentity(asset);
        let stat;
        try { stat = await library.fs.stat(asset.source); } catch { stat = null; }
        if (this.disposed || getLibrary(this.world) !== library) return;
        if (identity !== playbackAssetIdentity(asset)) continue;
        if (!stat || (asset.stat && (stat.size !== asset.stat.size || Math.floor(stat.mtime) !== Math.floor(asset.stat.mtime)))) {
          this.bindings.entries.delete(asset.id);
          if (this.active?.assetId === asset.id) this.controller?.abort();
          this.put({ ...item, status: 'error', error: stat ? 'Source changed. Refreshing lighter playback.' : 'Source unavailable. Reconnect the original video.' });
          reload ||= !!stat;
        }
      }
      if (reload) { await library.load(); if (!this.disposed && getLibrary(this.world) === library) await this.refresh(); }
    })().catch(() => { /* A disconnected disk must not stop editing. */ }).finally(() => { this.verifying = undefined; });
    return this.verifying;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.abort();
    this.bindings.enabled = false;
    this.bindings.entries.clear();
    if (this.world.get(PlaybackProxies) === this.bindings) this.world.set(PlaybackProxies, null);
    this.listeners.clear();
    // Native cancellation must settle before releasing files pinned by its reply.
    void Promise.resolve(this.running).finally(() => mainBridge.call(MAIN_CHANNELS.PLAYBACK_PROXY_RELEASE, { dir: this.dir, sessionId: this.sessionId })).catch(() => {});
  }
}
