/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Ripple delete: take the selected clips out and close the gap they leave,
 * so what came after them in the same row moves up by as much as they ran.
 * Only a sequence is a row that things follow one another in; a clip on a row
 * of its own leaves nothing to close and is deleted as it is.
 */

import { AdjustmentLayer, ChildOf, Computed, Geometry, Group, Selected, getActiveEntity, getParentEntity, isSequence, store } from '@diffusionstudio/runtime';
import { Or } from 'koota';

import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { withEmptiedTracks } from './keyframes';
import { moveEntityTo } from './timing';

import type { Entity, World } from 'koota';

type Gap = { start: number; end: number };

/** Deletes the selection and pulls the clips after each deleted one back over the gap, as one step. */
export function rippleDeleteSelection(world: World): void {
	const scene = getActiveEntity(world);
	const selected = [...world.query(Selected)].filter((entity) => entity !== scene);
	if (selected.length === 0) return;

	const computed = store(world, Computed);
	const doomed = new Set(selected);

	// The gaps, by the sequence they open in, read before anything is removed.
	const gaps = new Map<Entity, Gap[]>();
	for (const clip of selected) {
		const parent = getParentEntity(clip);
		if (parent === null || !isSequence(parent) || doomed.has(parent)) continue;
		const list = gaps.get(parent) ?? [];
		list.push({ start: computed.start[clip.id()] ?? 0, end: computed.end[clip.id()] ?? 0 });
		gaps.set(parent, list);
	}

	// What has to move, and by how much: a clip moves up by every gap that ended before it began.
	const moves: { clip: Entity; start: number; shift: number }[] = [];
	for (const [sequence, list] of gaps) {
		for (const clip of childrenOf(world, sequence)) {
			if (doomed.has(clip)) continue;
			const start = computed.start[clip.id()] ?? 0;
			const shift = list.reduce((sum, gap) => (gap.end <= start ? sum + (gap.end - gap.start) : sum), 0);
			if (shift > 0) moves.push({ clip, start, shift });
		}
	}

	// Nothing is deleted or moved when any of it is an element the project renders more than once: half a ripple would leave the row out of step.
	const editor = getDocumentEditor(world);
	if (editor.refuses([...selected, ...moves.map(({ clip }) => clip)])) return;

	// The delete and the moves are one step: an undo that brought back the clips but not the gap would leave them overlapping.
	const history = getEditHistory(world);
	const step = history.beginGroup();
	try {
		editor.remove(withEmptiedTracks(selected));

		for (const { clip, start, shift } of moves.sort((a, b) => a.start - b.start)) {
			moveEntityTo(world, clip, start - shift);
		}
	} finally {
		history.endGroup(step);
	}
}

/** The node kinds that sit on a timeline. */
const NODES = Or(Geometry, Group, AdjustmentLayer);

function childrenOf(world: World, sequence: Entity): Entity[] {
	return [...world.query(NODES, ChildOf(sequence))];
}
