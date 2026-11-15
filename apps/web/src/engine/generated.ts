/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loop, Source } from '@diffusionstudio/runtime';
import { authoredElement } from '@diffusionstudio/reconciler';

import type { Entity, World } from 'koota';

/**
 * Whether the project renders `entity`'s element more than once: a `.map`
 * over a list, a component used twice. The file spells such an element once,
 * under one source, so a write to one instance is a write to every instance,
 * and nothing in the file says which one was meant. A `<For>` loop is not
 * counted: its entities carry `Loop`, and the editor unrolls it before an edit
 * reaches one (see `DocumentEditor.settle`).
 *
 * Only elements the project authored are counted: the runtime's own
 * sub-entities (a video's paint, say) carry their element's source without
 * being instances of it.
 */
export function isGenerated(world: World, entity: Entity): boolean {
	if (!entity.isAlive() || entity.has(Loop) || !authoredElement(entity)) return false;

	const source = entity.get(Source)?.value;
	if (!source) return false;

	let instances = 0;
	for (const other of world.query(Source)) {
		if (other.get(Source)?.value !== source || !authoredElement(other)) continue;
		if (++instances > 1) return true;
	}

	return false;
}
