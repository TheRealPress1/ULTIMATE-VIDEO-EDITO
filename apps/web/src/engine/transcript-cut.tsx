import { authoredElement, renderAuthored } from '@diffusionstudio/reconciler';
import { focusRect, FrameRate, getCameraMatrix, getEntityChildren, getNextName, Library, Root, Source } from '@diffusionstudio/runtime';
import { flushProjectEdits } from '@/projects/edits';
import { getDocumentEditor, isPendingSource } from './editor';
import { getEditHistory } from './history';
import { planTranscriptCut } from './transcript-cut-plan';
import type { World, Entity } from 'koota';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { Passage, TranscriptCutFormat } from './transcript-cut-plan';

export type { Passage } from './transcript-cut-plan';

export interface TranscriptCutOptions extends TranscriptCutFormat {
	assertCurrent?: () => void;
	/** Revalidate indexed fingerprints after storage awaits, just before editing. */
	validateSources?: () => Promise<void>;
}

export interface TranscriptCutResult {
	sceneId: string;
	duration: number;
	clipCount: number;
}

/** Create one ordinary, editable scene. The original scenes and source files stay intact. */
export async function createTranscriptCut(
	world: World,
	dir: string,
	passages: readonly Passage[],
	options: TranscriptCutOptions = {},
): Promise<TranscriptCutResult> {
	const root = world.get(Root);
	const library = world.get(Library);
	if (!root?.isAlive() || !root.get(Source)?.value || !library) throw new Error('Open a project before creating a transcript cut.');
	const fps = world.get(FrameRate)?.value ?? 30;
	const assertCurrent = () => {
		options.assertCurrent?.();
		if (!root.isAlive() || world.get(Root) !== root || world.get(Library) !== library || (world.get(FrameRate)?.value ?? 30) !== fps) {
			throw new Error('The project changed while preparing the cut. Search the footage again.');
		}
	};
	assertCurrent();
	// Copy caller-owned words before yielding; a changing selection cannot alter
	// the source ranges or captions of an in-flight operation.
	const plan = planTranscriptCut(passages, (id) => library.get(id), fps, options);
	const sources = passages.map((passage) => {
		const asset = library.get(passage.assetId)!;
		return { id: asset.id, path: asset.path, source: asset.source };
	});
	const assertSources = () => {
		assertCurrent();
		for (const source of sources) {
			const current = library.get(source.id);
			if (!current || current.path !== source.path || current.source !== source.source) {
				throw new Error('A selected source moved or was removed while preparing the cut. Search the footage again.');
			}
		}
	};
	await flushProjectEdits(dir);
	assertSources();
	const captions = await library.store(new Blob([JSON.stringify(plan.transcript)], { type: 'application/json' }), { name: 'Transcript cut captions.json' });
	await library.flush();
	assertSources();
	await options.validateSources?.();
	assertSources();
	const name = options.name?.trim() ?? getNextName(world, 'Transcript cut');
	const siblings = getEntityChildren(world, root);
	// Add beside the existing work so creating a cut does not cover its source scenes.
	const rightEdges = siblings.map((entity) => authoredElement(entity)).flatMap((element) => {
		if (element?.tag !== 'scene') return [];
		const { x = 0, width } = element.props;
		return typeof x === 'number' && typeof width === 'number' && Number.isFinite(x + width) ? [x + width] : [];
	});
	const rect = { x: rightEdges.length ? Math.max(...rightEdges) + 120 : -plan.width / 2, y: -plan.height / 2, width: plan.width, height: plan.height };
	const tree: AuthoredTree = {
		tag: 'scene', props: { name, ...rect }, children: [
			{ tag: 'solidPaint', props: { color: '#000000' }, children: [] },
			...plan.clips,
			{ tag: 'captions', props: { name: 'Cut captions', src: captions.path, start: 0, sourceIn: 0, sourceOut: plan.duration, preset: 'whisper' }, children: [] },
		],
	};
	const editor = getDocumentEditor(world);
	const history = getEditHistory(world);
	const before = new Set(world.query(Source));
	const reported = new Set<string>();
	const unlisten = editor.onEdit((edit) => { if (edit.kind === 'insert') reported.add(edit.source); });
	let scene: Entity | undefined;
	history.beginGesture();
	try {
		[scene] = editor.insertElement(root, () => renderAuthored(tree));
		if (!scene) throw new Error('The transcript cut could not be inserted into the project.');
	} catch (error) {
		// Rendering can fail before insertElement returns. Discard unreported
		// pending entities; reported insertions get matching removals so the
		// writer and undo history both observe an unchanged composition.
		const added = [...world.query(Source)].filter((entity) => !before.has(entity));
		for (const entity of added) {
			if (!entity.isAlive()) continue;
			const source = entity.get(Source)?.value;
			if (!source || !isPendingSource(source)) continue;
			if (reported.has(source)) editor.remove(entity);
			else editor.discardPending(source);
		}
		throw error;
	} finally {
		unlisten();
		history.endGesture();
	}
	// Viewing state is excluded from composition undo. Do this only once the
	// complete scene exists, so a failed preparation leaves the current view alone.
	editor.activate(scene);
	editor.select(scene);
	focusRect(world, rect);
	editor.reportEdit(root, 'camera', getCameraMatrix(world));
	try {
		await flushProjectEdits(dir);
	} catch (cause) {
		throw new Error('The complete cut was created, but could not be saved. Retry saving this project before creating another cut.', { cause });
	}
	try { assertCurrent(); }
	catch (cause) {
		throw new Error('The cut was created and saved before the operation stopped or the project changed. Reopen the project to find it; do not create it again.', { cause });
	}
	const sceneId = scene.get(Source)?.value;
	if (!sceneId) throw new Error('The cut is no longer available in the open project.');
	return { sceneId, duration: plan.duration, clipCount: plan.clips.length };
}
