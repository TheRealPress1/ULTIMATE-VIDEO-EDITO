/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Soloed } from '../traits';
import { getEntityTree, getParentNode } from './hierarchy';

import type { Entity, World } from 'koota';

/**
 * What stays audible while something is soloed, or null while nothing is. A
 * soloed entity is heard with what is under it (a soloed track is every clip
 * on it) and what is above it (a clip's sound goes out through the buses of
 * its parents); several soloed entities are heard together. Solo is
 * monitoring: nothing here is written to the project, and an export mixes
 * whatever is not muted.
 */
export function audibleWhileSoloed(world: World): Set<Entity> | null {
	let audible: Set<Entity> | null = null;

	for (const soloed of world.query(Soloed)) {
		audible ??= new Set();
		for (let above: Entity | null = soloed; above; above = getParentNode(above)) audible.add(above);
		for (const below of getEntityTree(world, soloed)) audible.add(below);
	}

	return audible;
}
