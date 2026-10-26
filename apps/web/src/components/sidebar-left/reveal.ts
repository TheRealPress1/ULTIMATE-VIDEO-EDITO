/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Showing assets in the assets panel from elsewhere: the panel opens the
// folder they are in, selects them and scrolls to them. Kept here rather than
// in the panel, which is not mounted while the UI is hidden: it takes up a
// request left for it as it comes up.

import { createSignal } from "solid-js";

export type RevealRequest = {
  /** The folder to open ('' = the root). */
  folder: string;
  /** The assets in it to select. */
  ids: string[];
};

const [revealRequest, setRevealRequest] = createSignal<RevealRequest | null>(null);

/** The reveal the assets panel has yet to carry out. */
export { revealRequest };

/** Asks the assets panel to show `ids` in `folder`. */
export function revealInAssets(request: RevealRequest): void {
  setRevealRequest(request);
}

/** Marks the reveal done. */
export function clearRevealRequest(): void {
  setRevealRequest(null);
}
