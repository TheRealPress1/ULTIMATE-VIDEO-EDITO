/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useWorld } from "@diffusionstudio/koota-solid";
import { useCommand } from "@/context/commands";
import { toggleSelectionLocked, toggleSelectionMuted, toggleSelectionSoloed, useSelection } from "@/engine";

/** What the layer list's mute, solo and padlock buttons do, over the selection. */
export function LayerToggleCommands() {
  const world = useWorld();
  const { nodes } = useSelection();

  useCommand({
    id: "toggle-muted",
    title: "Mute/Unmute",
    group: "Object",
    icon: "mute",
    keywords: ["mute", "unmute", "audio", "sound", "silence"],
    available: () => nodes().length > 0,
    run: () => toggleSelectionMuted(world),
  });

  useCommand({
    id: "toggle-locked",
    title: "Lock/Unlock",
    group: "Object",
    icon: "lock-closed",
    keywords: ["lock", "unlock", "padlock", "protect", "track"],
    available: () => nodes().length > 0,
    run: () => toggleSelectionLocked(world),
  });

  useCommand({
    id: "toggle-soloed",
    title: "Toggle solo",
    group: "Object",
    icon: "solo",
    keywords: ["solo", "unsolo", "audio", "listen"],
    available: () => nodes().length > 0,
    run: () => toggleSelectionSoloed(world),
  });

  return null;
}
