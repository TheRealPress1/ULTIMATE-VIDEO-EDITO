import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { authoredElement, authoredTree, renderAuthored } from '@diffusionstudio/reconciler';
import { focusRect, FrameRate, getCameraMatrix, getEntityChildren, Library, Root, Source } from '@diffusionstudio/runtime';
import { flushProjectEdits } from '@/projects/edits';
import { analyzeSpeakersLocally } from '@/lib/local-speaker';
import { SPEAKER_MAX_SECONDS } from '@desktop/speaker-types';
import type { SpeakerAnalysisResult } from '@desktop/speaker-types';
import { analyzeReframeLocally } from '@/lib/local-reframe';
import { getDocumentEditor, isPendingSource } from './editor';
import { getEditHistory } from './history';
import { resolveReframeTiming } from './reframe-timing';
import { validateSpeakerFraming } from './speaker-framing-options';
import type { SpeakerFramingOptions, SpeakerFramingSummary } from './speaker-framing-options';
import { cloneReframeTree, collectReframeVideos, planReframeVariants, videoSource } from './reframe-plan';
import type { World, Entity } from 'koota';
import type { VideoAsset } from '@diffusionstudio/assets';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { ReframeAnalysisResult } from '@desktop/reframe-types';
import type { ReframeFormat, ReframeMode, ReframeVideo } from './reframe-plan';

export { REFRAME_FORMATS } from './reframe-plan';
export type { ReframeFormat, ReframeMode } from './reframe-plan';
export interface ReframeProgress { phase: 'analyzing' | 'creating'; completed: number; total: number; path?: string }
export interface ReframeResult {
	variants: Array<{ sceneId: string; name: string; width: number; height: number; warnings: string[] }>;
	warnings: string[];
	faceCoverage: number | null;
	videoCount: number;
	speakerSummary?: SpeakerFramingSummary;
}
export interface ReframeOptions {
	formats: readonly ReframeFormat[];
	mode: ReframeMode;
	name?: string;
	speakerFraming?: SpeakerFramingOptions;
	signal?: AbortSignal;
	assertCurrent?: () => void;
	onProgress?: (progress: ReframeProgress) => void;
	analyzeSpeakers?: (video: ReframeVideo, signal: AbortSignal | undefined, onProgress: (completed: number, total: number) => void) => Promise<SpeakerAnalysisResult>;
	analyze?: (video: ReframeVideo, signal: AbortSignal | undefined, onProgress: (completed: number, total: number) => void) => Promise<ReframeAnalysisResult>;
}

const signature = (tree: AuthoredTree) => JSON.stringify(cloneReframeTree(tree), (_key, value: unknown) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);

