/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Auto-captions: the scene's audible mix, encoded and transcribed, mounted as
 * the scene's `<captions>`. The audible mix stays on this Mac. A cancellable
 * toast reports preparation, the first model download, and transcription.
 */

import { authoredElement, authoredTree, Captions } from '@diffusionstudio/reconciler';
import { Caption, Computed, FrameRate, getEntityChildren, getEntityTree, Library, Shimmering } from '@diffusionstudio/runtime';
import { DapiError } from '@diffusionstudio/dapi';
import { assetName } from '@diffusionstudio/assets';
import { SOURCE_ATTR } from '@diffusionstudio/jsx';
import { toast } from 'somoto';

import { assertLocalTranscriptionAvailable, isTranscriptionCanceled, MAX_TRANSCRIPTION_SECONDS, transcribeLocally } from '@/lib/local-transcription';

import { getDocumentEditor } from '../editor';
import { encodeSceneAudio, hasAudio } from '../scene-audio';
import { shimmer } from './shimmer';

import type { AssetLibrary } from '@diffusionstudio/assets';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

const TITLE = 'Caption generation failed';
const TIMING_PROPS = ['start', 'end', 'sourceIn', 'sourceOut', 'playbackRate', 'syncTo', 'frameRate'] as const;
const EDITOR_PROPS = new Set(['selected', 'active', 'camera', 'timeline', 'playhead', 'clipHeight', 'expanded', SOURCE_ATTR]);
const running = new Set<Entity>();

export type CaptionGenerationResult = { path: string; segments: number; words: number; replacedExisting: boolean };
export type CaptionGenerationOptions = {
	signal?: AbortSignal;
	/** API callers must receive failures instead of a success-shaped toast. */
	throwErrors?: boolean;
	/** Guards navigation between awaits, in addition to the world/scene checks. */
	assertCurrent?: () => void;
};

/** Selection, scrubbing, and canvas navigation do not change rendered audio. */
function compositionSnapshot(world: World, scene: Entity): string | undefined {
	const normalize = (node: AuthoredTree): AuthoredTree => ({
		...node,
		props: Object.fromEntries(Object.entries(node.props).filter(([key]) => !EDITOR_PROPS.has(key))),
		children: node.children.map(normalize),
	});
	const tree = authoredTree(world, scene);
	return tree ? JSON.stringify(normalize(tree)) : undefined;
}

/** A scene-wide transcript must not inherit a nested or trimmed clip's clock. */
function sceneCaption(world: World, scene: Entity): Entity | undefined {
	return getEntityChildren(world, scene).find((entity) => {
		if (!entity.has(Caption)) return false;
		const props = authoredElement(entity)?.props;
		return props && TIMING_PROPS.every((key) => props[key] === undefined || props[key] === false);
	});
}

