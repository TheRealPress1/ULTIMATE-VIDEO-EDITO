/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Root, Solo } from '../traits';

import type { Entity, World } from 'koota';

/**
 * Shows one top-level node alone: the transform system culls the others, so
 * nothing of theirs is drawn, hovered or hit even where they overlap it.
 * `null` shows them all again. Takes effect on the next frame.
 */
export function setSolo(world: World, node: Entity | null): void {
	const root = world.get(Root);
	if (!root) return;

	if (node === null) {
		if (root.has(Solo)) root.remove(Solo);
	} else if (root.has(Solo)) {
		root.set(Solo, { node });
	} else {
		root.add(Solo({ node }));
	}
}

/** The node shown alone, or null while every one is. */
export function getSolo(world: World): Entity | null {
	return world.get(Root)?.get(Solo)?.node ?? null;
}
