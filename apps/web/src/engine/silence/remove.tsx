/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Taking the silent parts out of a clip. The silences are found in the
 * stretch of the source the clip plays (see `./detect`), then the clip is cut
 * the way a split cuts it — copied where it stands, each copy trimmed to one
 * of the stretches of sound — and the pieces are pulled together so the gaps
 * close. Clips after it in the same sequence move up by as much as was taken
 * out, so the cut leaves no hole behind.
 *
 * Finding is asynchronous and cutting is not: everything the cut does lands
 * in one go, so it is one step to undo.
 */

import { Sequence } from '@diffusionstudio/reconciler';
import {
	Computed,
	FrameRate,
	Host,
	Selected,
	findGeometryAsset,
	getAssetFile,
	getEntityChildren,
	getNextName,
	getParentEntity,
	getSourceWindow,
	getTimelineOrigin,
	isGroup,
	isSequence,
} from '@diffusionstudio/runtime';

import { getDocumentEditor } from '../editor';
import { cloneFramesForSplit, clonePeaksForSplit } from '../timeline';
import { authoredTime, moveEntityTo, trimIn, trimOut } from '../timing';
import { DEFAULT_SILENCE_OPTIONS } from './detect';

import type { Entity, World } from 'koota';
import type { AudioAsset, VideoAsset } from '@diffusionstudio/assets';
import type { SilenceOptions, Span } from './detect';
import type { SilenceRequest, SilenceResponse } from './worker';

/** The silences found in one clip, in seconds of its source. */
export type ClipSilences = { clip: Entity; silences: Span[] };

/**
 * The media `clip` plays sound from, or null when it plays none: its own
 * asset (an `<audio>`), or the video it is painted with (a `<rect>` with a
 * `<videoPaint>`, as a video lands from the library).
 */
function soundAsset(world: World, clip: Entity): AudioAsset | VideoAsset | null {
	const asset = findGeometryAsset(world, clip);
	if (asset?.type === 'AUDIO') return asset;
	if (asset?.type === 'VIDEO' && asset.channels) return asset;
	return null;
}

/** The selected clips that have sound to take silence out of. */
export function silenceTargets(world: World): Entity[] {
	return [...world.query(Selected)].filter((entity) => soundAsset(world, entity) !== null);
}

/**
 * The silences in the stretch of its source `clip` plays, in seconds of the
 * source. Decoded in a worker of its own, gone when it answers.
 */
export async function detectClipSilences(
	world: World,
	clip: Entity,
	options: SilenceOptions = DEFAULT_SILENCE_OPTIONS,
): Promise<Span[]> {
	const asset = soundAsset(world, clip);
	if (!asset) return [];

	const fps = world.get(FrameRate)?.value ?? 30;
	const window = getSourceWindow(clip);
	const file = await getAssetFile(asset);

	const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
	try {
		const silences = await new Promise<Span[] | null>((resolve, reject) => {
			worker.onmessage = ({ data }: MessageEvent<SilenceResponse>) => {
				if ('error' in data) reject(new Error(data.error));
				else resolve(data.silences);
			};
			worker.onerror = (event) => reject(new Error(event.message || 'The silence worker failed'));
			worker.postMessage({
				file,
				start: window.in / fps,
				end: window.out / fps,
				options,
			} satisfies SilenceRequest);
		});
		return silences ?? [];
	} finally {
		worker.terminate();
	}
}

/**
 * The stretches of `clip` to keep, in scene frames: the clip's span with the
 * silences taken out. Worked out against the clip as it is now, so an edit
 * made while the silences were being found is respected.
 */
function keptSpans(world: World, clip: Entity, silences: Span[]): [number, number][] {
	const computed = clip.get(Computed);
	if (!computed) return [];

	const fps = world.get(FrameRate)?.value ?? 30;
	const rate = computed.playbackRate || 1;
	const { start, end, origin } = computed;
	const toFrame = (seconds: number) => Math.min(end, Math.max(start, Math.round(origin + (seconds * fps) / rate)));

	const kept: [number, number][] = [];
	let cursor = start;
	for (const [from, to] of silences) {
		const cutFrom = toFrame(from);
		const cutTo = toFrame(to);
		if (cutTo <= cutFrom) continue;
		if (cutFrom > cursor) kept.push([cursor, cutFrom]);
		cursor = Math.max(cursor, cutTo);
	}
	if (cursor < end) kept.push([cursor, end]);

	return kept;
}

