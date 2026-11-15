/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * In and out marks: the two ends of the scene's work area, set where the
 * playhead is (I and O), and taken off together (Alt+X). With only one set,
 * the other end is the scene's own: its start or its end.
 */

import { Computed, Workarea, getActiveEntity, store } from '@diffusionstudio/runtime';

import { editWorkarea } from './timing';

import type { World } from 'koota';

const playhead = (world: World) => {
	const scene = getActiveEntity(world);
	if (scene === null) return null;

	const computed = store(world, Computed);
	return {
		scene,
		frame: Math.round(computed.localTime[scene.id()] ?? 0),
		length: Math.round(computed.duration[scene.id()] ?? 0),
	};
};

/** The work area starts at the playhead and runs to where it ended, or to the scene's end. */
export function markIn(world: World): void {
	const at = playhead(world);
	if (at === null) return;

	const current = at.scene.get(Workarea);
	const end = current && current.end > at.frame ? current.end : at.length;
	if (end > at.frame) editWorkarea(world, at.scene, [at.frame, end]);
}

/** The work area ends at the playhead and runs from where it began, or from the scene's start. */
export function markOut(world: World): void {
	const at = playhead(world);
	if (at === null) return;

	const current = at.scene.get(Workarea);
	const start = current && current.start < at.frame ? current.start : 0;
	if (at.frame > start) editWorkarea(world, at.scene, [start, at.frame]);
}

export function clearMarks(world: World): void {
	const scene = getActiveEntity(world);
	if (scene?.has(Workarea)) editWorkarea(world, scene, null);
}
