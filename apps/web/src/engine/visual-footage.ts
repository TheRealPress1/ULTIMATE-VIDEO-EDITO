import { getLibrary } from '@diffusionstudio/runtime';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { indexVisualLocally } from '@/lib/visual-index';
import { editorSession } from '@/dapi/session';
import { searchVisualFootage } from './visual-search';
import { SemanticFootage } from './semantic-footage';
import type { World } from 'koota';
import type { Asset, AssetLibrary } from '@diffusionstudio/assets';
import type { VisualIndexResult } from '@desktop/visual-types';
import type { VisualItem, VisualMatch, VisualSnapshot } from './visual-search';
export type { VisualItem, VisualMatch, VisualSnapshot } from './visual-search';

type Media = Extract<Asset, { type: 'VIDEO' }>;
const isMedia = (asset: Asset): asset is Media => asset.type === 'VIDEO';
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const services = new WeakMap<World, VisualService>();

export function getVisualService(world: World, dir: string): VisualService {
	let service = services.get(world);
	if (!service || service.dir !== dir || service.disposed) {
		service?.dispose();
		service = new VisualService(world, dir);
		services.set(world, service);
	}
	return service;
}

export function disposeVisualService(world: World, dir: string): void {
	const service = services.get(world);
	if (service?.dir === dir) { service.dispose(); services.delete(world); }
}

