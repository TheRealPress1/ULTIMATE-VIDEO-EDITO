import { authoredTree, renderAuthored } from '@diffusionstudio/reconciler';
import { Computed, FrameRate, getEntityChildren, Library, Root, Source, resolveTranscript, stopPlayback } from '@diffusionstudio/runtime';
import { parseTime } from '@diffusionstudio/jsx';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { transcribeLocally } from '@/lib/local-transcription';
import { flushProjectEdits } from '@/projects/edits';
import { cloneReframeTree } from './reframe-plan';
import { getDocumentEditor, isPendingSource } from './editor';
import { getEditHistory } from './history';
import { encodeSceneAudio } from './scene-audio';
import { editPlayhead } from './timing';
import { pauseSilenceOptions } from './silence/detect';
import { detectTranscriptEditSilences } from './transcript-edit-silence';
import { planTranscriptEdit, resolveSuggestionOptions, timelineWords, transcriptPassages, transcriptSuggestions } from './transcript-edit-plan';
import type { Entity, World } from 'koota';
import type { Asset, AssetLibrary, Transcript } from '@diffusionstudio/assets';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { TranscriptEditPauses } from './transcript-edit-silence';
import type { TimelineRange, TranscriptEditLayer, TranscriptEditSnapshot, TranscriptPauseDetection, TranscriptSuggestionOptions, TranscriptSuggestionRequest } from './transcript-edit-plan';

export type { TimelineRange, TranscriptEditSnapshot, TranscriptSuggestionRequest } from './transcript-edit-plan';
export { transcriptDraftRanges } from './transcript-edit-plan';
export interface TranscriptEditOptions {
	signal?: AbortSignal;
	assertCurrent?: () => void;
	onProgress?: (message: string) => void;
	/** Re-transcribe the current audio instead of using an existing aligned caption. */
	refreshTranscript?: boolean;
	/** Pause, filler and retake settings; they are part of the returned revision. */
	suggestions?: TranscriptSuggestionRequest;
}
export interface TranscriptEditResult { sceneId: string; duration: number; previousDuration: number; clipCount: number; captionPath: string; checkpointId: string }
interface MediaIdentity { path: string; asset: Asset; size: number; mtime: number }
interface PreparedEdit {
	snapshot: TranscriptEditSnapshot;
	scene: Entity;
	root: Entity;
	library: AssetLibrary;
	treeSignature: string;
	layers: TranscriptEditLayer[];
	media: MediaIdentity[];
	transcript: Transcript;
	transcriptSource: TranscriptEditSnapshot['transcriptSource'];
	/** Notes about where the words came from, carried into every later snapshot of this inspection. */
	sourceWarnings: string[];
	/** The measured mix for one detector setting; a new setting measures again but keeps the words. */
	pauses: { key: string; measured: TranscriptEditPauses | null; warning?: string };
	/** The resolved suggestion settings `snapshot` was made with. */
	optionsKey: string;
	dir: string;
}
// One trusted inspection per world keeps arbitrary caller words out of edits
// and avoids retaining hours of old transcripts after project navigation.
const prepared = new WeakMap<World, PreparedEdit>();
const activeOperations = new WeakSet<World>();
const FIXED = new Set(['solidPaint', 'linearGradientPaint', 'radialGradientPaint', 'angularGradientPaint']);
const CLIPS = new Set(['video', 'audio', 'image', 'rect', 'text', 'ellipse', 'polygon', 'path']);
const ALLOWED_SUBTREE = new Set(['videoPaint', 'imagePaint', 'solidPaint', 'linearGradientPaint', 'radialGradientPaint', 'angularGradientPaint', 'colorStop', 'stroke', 'shadow', 'effect', 'mask', 'clipPath', 'keyframeTrack', 'keyframe', 'textRange', 'rect', 'ellipse', 'polygon', 'path']);
const neutral = (value: unknown, expected = 0) => value === undefined || value === false || value === expected;
const signature = (tree: AuthoredTree) => JSON.stringify(cloneReframeTree(tree), (_key, value: unknown) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);

