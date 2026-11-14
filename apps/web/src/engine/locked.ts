/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Locked, getParentEntity } from '@diffusionstudio/runtime';

import type { Entity } from 'koota';

/**
 * Whether `entity` is locked, or sits under something that is: a locked track
 * locks every clip on it. The lock is the project's own `locked` prop (a
 * flag of the editor, as a selection is), and it stops hand edits only; it
 * does not stop what the file says (see `DocumentEditor.applyExternal`).
 */
export function isLocked(entity: Entity): boolean {
	for (let node: Entity | null = entity; node; node = getParentEntity(node)) {
		if (node.isAlive() && node.has(Locked)) return true;
	}

	return false;
}
