/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether a pointer is held down, for whatever must not change the document
 * under a gesture: a drag holds the entities it moves, and an edit that
 * removed one of them would leave it dragging something that is gone.
 */

/** How long to wait for a release that never comes (one lost outside the window), in ms. */
const GIVE_UP = 10_000;

let held = false;
const waiting = new Set<() => void>();

const release = (): void => {
	held = false;
	for (const resume of [...waiting]) resume();
};

if (typeof window !== 'undefined') {
	// Capturing, so a handler that stops the event still counts.
	window.addEventListener('pointerdown', () => { held = true; }, true);
	window.addEventListener('pointerup', release, true);
	window.addEventListener('pointercancel', release, true);
	window.addEventListener('blur', release);
}

/** Resolves once no pointer is held down; at once when none is. */
export function whenPointerIdle(): Promise<void> {
	if (!held) return Promise.resolve();

	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			waiting.delete(done);
			resolve();
		};
		const timer = setTimeout(done, GIVE_UP);
		waiting.add(done);
	});
}