function collectLayers(world: World, scene: Entity, fps: number, duration: number): TranscriptEditLayer[] {
	let captionCount = 0;
	const validateDescendants = (tree: AuthoredTree) => {
		if (tree.props.syncTo !== undefined || tree.props.transition) throw new Error('Transcript editing does not support audio sync links or transitions. Resolve those first.');
		for (const child of tree.children) {
			if (!ALLOWED_SUBTREE.has(child.tag)) throw new Error(`The ${child.tag} content needs manual timeline editing. Preset animations and nested video layouts cannot be safely split here.`);
			validateDescendants(child);
		}
	};
	const clip = (node: Entity) => {
		const tree = authoredTree(world, node);
		if (!tree || !CLIPS.has(tree.tag)) throw new Error('This scene contains an unsupported timeline layer. Use direct video, audio, captions, static graphics and simple sequences.');
		validateDescendants(tree);
		const c = node.get(Computed);
		if (!c || ![c.start, c.end, c.origin, c.playbackRate].every(Number.isFinite) || c.playbackRate <= 0 || c.end <= c.start) throw new Error('Wait for all media to finish loading before editing its transcript.');
		return { tree: cloneReframeTree(tree), start: c.start, end: c.end, origin: c.origin, rate: c.playbackRate };
	};
	const layers = getEntityChildren(world, scene).map((node): TranscriptEditLayer => {
		const tree = authoredTree(world, node);
		if (!tree) throw new Error('The scene contains a generated layer that cannot be written back safely.');
		if (FIXED.has(tree.tag)) { validateDescendants(tree); return { fixed: cloneReframeTree(tree) }; }
		if (tree.tag === 'captions') {
			if (++captionCount > 1) throw new Error('Reconcile multiple caption layers before editing this scene by transcript.');
			const p = tree.props;
			if (!neutral(p.start) || !neutral(p.sourceIn) || !neutral(p.playbackRate, 1) || p.syncTo !== undefined) throw new Error('Use one scene-aligned caption layer before transcript editing. Timed or speed-adjusted captions need manual reconciliation.');
			for (const key of ['end', 'sourceOut']) {
				if (p[key] === undefined || p[key] === false) continue;
				const seconds = typeof p[key] === 'string' || typeof p[key] === 'number' ? parseTime(p[key] as number | string) : undefined;
				if (seconds === undefined || seconds < duration - 1 / fps) throw new Error('The existing caption is trimmed before the scene ends. Generate scene-wide captions first.');
			}
			return { caption: cloneReframeTree(tree) };
		}
		if (tree.tag === 'sequence') {
			const p = tree.props;
			if (!neutral(p.start) || !neutral(p.sourceIn) || !neutral(p.playbackRate, 1) || !neutral(p.volume) || !neutral(p.opacity, 1) || p.end !== undefined || p.sourceOut !== undefined || p.muted || p.hidden) throw new Error('This sequence has its own trim, speed or mix settings. Flatten it before transcript editing.');
			return { name: typeof p.name === 'string' ? p.name : 'Transcript edit', clips: getEntityChildren(world, node).map(clip) };
		}
		return { name: typeof tree.props.name === 'string' ? tree.props.name : undefined, clips: [clip(node)] };
	});
	if (!layers.some((layer) => layer.clips?.length)) throw new Error('This scene has no supported timeline clips.');
	return layers;
}

async function mediaIdentities(tree: AuthoredTree, assets: AssetLibrary, assertCurrent: () => void): Promise<MediaIdentity[]> {
	const paths = new Set<string>();
	const gather = (node: AuthoredTree) => { if (typeof node.props.src === 'string') paths.add(node.props.src); node.children.forEach(gather); };
	gather(tree);
	if (paths.size > 2000) throw new Error('This scene references too many media files to inspect safely.');
	const result: MediaIdentity[] = [];
	for (const path of paths) {
		if (/^(?:https?|data|blob):/i.test(path)) throw new Error('Collect remote media locally before editing the timeline by transcript.');
		const found = await assets.resolve(path); assertCurrent();
		const asset = { ...found, ...(found.stat ? { stat: { ...found.stat } } : {}) };
		const stat = await assets.fs.stat(asset.source); assertCurrent();
		if (!stat || !Number.isFinite(stat.size) || !Number.isFinite(stat.mtime)) throw new Error(`The media file ${path} is unavailable.`);
		if (asset.stat && (stat.size !== asset.stat.size || Math.floor(stat.mtime) !== Math.floor(asset.stat.mtime))) throw new Error(`${path} changed on disk. Re-import it and inspect the transcript again.`);
		result.push({ path, asset, size: stat.size, mtime: stat.mtime });
	}
	return result;
}