/** Reframe copies are one ordinary composition edit, using the same writer and history as manual edits. */
export async function createReframeVariants(world: World, dir: string, sourceScene: Entity, options: ReframeOptions): Promise<ReframeResult> {
	validateSpeakerFraming(options.speakerFraming, options.mode);
	const root = world.get(Root);
	const library = world.get(Library);
	const original = authoredTree(world, sourceScene);
	if (!root?.isAlive() || !root.get(Source)?.value || !library || !original || original.tag !== 'scene') throw new Error('Open a project and select a scene before creating format versions.');
	const snapshot = cloneReframeTree(original);
	const originalSignature = signature(snapshot);
	const fps = world.get(FrameRate)?.value ?? 30;
	const assertCurrent = () => {
		options.signal?.throwIfAborted();
		options.assertCurrent?.();
		if (!root.isAlive() || world.get(Root) !== root || world.get(Library) !== library || !sourceScene.isAlive() || (world.get(FrameRate)?.value ?? 30) !== fps) throw new Error('The project changed while preparing format versions. Reopen the intended scene and try again.');
		const current = authoredTree(world, sourceScene);
		if (!current || signature(current) !== originalSignature) throw new Error('The source scene changed while preparing format versions. Review the scene and try again.');
	};
	assertCurrent();
	await flushProjectEdits(dir);
	assertCurrent();
	const paths = new Set<string>();
	const gather = (node: AuthoredTree) => { const path = videoSource(node); if (path) paths.add(path); node.children.forEach(gather); };
	gather(snapshot);
	const assets = new Map<string, VideoAsset>();
	const sourceStats = new Map<string, { size: number; mtime: number }>();
	for (const path of paths) {
		const asset = await library.resolve(path);
		assertCurrent();
		if (asset.type !== 'VIDEO') throw new Error(`${path} is not a video source.`);
		const saved = { ...asset, ...(asset.stat ? { stat: { ...asset.stat } } : {}) };
		const stat = await library.fs.stat(saved.source);
		assertCurrent();
		if (!stat || stat.size <= 0 || !Number.isFinite(stat.size) || !Number.isFinite(stat.mtime)) throw new Error(`${path} is not a readable local video source.`);
		// File.lastModified (the library manifest) has whole milliseconds;
		// the native stat keeps sub-millisecond precision for the later race check.
		if (saved.stat && (saved.stat.size !== stat.size || Math.floor(saved.stat.mtime) !== Math.floor(stat.mtime))) throw new Error(`${path} changed on disk. Re-import it before creating format versions.`);
		assets.set(path, saved);
		sourceStats.set(path, { size: stat.size, mtime: stat.mtime });
	}
	const collected = collectReframeVideos(snapshot, (path) => assets.get(path), { replaceCrop: options.mode === 'speakers' });
	let videos = collected;
	let sceneEnd: number | undefined;
	const timingSignature = (items: readonly ReframeVideo[], end: number | undefined) => JSON.stringify([end, items.map(({ key, start, end, timeline }) => ({ key, start, end, timeline }))]);
	if (options.mode === 'speakers') {
		const timing = resolveReframeTiming(world, sourceScene, videos, fps);
		videos = timing.videos; sceneEnd = timing.sceneEnd;
	}
	const originalTiming = timingSignature(videos, sceneEnd);
	// Validate output names, formats and all layer support before expensive analysis.
	planReframeVariants(snapshot, videos, new Map(), { ...options, fps, sceneEnd });
	const analyses = new Map<string, ReframeAnalysisResult>();
	const reusable = new Map<string, ReframeAnalysisResult>();
	const speakerAnalyses = new Map<string, SpeakerAnalysisResult>();
	const clocks = new Map<string, number>();
	const sourceClock = async (asset: VideoAsset) => {
		if (clocks.has(asset.id)) return clocks.get(asset.id)!;
		const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await asset.handle.getFile()) });
		try {
			const track = await input.getPrimaryVideoTrack();
			if (!track) throw new Error(`${asset.path} has no readable video track.`);
			const first = Math.max(0, await track.getFirstTimestamp()); assertCurrent();
			if (!Number.isFinite(first)) throw new Error('The source video has an invalid presentation clock.');
			clocks.set(asset.id, first); return first;
		} finally { input.dispose(); }
	};
	const analyze = options.analyze ?? (async (video, signal, onProgress) => analyzeReframeLocally(dir, video.asset.source, video.start, video.end, { signal, sourceStart: await sourceClock(video.asset), onProgress: (event) => onProgress(event.completed, event.total) }));
	const analyzeSpeakers = options.analyzeSpeakers ?? (async (video, signal, onProgress) => analyzeSpeakersLocally(dir, video.asset.source, video.start, video.end, { signal, sourceStart: await sourceClock(video.asset), onProgress: (event) => onProgress(event.completed, event.total) }));
	if (options.mode === 'follow') {
		for (let index = 0; index < videos.length; index++) {
			assertCurrent();
			const video = videos[index]!;
			if (video.end - video.start > 7200) throw new Error(`${video.path} spans more than two hours. Choose a shorter source range.`);
			const key = `${video.asset.id}:${video.start}:${video.end}`;
			options.onProgress?.({ phase: 'analyzing', completed: index, total: videos.length, path: video.path });
			let result = reusable.get(key);
			if (!result) {
				result = await analyze(video, options.signal, (completed, total) => options.onProgress?.({ phase: 'analyzing', completed: index + (total > 0 ? Math.min(1, completed / total) : 0), total: videos.length, path: video.path }));
				assertCurrent();
				if (!result || !Array.isArray(result.samples) || result.samples.length > 28800 || !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0 || Math.abs(result.width / result.height - video.asset.width / video.asset.height) > 0.02) throw new Error(`Face analysis for ${video.path} returned different frame dimensions. Re-import the source before reframing.`);
				reusable.set(key, result);
			}
			analyses.set(video.key, result);
		}
	}
	if (options.mode === 'speakers') {
		const reused = new Map<string, SpeakerAnalysisResult>();
		for (let index = 0; index < videos.length; index++) {
			assertCurrent(); const video = videos[index]!;
			if (video.end - video.start > SPEAKER_MAX_SECONDS) throw new Error(`${video.path} spans more than two hours. Choose a shorter source range.`);
			const key = `${video.asset.id}:${video.start}:${video.end}`;
			options.onProgress?.({ phase: 'analyzing', completed: index, total: videos.length, path: video.path });
			let result = reused.get(key);
			if (!result) {
				result = await analyzeSpeakers(video, options.signal, (completed, total) => options.onProgress?.({ phase: 'analyzing', completed: index + Math.min(1, completed / Math.max(1, total)), total: videos.length, path: video.path }));
				assertCurrent();
				if (!result || !Array.isArray(result.samples) || result.samples.length > 14400 || !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0 || Math.abs(result.width / result.height - video.asset.width / video.asset.height) > 0.02 || Math.abs(result.start - video.start) > 0.001 || Math.abs(result.end - video.end) > 0.05) throw new Error(`Speaker analysis for ${video.path} did not match its source timing or dimensions.`);
				reused.set(key, result);
			}
			speakerAnalyses.set(video.key, result);
		}
	}
	assertCurrent();
	for (const [path, asset] of assets) {
		const current = await library.resolve(path);
		assertCurrent();
		if (current.id !== asset.id || current.source !== asset.source || current.type !== 'VIDEO' || current.width !== asset.width || current.height !== asset.height || current.duration !== asset.duration) throw new Error('A video source changed while preparing format versions. Re-import it and try again.');
		const stat = await library.fs.stat(asset.source);
		assertCurrent();
		const before = sourceStats.get(path)!;
		if (!stat || stat.size !== before.size || stat.mtime !== before.mtime) throw new Error(`${path} changed on disk while preparing format versions. Review the source and try again.`);
	}
	if (options.mode === 'speakers') {
		const current = resolveReframeTiming(world, sourceScene, collected, fps);
		if (timingSignature(current.videos, current.sceneEnd) !== originalTiming) throw new Error('The video timing changed while preparing format versions. Let media finish loading and try again.');
	}
	const plan = planReframeVariants(snapshot, videos, analyses, { ...options, fps, sceneEnd, speakerAnalyses });
	const edges = getEntityChildren(world, root).flatMap((entity) => {
		const element = authoredElement(entity);
		if (element?.tag !== 'scene') return [];
		const { x = 0, width } = element.props;
		return typeof x === 'number' && typeof width === 'number' && Number.isFinite(x + width) ? [x + width] : [];
	});
	let nextX = edges.length ? Math.max(...edges) + 120 : 0;
	for (const variant of plan.variants) {
		Object.assign(variant.tree.props, { x: nextX, y: -variant.height / 2 });
		nextX += variant.width + 120;
	}
	options.onProgress?.({ phase: 'creating', completed: 0, total: plan.variants.length });
	assertCurrent();
	const editor = getDocumentEditor(world);
	const history = getEditHistory(world);
	const before = new Set(world.query(Source));
	const reported = new Set<string>();
	const unlisten = editor.onEdit((edit) => { if (edit.kind === 'insert') reported.add(edit.source); });
	const scenes: Entity[] = [];
	const step = history.beginGroup();
	try {
		for (const variant of plan.variants) {
			const [scene] = editor.insertElement(root, () => renderAuthored(variant.tree));
			if (!scene) throw new Error('A format version could not be inserted into the project.');
			scenes.push(scene);
		}
	} catch (error) {
		for (const entity of [...world.query(Source)].filter((item) => !before.has(item))) {
			if (!entity.isAlive()) continue;
			const source = entity.get(Source)?.value;
			if (!source || !isPendingSource(source)) continue;
			if (reported.has(source)) editor.remove(entity); else editor.discardPending(source);
		}
		throw error;
	} finally { unlisten(); history.endGroup(step); }
	const first = scenes[0]!;
	editor.activate(first);
	editor.select(first);
	const p = plan.variants[0]!.tree.props;
	focusRect(world, { x: p.x as number, y: p.y as number, width: p.width as number, height: p.height as number });
	editor.reportEdit(root, 'camera', getCameraMatrix(world));
	try { await flushProjectEdits(dir); }
	catch (cause) { throw new Error('The format versions were created but could not be saved. Retry saving this project before creating them again.', { cause }); }
	try { assertCurrent(); }
	catch (cause) { throw new Error('The format versions were created and saved before the operation stopped or the project changed. Reopen the project to review them before creating more.', { cause }); }
	options.onProgress?.({ phase: 'creating', completed: scenes.length, total: scenes.length });
	return {
		variants: plan.variants.map((variant, index) => {
			const sceneId = scenes[index]!.get(Source)?.value;
			if (!sceneId) throw new Error('A saved format version is no longer in the open project.');
			return { sceneId, name: variant.name, width: variant.width, height: variant.height, warnings: variant.warnings };
		}),
		warnings: plan.warnings, faceCoverage: plan.faceCoverage, videoCount: plan.videoCount, ...(plan.speakerSummary ? { speakerSummary: plan.speakerSummary } : {}),
	};
}
