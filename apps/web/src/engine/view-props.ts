/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Props that are pointing and viewing rather than composition: undoing them
 * is not what anyone means by undo, so they pass through to the file without
 * entering the history. They are also what one instance of an element the
 * project renders more than once can say that the file cannot (see
 * `isGenerated`).
 */
export const VIEW_PROPS: ReadonlySet<string> = new Set(['selected', 'active', 'camera', 'expanded', 'clipHeight', 'timeline', 'playhead']);