async function verifyMedia(media: readonly MediaIdentity[], library: AssetLibrary, assertCurrent: () => void): Promise<void> {
	for (const item of media) {
		const asset = await library.resolve(item.path); assertCurrent();
		const stat = await library.fs.stat(item.asset.source); assertCurrent();
		if (asset.id !== item.asset.id || asset.source !== item.asset.source || !stat || stat.size !== item.size || stat.mtime !== item.mtime) throw new Error(`${item.path} changed while reviewing the transcript. Reload it before applying edits.`);
	}
}

const decibels = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

/** The pause settings in force and the levels the scene mix was measured at. */
function pauseDetection(options: TranscriptSuggestionOptions, measured: TranscriptEditPauses): TranscriptPauseDetection {
	return {
		...options.pauses, mode: options.pauses.thresholdDb === null ? 'adaptive' : 'fixed',
		appliedThresholdDb: decibels(measured.levels?.threshold), noiseFloorDb: decibels(measured.levels?.floor), speechDb: decibels(measured.levels?.sound),
	};
}

/** Inspect trusted words and actual quiet intervals without changing the composition. */
export async function prepareTranscriptEdit(world: World, dir: string, scene: Entity, options: TranscriptEditOptions = {}): Promise<TranscriptEditSnapshot> {
	if (activeOperations.has(world)) throw new Error('A transcript operation is already running. Wait for it to finish.');
	activeOperations.add(world);
	try {
		const root = world.get(Root), library = world.get(Library), tree = authoredTree(world, scene);
		if (!root?.isAlive() || !library || !scene.isAlive() || tree?.tag !== 'scene') throw new Error('Open and select a scene before editing its transcript.');
		const fps = world.get(FrameRate)?.value ?? 30;
		// Export clocks begin at zero even when the first visible clip starts
		// later. `duration` is end-start; using it would erase a leading gap.
		const duration = Math.max(0, scene.get(Computed)?.end ?? 0) / fps;
		if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Transcript editing supports scenes between one frame and one hour.');
		// Settings are checked before any audio work starts.
		const suggestionOptions = resolveSuggestionOptions(options.suggestions);
		const detector = pauseSilenceOptions(suggestionOptions.pauses);
		const pauseKey = JSON.stringify(detector), optionsKey = JSON.stringify(suggestionOptions);
		const treeSignature = signature(tree);
		const assertCurrent = () => {
			options.signal?.throwIfAborted(); options.assertCurrent?.();
			if (!scene.isAlive() || !root.isAlive() || world.get(Root) !== root || world.get(Library) !== library || (world.get(FrameRate)?.value ?? 30) !== fps) throw new Error('The project changed while inspecting the transcript.');
			const current = authoredTree(world, scene);
			if (!current || signature(current) !== treeSignature) throw new Error('The scene changed while inspecting its transcript. Reload the transcript.');
		};
		assertCurrent(); await flushProjectEdits(dir); assertCurrent();
		const layers = collectLayers(world, scene, fps, duration);
		const media = await mediaIdentities(tree, library, assertCurrent);
		const cached = prepared.get(world);
		const reuse = !options.refreshTranscript && cached?.scene === scene && cached.dir === dir && cached.library === library && cached.treeSignature === treeSignature && cached.snapshot.frameRate === fps && cached.snapshot.duration === duration &&
			JSON.stringify(cached.media.map(({ path, asset, size, mtime }) => [path, asset.id, asset.source, size, mtime])) === JSON.stringify(media.map(({ path, asset, size, mtime }) => [path, asset.id, asset.source, size, mtime])) ? cached : undefined;
		if (reuse?.optionsKey === optionsKey) { assertCurrent(); return structuredClone(reuse.snapshot); }
		// Other settings for the same scene reuse its words; only a new
		// detector setting measures the mix again.
		let transcript: Transcript | undefined = reuse && structuredClone(reuse.transcript);
		let transcriptSource: TranscriptEditSnapshot['transcriptSource'] = reuse?.transcriptSource ?? 'transcribed';
		const sourceWarnings = reuse ? [...reuse.sourceWarnings] : [];
		let pauses = reuse?.pauses.key === pauseKey ? reuse.pauses : undefined;
		const caption = layers.find((layer) => layer.caption)?.caption;
		if (!reuse && caption && !options.refreshTranscript && typeof caption.props.src === 'string') {
			const asset = await library.resolve(caption.props.src); assertCurrent();
			transcript = await resolveTranscript(asset); assertCurrent();
			transcriptSource = 'captions';
			sourceWarnings.push('Uses your current caption text and timing. If you changed the edit since captioning, transcribe the current audio before cutting.');
		}
		if (!pauses) {
			options.onProgress?.('Preparing the scene audio');
			let audio: Blob | undefined;
			try {
				audio = await encodeSceneAudio(world, scene, dir, { signal: options.signal, onProgress: (value) => options.onProgress?.(`Preparing audio · ${Math.round(value * 100)}%`) });
				assertCurrent();
				options.onProgress?.('Finding quiet pauses');
				pauses = { key: pauseKey, measured: await detectTranscriptEditSilences(audio, duration, options.signal, detector) };
				assertCurrent();
			} catch (error) {
				assertCurrent();
				if (!transcript) throw error;
				pauses = { key: pauseKey, measured: null, warning: `Quiet-pause suggestions are unavailable: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (!transcript) {
				if (!audio) throw new Error('The scene audio could not be prepared for transcription.');
				transcript = await transcribeLocally(audio, { signal: options.signal, onProgress: ({ message, progress }) => options.onProgress?.(`${message}${progress === null ? '' : ` · ${Math.round(progress * 100)}%`}`) });
				assertCurrent();
			}
		}
		if (!transcript) throw new Error('No transcript is available for this scene. Transcribe the current audio first.');
		await verifyMedia(media, library, assertCurrent); assertCurrent();
		const words = timelineWords(transcript, duration);
		const warnings = [...sourceWarnings, ...pauses.warning ? [pauses.warning] : []];
		if (words.some((word, i) => i > 0 && word.start < words[i - 1]!.end)) warnings.push('Some word times overlap. Listen around those boundaries before removing words.');
		const sceneId = scene.get(Source)?.value;
		if (!sceneId) throw new Error('The scene has not been saved yet.');
		// The settings are part of the revision: an apply prepared from another
		// inspection's suggestions is rejected rather than silently mixed.
		const bytes = new TextEncoder().encode(JSON.stringify({ treeSignature, fps, duration, words, media: media.map(({ asset, size, mtime }) => [asset.id, asset.source, size, mtime]), suggestions: suggestionOptions }));
		const revision = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('');
		assertCurrent();
		const snapshot: TranscriptEditSnapshot = {
			revision, sceneId, sceneName: String(tree.props.name || 'Scene'), duration, frameRate: fps, transcriptSource, words, passages: transcriptPassages(words, duration),
			suggestions: transcriptSuggestions(words, duration, pauses.measured?.silences ?? [], suggestionOptions, fps),
			pauseDetection: pauses.measured ? pauseDetection(suggestionOptions, pauses.measured) : null, warnings,
		};
		prepared.set(world, { snapshot: structuredClone(snapshot), scene, root, library, treeSignature, layers, media, transcript: structuredClone(transcript), transcriptSource, sourceWarnings, pauses, optionsKey, dir });
		return snapshot;
	} finally { activeOperations.delete(world); }
}

/** Replace the current scene's timeline in one undoable transaction, after saving a durable version. */
export async function applyTranscriptEdit(world: World, dir: string, scene: Entity, revision: string, ranges: readonly TimelineRange[], options: Pick<TranscriptEditOptions, 'signal' | 'assertCurrent' | 'onProgress'> = {}): Promise<TranscriptEditResult> {
	if (activeOperations.has(world)) throw new Error('A transcript operation is already running.');
	activeOperations.add(world);
	try {
		const stored = prepared.get(world), library = world.get(Library);
		if (!stored || stored.snapshot.revision !== revision || stored.scene !== scene || stored.dir !== dir || !library || library !== stored.library) throw new Error('This transcript review has expired. Inspect the current scene again before applying edits.');
		const assertCurrent = () => {
			options.signal?.throwIfAborted(); options.assertCurrent?.();
			if (!scene.isAlive() || !stored.root.isAlive() || world.get(Root) !== stored.root || world.get(Library) !== library || (world.get(FrameRate)?.value ?? 30) !== stored.snapshot.frameRate) throw new Error('The project changed while applying the transcript edit.');
			const current = authoredTree(world, scene);
			if (!current || signature(current) !== stored.treeSignature) throw new Error('The scene changed after the transcript was inspected. Reload it before applying edits.');
		};
		assertCurrent();
		const plan = planTranscriptEdit(stored.layers, stored.snapshot.words, ranges.map((range) => ({ ...range })), stored.snapshot.duration, stored.snapshot.frameRate);
		await flushProjectEdits(dir); assertCurrent();
		await verifyMedia(stored.media, library, assertCurrent); assertCurrent();
		options.onProgress?.('Saving a recovery version');
		const listing = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSIONS, { dir }); assertCurrent();
		const checkpoint = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSION_CREATE, { dir, label: `Before transcript edit · ${stored.snapshot.sceneName}`.slice(0, 120), expectedFingerprint: listing.fingerprint }); assertCurrent();
		const captionAsset = await library.store(new Blob([JSON.stringify(plan.transcript)], { type: 'application/json' }), { name: 'Timeline edit captions.json' });
		await library.flush(); assertCurrent();
		await verifyMedia(stored.media, library, assertCurrent); assertCurrent();
		plan.children[plan.captionIndex]!.props.src = captionAsset.path;
		const editor = getDocumentEditor(world), history = getEditHistory(world);
		const originalChildren = getEntityChildren(world, scene);
		const before = new Set(world.query(Source));
		const reported = new Set<string>();
		const stop = editor.onEdit((edit) => { if (edit.kind === 'insert') reported.add(edit.source); });
		options.onProgress?.('Applying timeline edit');
		history.beginGesture();
		let replaced = false;
		try {
			// Render all replacement layers before removing any original one.
			for (const tree of plan.children) {
				if (!editor.insertElement(scene, () => renderAuthored(tree))[0]) throw new Error('A replacement timeline layer could not be created.');
			}
			editor.remove(originalChildren);
			replaced = true;
			editor.editProperty(scene, 'workarea', false);
		} catch (error) {
			if (!replaced && originalChildren.every((node) => node.isAlive())) {
				for (const node of [...world.query(Source)].filter((item) => !before.has(item))) {
					if (!node.isAlive()) continue;
					const source = node.get(Source)?.value;
					if (!source || !isPendingSource(source)) continue;
					if (reported.has(source)) editor.remove(node); else editor.discardPending(source);
				}
				throw error;
			}
			throw new Error('The timeline change stopped partway through. Undo this edit or restore the saved Before transcript edit version before continuing.', { cause: error });
		} finally { stop(); history.endGesture(); }
		stopPlayback(world, scene);
		editor.select(scene); editPlayhead(world, scene, 0);
		prepared.delete(world);
		try { await flushProjectEdits(dir); }
		catch (cause) { throw new Error('The transcript edit was applied but could not be saved. Retry saving this project; do not apply it again.', { cause }); }
		try { options.signal?.throwIfAborted(); options.assertCurrent?.(); }
		catch (cause) { throw new Error('The transcript edit was applied and saved before the request stopped. Open the project and review it; do not apply it again.', { cause }); }
		return { sceneId: scene.get(Source)?.value || stored.snapshot.sceneId, duration: plan.duration, previousDuration: stored.snapshot.duration, clipCount: plan.clipCount, captionPath: captionAsset.path, checkpointId: checkpoint.id };
	} finally { activeOperations.delete(world); }
}
