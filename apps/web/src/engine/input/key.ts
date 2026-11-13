/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The key a shortcut names for a keyboard event: the typed key, in lower case.
 * With Option held, macOS types another character for a letter or a digit (⌥X
 * is ≈, ⌥E a dead key), so then the physical key says which one it is.
 */
export function keyOf(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>): string {
	if (event.altKey) {
		const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
		if (physical) return (physical[1] ?? physical[2]).toLowerCase();
	}

	return event.key.toLowerCase();
}
