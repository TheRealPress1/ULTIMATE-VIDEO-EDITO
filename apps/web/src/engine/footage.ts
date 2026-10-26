import { getAssetFile, getLibrary } from '@diffusionstudio/runtime';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { requestFootage } from '@/lib/footage-cache';
import { MAX_TRANSCRIPTION_SECONDS, transcribeLocally } from '@/lib/local-transcription';
import { editorSession } from '@/dapi/session';
import { createTranscriptCut } from './transcript-cut';
import { resolveFootagePassage, searchFootage } from './footage-search';
import type { World } from 'koota';
import type { Asset, AssetLibrary } from '@diffusionstudio/assets';
import type { FootageIndexResult } from '@desktop/footage-types';
import type { FootageItem, FootageMatch, FootageSnapshot, PassageReference } from './footage-search';
import type { TranscriptCutOptions } from './transcript-cut';
export type { FootageItem, FootageMatch, FootageSnapshot, PassageReference } from './footage-search';

type Media = Extract<Asset, { type: 'AUDIO' | 'VIDEO' }>;
const isMedia = (asset: Asset): asset is Media => asset.type === 'AUDIO' || asset.type === 'VIDEO';
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const services = new WeakMap<World, FootageService>();

export function getFootageService(world: World, dir: string): FootageService {
	let service = services.get(world);
	if (!service || service.dir !== dir || service.disposed) {
		service?.dispose();
		service = new FootageService(world, dir);
		services.set(world, service);
	}
	return service;
}

export function disposeFootageService(world: World, dir: string): void {
	const service = services.get(world);
	if (service?.dir === dir) { service.dispose(); services.delete(world); }
}

