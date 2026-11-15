/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tracks, in the words of an editor. A track is a `<sequence>` of the scene:
 * a row that clips follow one another in. A picture track is named V1, V2 and
 * on, a sound track A1, A2 and on; the name is all there is to tell them
 * apart, and what a track holds decides what its header offers (see
 * `trackCapabilities`).
 */

import { Name, Selected, Source, getActiveEntity, getEntityChildren, getParentEntity, isSequence } from '@diffusionstudio/runtime';
import { Sequence } from '@diffusionstudio/reconciler';

import { getDocumentEditor } from './editor';

import type { Entity, World } from 'koota';

export type TrackKind = 'video' | 'audio';

const PREFIX: Record<TrackKind, string> = { video: 'V', audio: 'A' };

/**
 * The next free name for a track of `kind`: one past the highest number a
 * track of that kind has. A track counts when its name is the letter and a
 * number, and anything after them (`V2 B-roll`); `Voiceover` is not a V.
 */
export function nextTrackName(world: World, scene: Entity, kind: TrackKind): string {
	const prefix = PREFIX[kind];
	const numbered = new RegExp(`^${prefix}(\\d+)(?:\\s|$)`);

	let highest = 0;
	for (const child of getEntityChildren(world, scene)) {
		if (!isSequence(child)) continue;

		const match = numbered.exec(child.get(Name)?.value ?? '');
		if (match) highest = Math.max(highest, Number(match[1]));
	}

	return `${prefix}${highest + 1}`;
}

/** The row of the scene that `entity` is, or is in. */
function rowOf(scene: Entity, entity: Entity): Entity | null {
	for (let row: Entity | null = entity; row; row = getParentEntity(row)) {
		if (getParentEntity(row) === scene) return row;
	}

	return null;
}

/**
 * Adds an empty track named for the next free number, selects it, and returns
 * it; null when there is no scene to add it to. It goes above (or below) the
 * track `near` is on or in, and on top of the others when there is no `near`.
 * What comes later in the file is drawn above, so below is in front of the
 * track in the file.
 */
export function addTrack(world: World, kind: TrackKind, where: 'above' | 'below' = 'above', near?: Entity | null): Entity | null {
	const scene = getActiveEntity(world);
	if (scene === null || !scene.get(Source)?.value) return null;

	const row = near ? rowOf(scene, near) : null;
	const siblings = getEntityChildren(world, scene);
	const anchor = row === null ? undefined : where === 'below' ? row : siblings[siblings.indexOf(row) + 1];

	const editor = getDocumentEditor(world);
	const [track] = editor.insertElement(scene, () => Sequence({ name: nextTrackName(world, scene, kind) }), anchor);
	if (!track) return null;

	editor.select(track);
	return track;
}

/** Deletes the tracks that are selected, and the clips on them, as one step; what is not a track is left alone. */
export function removeSelectedTracks(world: World): Entity[] {
	const tracks = [...world.query(Selected)].filter((entity) => isSequence(entity));
	return tracks.length ? getDocumentEditor(world).remove(tracks) : [];
}
