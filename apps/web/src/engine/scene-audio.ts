/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A scene's audible mix as a file of its own, for what listens to a scene
 * rather than to one of its assets: transcription, above all. The mix is the
 * export's, from the scene's start to its end — the workarea is an export
 * setting, not part of the composition — so a time in the file is a time in
 * the scene, and a transcript of it lines up with `<captions>` untrimmed.
 */

import { AssetId, Audio, FrameRate, getEntityTree, getParentNode, Hidden, Muted, Paint, PaintType, Source, Workarea } from '@diffusionstudio/runtime';
import { createEncoder } from '@diffusionstudio/encoder';

import { createCapture } from './capture';

import type { Entity, World } from 'koota';

/** Whether anything in the scene is heard: an unmuted, visible clip or video paint with its asset bound. */
export function isAudibleMedia(entity: Entity, scene: Entity): boolean {
		if (!entity.has(AssetId) || (!entity.has(Audio) && entity.get(Paint)?.value !== PaintType.VIDEO)) return false;
		for (let node: Entity | null = entity; node; node = getParentNode(node)) {
			if (node.has(Hidden) || node.has(Muted)) return false;
			if (node === scene) break;
		}
		return true;
}

export function hasAudio(world: World, scene: Entity): boolean {
	return getEntityTree(world, scene).some((entity) => isAudibleMedia(entity, scene));
}

/** The scene's audible mix as an Ogg/Opus file; `dir` is the project's folder, compiled fresh. */
export async function encodeSceneAudio(
	world: World,
	scene: Entity,
	dir?: string,
	options: { signal?: AbortSignal; onProgress?: (progress: number) => void; window?: { start: number; end: number } } = {},
): Promise<File> {
	const { signal, onProgress } = options;
	signal?.throwIfAborted();
	const capture = await createCapture(world, scene, { mode: 'offline-audio', dir });
	let cancelEncoder: (() => void) | undefined;
	const cancel = () => cancelEncoder?.();
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		signal?.throwIfAborted();
		// The whole scene, not the workarea the encoder would otherwise keep to.
		setAudioWindow(capture.node, options.window ? world.get(FrameRate)?.value ?? 30 : 30, options.window);
		const encoder = await createEncoder(capture.world, {
			format: 'ogg',
			video: { enabled: false },
			audio: { enabled: true, codec: 'opus', sampleRate: 24000 },
			onProgress: ({ progress, total }) => onProgress?.(Math.max(0, Math.min(1, progress / Math.max(1, total)))),
		});
		cancelEncoder = encoder.cancel;
		// An encoder created while cancellation was pending still needs to be
		// rendered once so its own cancellation path releases its resources.
		if (signal?.aborted) encoder.cancel();
		const result = await encoder.render();
		signal?.throwIfAborted();
		if (result.type !== 'success' || !result.data) {
			throw new Error('Could not encode the scene audio.');
		}
		return new File([result.data], 'scene.ogg', { type: 'audio/ogg' });
	} finally {
		signal?.removeEventListener('abort', cancel);
		capture.dispose();
	}
}

/** Lossless 48 kHz scene mix for measurement and finishing. Times remain scene-relative. */
export async function encodeScenePcm(
	world: World, scene: Entity, dir?: string,
	options: { signal?: AbortSignal; onProgress?: (progress: number) => void; window?: { start: number; end: number }; excludeSources?: readonly string[] } = {},
): Promise<File> {
	const { signal, onProgress } = options;
	signal?.throwIfAborted();
	const capture = await createCapture(world, scene, { mode: 'offline-audio', dir });
	let cancelEncoder: (() => void) | undefined;
	const cancel = () => cancelEncoder?.();
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		signal?.throwIfAborted();
		setAudioWindow(capture.node, options.window ? world.get(FrameRate)?.value ?? 30 : 30, options.window);
		const exclude = new Set(options.excludeSources ?? []);
		for (const entity of getEntityTree(capture.world, capture.node)) {
			const source = entity.get(Source)?.value;
			if (source && exclude.delete(source)) entity.add(Muted);
		}
		if (exclude.size) throw new Error('A selected background track changed before rendering. Choose the tracks again.');
		const encoder = await createEncoder(capture.world, {
			format: 'mov', video: { enabled: false },
			audio: { enabled: true, codec: 'pcm-f32', sampleRate: 48000, numberOfChannels: 2 },
			onProgress: ({ progress, total }) => onProgress?.(Math.max(0, Math.min(1, progress / Math.max(1, total)))),
		});
		cancelEncoder = encoder.cancel;
		if (signal?.aborted) encoder.cancel();
		const result = await encoder.render();
		signal?.throwIfAborted();
		if (result.type !== 'success' || !result.data) throw new Error('Could not render the scene PCM audio.');
		return new File([result.data], 'scene-pcm.mov', { type: 'video/quicktime' });
	} finally { signal?.removeEventListener('abort', cancel); capture.dispose(); }
}

/** Bounded scene audio windows keep OfflineAudioContext allocations independent of recording length. */
function setAudioWindow(node: Entity, fps: number, window?: { start: number; end: number }): void {
  if (!window) { node.remove(Workarea); return; }
  if (![window.start, window.end, fps].every(Number.isFinite) || fps <= 0 || window.start < 0 || window.end <= window.start || window.end > 7200 || window.end - window.start > 180)
    throw new Error('Render scene audio in windows of up to three minutes within a two-hour scene.');
  node.add(Workarea({ start: window.start * fps, end: window.end * fps }));
}
