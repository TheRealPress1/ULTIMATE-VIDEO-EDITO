/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// When a transcript jumps to its end on its own: as another chat opens, and
// as a chat first has something to show. Never because a turn streamed more.

import { createEffect, createMemo, on, type Accessor } from "solid-js";

/**
 * Runs `pin` when `chatKey` changes or `hasItems` flips. Both are read through
 * memos on purpose: `on` calls its function for every notification of what it
 * reads, whether or not the value moved, and the items array is a new one with
 * each streamed event. Read directly, `items.length > 0` would pin the view to
 * the bottom on every update and undo a scroll up while the agent is writing.
 */
export function createPinOnOpen(chatKey: Accessor<string>, hasItems: Accessor<boolean>, pin: () => void): void {
  const key = createMemo(chatKey);
  const open = createMemo(hasItems);
  createEffect(on([key, open], () => pin()));
}
