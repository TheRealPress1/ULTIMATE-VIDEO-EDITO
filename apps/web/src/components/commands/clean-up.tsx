/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useWorld } from "@diffusionstudio/koota-solid";
import { useCommand } from "@/context/commands";
import { cleanUpSelection, getAlignableSelection, useSelection } from "@/engine";

/** Lays a selection of several out in a grid on the canvas (see `cleanUpSelection`). */
export function CleanUpCommand() {
  const world = useWorld();
  const { nodes } = useSelection();

  useCommand({
    id: "clean-up",
    title: "Clean up",
    group: "Object",
    icon: "view-grid",
    keywords: ["tidy", "grid", "arrange", "layout", "align", "distribute"],
    available: () => nodes().length > 1 && getAlignableSelection(world).length > 1,
    run: () => cleanUpSelection(world),
  });

  return null;
}