/**
 * The clips after `clip` in the sequence it is in, which move up when it
 * gets shorter. None outside a sequence: layers there don't follow one
 * another, so nothing is out of place when one of them gets shorter.
 */
function followers(world: World, clip: Entity): Entity[] {
	const parent = getParentEntity(clip);
	if (parent === null || !isSequence(parent)) return [];

	const end = (clip.get(Computed)?.end ?? 0) - getTimelineOrigin(clip);
	return getEntityChildren(world, parent).filter(
		(sibling) => sibling !== clip && (authoredTime(world, sibling, 'start') ?? 0) >= end,
	);
}

/** Moves `entity` along its timeline by `delta` frames, by what the file says rather than what was last computed. */
function shift(world: World, entity: Entity, delta: number): void {
	const start = authoredTime(world, entity, 'start') ?? 0;
	moveEntityTo(world, entity, getTimelineOrigin(entity) + start + delta);
}

/**
 * Cuts the silences out of each clip and closes the gaps they leave. A clip
 * that would have nothing left is left alone. Returns the pieces the clips
 * were cut into, which are what the selection is left on.
 */
export function removeSilences(world: World, found: ClipSilences[]): Entity[] {
	const editor = getDocumentEditor(world);
	const cut: Entity[] = [];

	// Latest first: a clip earlier in a sequence moves the ones after it up,
	// and those have to have been cut already, so their own pieces move too.
	const ordered = found
		.filter(({ clip }) => clip.isAlive())
		.sort((a, b) => (b.clip.get(Computed)?.start ?? 0) - (a.clip.get(Computed)?.start ?? 0));

	for (const { clip, silences } of ordered) {
		const start = clip.get(Computed)?.start ?? 0;
		const end = clip.get(Computed)?.end ?? 0;
		const kept = keptSpans(world, clip, silences);
		const length = kept.reduce((sum, [from, to]) => sum + to - from, 0);
		const removed = end - start - length;
		if (kept.length === 0 || removed <= 0) continue;

		// Read before anything moves: the cut changes where the clip ends.
		const after = followers(world, clip);
		// Only the last piece leads into the next clip; the cuts between the
		// pieces are hard ones.
		const transition = clip.get(Host)?.props.transition !== undefined;

		// Each copy is of the one before it, made before anything is trimmed,
		// so every piece is spelled from the whole clip and in playing order.
		const pieces = [clip];
		for (let i = 1; i < kept.length; i++) {
			const [pair] = editor.duplicateInPlace([pieces[i - 1]!]);
			if (!pair) break;
			pieces.push(pair.copy);
			clonePeaksForSplit(clip.id(), pair.copy.id());
			cloneFramesForSplit(clip.id(), pair.copy.id());
		}
		if (pieces.length < kept.length) {
			editor.remove(pieces.slice(1));
			continue;
		}

		// Out before in: the out point is read against where the clip starts
		// now, which the in point moves.
		let at = start;
		for (const [index, piece] of pieces.entries()) {
			const [from, to] = kept[index]!;
			if (to < end) trimOut(world, piece, to);
			if (from > start) trimIn(world, piece, from);
			moveEntityTo(world, piece, at);
			if (transition && index < pieces.length - 1) editor.editProperty(piece, 'transition', false);
			at += to - from;
		}

		for (const follower of after) shift(world, follower, -removed);

		// Pieces side by side under a scene would be layers; wrapped, they
		// still read as the one clip they were (as a split does it).
		const parent = getParentEntity(clip);
		if (pieces.length > 1 && parent !== null && !isGroup(parent)) {
			editor.wrap(pieces, () => <Sequence name={getNextName(world, 'Sequence')} />);
		}

		cut.push(...pieces);
	}

	if (cut.length > 0) editor.select(cut);

	return cut;
}