/** One project-scoped owner for UI and agent indexing, cancellation and source validation. */
export class FootageService {
	disposed = false;
	private state: FootageSnapshot = { items: [], loading: false, indexing: false };
	private listeners = new Set<() => void>();
	private loading?: Promise<void>;
	private loadController?: AbortController;
	private reloadRequested = false;
	private controller?: AbortController;
	private cutting = false;
	private readonly world: World;
	readonly dir: string;
	constructor(world: World, dir: string) { this.world = world; this.dir = dir; }
	snapshot = (): FootageSnapshot => this.state;
	subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => this.listeners.delete(callback); };
	private publish(patch: Partial<FootageSnapshot>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const callback of this.listeners) callback();
	}
	private put(item: FootageItem): void {
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
	private request(asset: Media) { return { dir: this.dir, source: asset.source, duration: asset.duration }; }
	private currentAsset(library: AssetLibrary, asset: Media): void {
		const current = library.get(asset.id);
		if (!current || current.path !== asset.path || current.source !== asset.source || !isMedia(current) || current.duration !== asset.duration) {
			throw new Error('This source moved or changed. Refresh the footage library and try again.');
		}
	}
	private setResult(asset: Media, result: FootageIndexResult): void {
		const previous = this.state.items.find((item) => item.assetId === asset.id);
		this.put({ assetId: asset.id, path: asset.path, fingerprint: result.fingerprint,
			status: result.transcript === null ? (result.partial?.completed ? 'partial' : previous?.fingerprint && previous.fingerprint !== result.fingerprint ? 'stale' : 'unindexed')
				: result.transcript.some((segment) => segment.words.length) ? 'ready' : 'no-speech',
			segments: result.transcript ?? undefined, partial: result.partial });
	}
	private async refresh(asset: Media, library: AssetLibrary, signal?: AbortSignal): Promise<FootageIndexResult> {
		this.guard(library, signal);
		this.currentAsset(library, asset);
		const result = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_GET, this.request(asset), signal);
		this.guard(library, signal);
		this.currentAsset(library, asset);
		this.setResult(asset, result);
		return result;
	}
	load(): Promise<void> {
		if (this.loading) { this.reloadRequested = true; return this.loading; }
		if (this.state.indexing) { this.reloadRequested = true; return Promise.resolve(); }
		const controller = new AbortController(); this.loadController = controller;
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
						try { await this.refresh(asset, library, controller.signal); }
						catch (error) {
							this.guard(library, controller.signal);
							if (library.get(asset.id)) this.put({ assetId: asset.id, path: asset.path, status: 'error', error: message(error) });
						}
					}
				} while (this.reloadRequested && !this.disposed);
			} finally { this.publish({ loading: false }); }
		};
		this.loading = run().finally(() => { this.loading = undefined; this.loadController = undefined; });
		return this.loading;
	}
	indexAll(): Promise<void> { return this.indexPaths(); }
	async indexPaths(paths?: string[], externalSignal?: AbortSignal): Promise<void> {
		if (this.controller || this.cutting) throw new Error('Footage is already being processed. Wait for it to finish or cancel indexing.');
		const controller = new AbortController();
		this.controller = controller;
		const cancel = () => { this.loadController?.abort(externalSignal?.reason); controller.abort(externalSignal?.reason); };
		externalSignal?.addEventListener('abort', cancel, { once: true });
		if (externalSignal?.aborted) cancel();
		const signal = controller.signal;
		try {
			signal.throwIfAborted();
			if (this.loading) await this.loading;
			const library = getLibrary(this.world);
			this.guard(library, signal);
			const assets = paths ? [...new Set(paths)].map((path) => {
				const asset = library.get(path) ?? library.bySource(path);
				if (!asset || !isMedia(asset)) throw new Error(`Import this audio or video into the project first: ${path}`);
				return { ...asset };
			}) : library.list().filter(isMedia).map((asset) => ({ ...asset }));
			this.publish({ indexing: true, error: undefined, progress: { completed: 0, total: assets.length } });
			for (const [index, asset] of assets.entries()) {
				this.guard(library, signal);
				this.publish({ progress: { completed: index, total: assets.length, currentPath: asset.path } });
				try {
					const cached = await this.refresh(asset, library, signal);
					if (cached.transcript !== null) continue;
					if (asset.duration > MAX_TRANSCRIPTION_SECONDS) throw new Error('Footage indexing supports recordings up to two hours.');
					this.put({ assetId: asset.id, path: asset.path, fingerprint: cached.fingerprint, status: 'indexing' });
					const file = await getAssetFile(asset, true);
					this.guard(library, signal);
					this.currentAsset(library, asset);
					const transcript = await transcribeLocally(file, { signal,
						cache: { ...this.request(asset), expectedFingerprint: cached.fingerprint },
						assertCurrent: () => { this.guard(library, signal); this.currentAsset(library, asset); },
						onProgress: (progress) => {
						if (!signal.aborted) {
							this.publish({ progress: { completed: index, total: assets.length, currentPath: asset.path, message: progress.message, percent: progress.progress } });
							if (progress.completedChunks !== undefined && progress.totalChunks) this.put({ assetId: asset.id, path: asset.path, fingerprint: cached.fingerprint, status: 'indexing', partial: { completed: progress.completedChunks, total: progress.totalChunks } });
						}
					} });
					this.guard(library, signal);
					this.currentAsset(library, asset);
					const result = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_PUT, { ...this.request(asset), expectedFingerprint: cached.fingerprint, transcript }, signal);
					this.guard(library, signal);
					this.currentAsset(library, asset);
					this.setResult(asset, result);
				} catch (error) {
					this.guard(library, signal);
					this.put({ assetId: asset.id, path: asset.path, status: 'error', error: message(error) });
				}
			}
			this.publish({ progress: { completed: assets.length, total: assets.length } });
		} catch (error) {
			this.publish({ error: signal.aborted ? 'Indexing stopped. Completed speech sections are saved; resume to continue.' : message(error) });
			throw error;
		} finally {
			externalSignal?.removeEventListener('abort', cancel);
			this.controller = undefined;
			this.publish({ indexing: false, items: this.state.items.map((item) => item.status === 'indexing' ? { ...item, status: item.partial?.completed ? 'partial' : 'unindexed' } : item) });
			if (this.reloadRequested && !this.disposed) {
				try { await this.load(); } catch (error) { this.publish({ error: message(error) }); }
			}
		}
	}
	cancel(): void { this.loadController?.abort(); this.controller?.abort(new DOMException('Indexing canceled', 'AbortError')); }
	dispose(): void { this.loadController?.abort(); this.cancel(); this.disposed = true; this.listeners.clear(); }
	search(query: string): FootageMatch[] { return searchFootage(this.state.items, query); }
	async resolvePassages(refs: readonly PassageReference[], signal?: AbortSignal): Promise<FootageMatch[]> {
		if (!Array.isArray(refs) || !refs.length || refs.length > 100) throw new Error('Choose between 1 and 100 transcript passages.');
		const selected = refs.map((ref) => ({ ...ref }));
		const library = getLibrary(this.world);
		this.guard(library, signal);
		const assets = new Map<string, Media>();
		for (const id of new Set(selected.map((ref) => ref.assetId))) {
			const asset = library.get(id);
			if (!asset || !isMedia(asset)) throw new Error('A selected source is no longer in this project. Search the footage again.');
			assets.set(id, { ...asset });
		}
		for (const asset of assets.values()) {
			try { await this.refresh(asset, library, signal); }
			catch (error) { this.put({ assetId: asset.id, path: asset.path, status: 'error', error: message(error) }); throw error; }
		}
		this.guard(library, signal);
		for (const asset of assets.values()) this.currentAsset(library, asset);
		return selected.map((ref) => resolveFootagePassage(this.state.items.find((item) => item.assetId === ref.assetId), ref, assets.get(ref.assetId)!.duration));
	}
	async validateSelections(matches: readonly PassageReference[]): Promise<void> { await this.resolvePassages(matches); }
	async createCut(matches: readonly PassageReference[], options: Pick<TranscriptCutOptions, 'name' | 'width' | 'height'> = {}, signal?: AbortSignal) {
		if (this.cutting || this.controller) throw new Error('Wait for the current footage operation to finish before creating a cut.');
		this.cutting = true;
		try {
			const refs = matches.map((match) => ({ assetId: match.assetId, fingerprint: match.fingerprint, sourceIn: match.sourceIn, sourceOut: match.sourceOut }));
			const resolved = await this.resolvePassages(refs, signal);
			const library = getLibrary(this.world);
			return await createTranscriptCut(this.world, this.dir, resolved, { ...options,
				assertCurrent: () => this.guard(library, signal),
				validateSources: async () => { await this.resolvePassages(refs, signal); },
			});
		} finally { this.cutting = false; }
	}
}