/** The next free `Captions N.json`. */
function captionsName(library: AssetLibrary): string {
	let max = 0;
	for (const asset of library.list()) {
		const match = assetName(asset).match(/^Captions (\d+)\.json$/);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `Captions ${max + 1}.json`;
}

/**
 * Transcribes `scene` and mounts the transcript as its captions: the scene's
 * `<captions>` is pointed at the new transcript, or one is added. A scene
 * already being captioned is left to the run in flight.
 */
export async function generateCaptions(world: World, scene: Entity, dir?: string, options: CaptionGenerationOptions = {}): Promise<CaptionGenerationResult | undefined> {
	options.signal?.throwIfAborted();
	options.assertCurrent?.();
	const fail = (message: string, code: 'invalid-input' | 'busy' = 'invalid-input'): undefined => {
		if (options.throwErrors) throw new DapiError(code, message);
		toast.error(TITLE, { description: message });
		return undefined;
	};
	const library = world.get(Library);
	if (!library) return fail('No asset library is available. Open the project and try again.');
	if (scene.has(Shimmering) || running.has(scene)) return fail('This scene is already processing. Wait for it to finish before generating captions.', 'busy');
	if (!hasAudio(world, scene)) {
		return fail('No audio found. Add an audio or video clip to the scene to generate captions.');
	}
	const duration = (scene.get(Computed)?.duration ?? 0) / (world.get(FrameRate)?.value || 30);
	if (!Number.isFinite(duration) || duration <= 0) return fail('The scene has no finite audio duration to caption.');
	if (duration > MAX_TRANSCRIPTION_SECONDS) {
		return fail('Local captions support scenes up to two hours.');
	}

	const editor = getDocumentEditor(world);
	const existing = sceneCaption(world, scene);
	if (getEntityTree(world, scene).some((node) => node.has(Caption) && node !== existing)) {
		return fail('This scene contains timed, nested, or additional captions. Reconcile those caption layers before generating scene-wide captions to avoid duplicates.');
	}
	editor.deselect(scene);
	running.add(scene);
	const sourceSnapshot = compositionSnapshot(world, scene);
	let edited = false;
	const stopEdits = editor.onEdit((edit) => {
		if (edit.kind !== 'prop' || !EDITOR_PROPS.has(edit.name)) edited = true;
	});
	const release = shimmer(world, scene);
	const controller = new AbortController();
	const cancel = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener('abort', cancel, { once: true });
	if (options.signal?.aborted) cancel();
	const progressId = `captions-${crypto.randomUUID()}`;
	let lastDescription = '';
	const progress = (message: string, fraction: number | null = null) => {
		if (controller.signal.aborted) return;
		const description = fraction === null ? message : `${message} · ${Math.round(fraction * 100)}%`;
		if (description === lastDescription) return;
		lastDescription = description;
		toast.loading('Generating captions locally', {
			id: progressId,
			description,
			duration: Infinity,
			dismissible: false,
			action: { label: 'Cancel', onClick: () => controller.abort() },
		});
	};
	const checkCurrent = () => {
		controller.signal.throwIfAborted();
		options.assertCurrent?.();
		if (world.get(Library) !== library || !scene.isAlive()) {
			throw new Error('The project or scene changed. Open the scene and generate captions again.');
		}
		if (edited || compositionSnapshot(world, scene) !== sourceSnapshot) {
			throw new Error('The scene was edited during transcription. Generate captions again to match the current edit.');
		}
	};

	try {
		progress('Checking local transcription');
		await assertLocalTranscriptionAvailable();
		checkCurrent();
		progress('Preparing the scene audio');
		const result = duration > 180 ? await (await import('../scene-speech')).transcribeSceneSections(world, scene, dir, {
			duration, snapshot: sourceSnapshot ?? '', signal: controller.signal, assertCurrent: checkCurrent, onProgress: progress,
		}) : await transcribeLocally(await encodeSceneAudio(world, scene, dir, {
			signal: controller.signal,
			onProgress: (fraction) => progress('Mixing the scene audio', fraction),
		}), {
			signal: controller.signal, assertCurrent: checkCurrent,
			onProgress: ({ message, progress: fraction }) => progress(message, fraction),
		});
		checkCurrent();
		// Audio containers can add a few padding samples. Captions must end
		// within the original scene, or regenerating them can grow the edit.
		const transcript = result.flatMap((segment) => {
			const words = segment.words
				.filter((word) => word.start < duration)
				.map((word) => ({ ...word, end: Math.min(word.end, duration) }))
				.filter((word) => word.end > word.start);
			return words.length ? [{ ...segment, text: words.map((word) => word.text).join(' '), words }] : [];
		});
		if (!transcript.some((segment) => segment.words.length > 0)) {
			throw new Error('No speech detected. The audio does not appear to contain recognizable speech.');
		}

		const blob = new Blob([JSON.stringify(transcript)], { type: 'application/json' });
		const asset = await library.store(blob, { name: captionsName(library) });
		await library.flush();
		checkCurrent();

		if (existing) {
			editor.editProperty(existing, 'src', asset.path);
			editor.select(existing);
		} else {
			const [captions] = editor.insertElement(scene, () => <Captions src={asset.path} />);
			if (captions) editor.select(captions);
		}
		toast.success('Captions added', { description: 'Select the captions to edit the words and choose a style.' });
		return { path: asset.path, segments: transcript.length, words: transcript.reduce((sum, segment) => sum + segment.words.length, 0), replacedExisting: !!existing };
	} catch (error) {
		if (controller.signal.aborted || isTranscriptionCanceled(error)) {
			toast('Caption generation canceled');
		} else {
			console.error(`[generate] ${TITLE}:`, error);
			toast.error(TITLE, { description: error instanceof Error ? error.message : String(error) });
		}
		if (options.throwErrors) throw error;
	} finally {
		options.signal?.removeEventListener('abort', cancel);
		running.delete(scene);
		toast.dismiss(progressId);
		stopEdits();
		release?.();
	}
}