/** One project-scoped owner for UI and agent indexing, cancellation and source validation. */
export class VisualService {
	disposed = false;
  readonly descriptions = new SemanticFootage(this);
	private state: VisualSnapshot = { items: [], loading: false, indexing: false };
	private listeners = new Set<() => void>();
	private loading?: Promise<void>;
	private reloadRequested = false;
	private controller?: AbortController;
	private readonly world: World;
	readonly dir: string;
	constructor(world: World, dir: string) { this.world = world; this.dir = dir; }
	snapshot = (): VisualSnapshot => this.state;
	subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => this.listeners.delete(callback); };
	private publish(patch: Partial<VisualSnapshot>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const callback of this.listeners) callback();
	}
	private put(item: VisualItem): void {
		this.publish({ items: this.state.items.some((existing) => existing.assetId === item.assetId)
			? this.state.items.map((existing) => existing.assetId === item.assetId ? item : existing)
			: [...this.state.items, item] });
	}
	private guard(library: AssetLibrary, signal?: AbortSignal): void {
		signal?.throwIfAborted();
		const session = editorSession();
		if (this.disposed || getLibrary(this.world) !== library || !session || session.world !== this.world || session.project.dir() !== this.dir) {
			throw new Error('The open project changed. Open the intended project and try again.');
		}
	}
	private async request(asset: Media) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await asset.handle.getFile()) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('This source has no video track.');
      // Match runtime Video.framesToSeconds and asset probing, including MP4 empty edits.
      const sourceStart = Math.max(0, (await track.getFirstTimestamp()) ?? 0);
      if (!Number.isFinite(sourceStart)) throw new Error('The video track has an invalid presentation clock.');
      return { dir: this.dir, source: asset.source, duration: asset.duration, sourceStart };
    } finally { input.dispose(); }
  }
	private currentAsset(library: AssetLibrary, asset: Media): void {
		const current = library.get(asset.id);
		if (!current || current.path !== asset.path || current.source !== asset.source || !isMedia(current) || current.duration !== asset.duration) {
			throw new Error('This video source moved or changed. Refresh the footage library and try again.');
		}
	}
	private setResult(asset: Media, result: VisualIndexResult): void {
    const previous = this.state.items.find((item) => item.assetId === asset.id);
    this.put({ assetId: asset.id, path: asset.path, fingerprint: result.fingerprint,
      status: result.analysis ? 'ready' : previous?.fingerprint && previous.fingerprint !== result.fingerprint ? 'stale' : 'unindexed',
      analysis: result.analysis ?? undefined });
  }
	private async refresh(asset: Media, library: AssetLibrary, signal?: AbortSignal): Promise<VisualIndexResult> {
		this.guard(library, signal);
		this.currentAsset(library, asset);
		const request = await this.request(asset);
    this.guard(library, signal); this.currentAsset(library, asset);
		const result = await mainBridge.call(MAIN_CHANNELS.VISUAL_GET, request);
		this.guard(library, signal);
		this.currentAsset(library, asset);
		this.setResult(asset, result);
		return result;
	}
	load(): Promise<void> {
		if (this.loading) { this.reloadRequested = true; return this.loading; }
		if (this.state.indexing) { this.reloadRequested = true; return Promise.resolve(); }
		const run = async () => {
			const library = getLibrary(this.world);
			this.guard(library);
			this.publish({ loading: true, error: undefined });
			try {
				do {
					this.reloadRequested = false;
					// Library assets mutate in place on rename/relink. Snapshot their
					// identity before awaits so currentAsset can detect those changes.
					const assets = library.list().filter(isMedia).map((asset) => ({ ...asset }));
					const ids = new Set(assets.map((asset) => asset.id));
					this.publish({ items: this.state.items.filter((item) => ids.has(item.assetId)) });
					for (const asset of assets) {
						try { await this.refresh(asset, library); }
						catch (error) {
							this.guard(library);
							if (library.get(asset.id)) this.put({ assetId: asset.id, path: asset.path, status: 'error', error: message(error) });
						}
					}
				} while (this.reloadRequested && !this.disposed);
			} finally { this.publish({ loading: false }); }
		};
		this.loading = run().finally(() => { this.loading = undefined; });
		return this.loading;
	}
	indexAll(): Promise<void> { return this.indexPaths(); }
	async indexPaths(paths?: string[], externalSignal?: AbortSignal): Promise<void> {
		if (this.descriptions.snapshot().busy) throw new Error('Description processing is running. Wait or cancel it before indexing visuals.');
		if (this.controller) throw new Error('Footage is already being processed. Wait for it to finish or cancel indexing.');
		const controller = new AbortController();
		this.controller = controller;
		const cancel = () => controller.abort(externalSignal?.reason);
		externalSignal?.addEventListener('abort', cancel, { once: true });
		if (externalSignal?.aborted) cancel();
		const signal = controller.signal;
		try {
			signal.throwIfAborted();
			await this.load();
			const library = getLibrary(this.world);
			this.guard(library, signal);
			const assets = paths ? [...new Set(paths)].map((path) => {
				const asset = library.get(path) ?? library.bySource(path);
				if (!asset || !isMedia(asset)) throw new Error(`Import this video into the project first: ${path}`);
				return { ...asset };
			}) : library.list().filter(isMedia).map((asset) => ({ ...asset }));
			this.publish({ indexing: true, error: undefined, progress: { completed: 0, total: assets.length, path: "" } });
			for (const [index, asset] of assets.entries()) {
				this.guard(library, signal);
				this.publish({ progress: { completed: index, total: assets.length, path: asset.path } });
				try {
					const cached = await this.refresh(asset, library, signal);
					if (cached.analysis !== null) continue;
          this.put({ assetId: asset.id, path: asset.path, fingerprint: cached.fingerprint, status: 'indexing' });
          const request = await this.request(asset);
          this.guard(library, signal); this.currentAsset(library, asset);
          const result = await indexVisualLocally(request, { signal, onProgress: (frames) => {
            if (!signal.aborted) this.publish({ progress: { completed: index, total: assets.length, path: asset.path, frames } });
          } });
          this.guard(library, signal);
          this.currentAsset(library, asset);
					this.setResult(asset, result);
				} catch (error) {
					this.guard(library, signal);
					this.put({ assetId: asset.id, path: asset.path, status: 'error', error: message(error) });
				}
			}
			this.publish({ progress: { completed: assets.length, total: assets.length, path: "" } });
		} catch (error) {
			this.publish({ error: signal.aborted ? 'Indexing stopped. Completed visual indexes are saved.' : message(error) });
			throw error;
		} finally {
			externalSignal?.removeEventListener('abort', cancel);
			this.controller = undefined;
			this.publish({ indexing: false, items: this.state.items.map((item) => item.status === 'indexing' ? { ...item, status: 'unindexed' } : item) });
			if (this.reloadRequested && !this.disposed) {
				try { await this.load(); } catch (error) { this.publish({ error: message(error) }); }
			}
		}
	}
	cancel(): void { this.controller?.abort(new DOMException('Indexing canceled', 'AbortError')); }
	dispose(): void { this.cancel(); this.descriptions.dispose(); this.disposed = true; this.listeners.clear(); }
  assertCurrent(): void { this.guard(getLibrary(this.world)); }
  search(query: string): VisualMatch[] { return searchVisualFootage(this.state.items, query); }
  async validateMatch(match: VisualMatch): Promise<Media> {
    const library = getLibrary(this.world);
    this.guard(library);
    const current = library.get(match.assetId);
    if (!current || !isMedia(current) || current.path !== match.path) throw new Error('This video moved or is no longer available. Search again.');
    const asset = { ...current };
    const result = await this.refresh(asset, library);
    if (result.fingerprint !== match.fingerprint || !result.analysis?.samples.some((sample) => sample.time === match.time)) {
      throw new Error('The source changed or is no longer indexed. Search again.');
    }
    return current;
  }
}
