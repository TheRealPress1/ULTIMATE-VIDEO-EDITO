/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useWorld } from "@diffusionstudio/koota-solid";
import { isSequence } from "@diffusionstudio/runtime";
import { useCommand } from "@/context/commands";
import { useActiveScene, useSelection } from "@/engine";
import { addTrack, removeSelectedTracks } from "@/engine/tracks";

/**
 * Adding and deleting tracks. A track is added above the one that is selected
 * (or on top when nothing is), as a track is in an editor, and named for the
 * next free number of its kind.
 */
export function TrackCommands() {
  const world = useWorld();
  const { nodes } = useSelection();
  const scene = useActiveScene();

  useCommand({
    id: "add-video-track",
    title: "Add video track",
    group: "Timeline",
    icon: "plus-add",
    keywords: ["track", "layer", "row", "video", "picture", "sequence"],
    available: () => scene() !== null,
    run: () => addTrack(world, "video", "above", nodes()[0]),
  });

  useCommand({
    id: "add-audio-track",
    title: "Add audio track",
    group: "Timeline",
    icon: "plus-add",
    keywords: ["track", "layer", "row", "audio", "sound", "music", "sequence"],
    available: () => scene() !== null,
    run: () => addTrack(world, "audio", "above", nodes()[0]),
  });

  useCommand({
    id: "delete-track",
    title: "Delete track",
    group: "Timeline",
    icon: "close-remove",
    keywords: ["track", "remove", "row", "layer", "sequence"],
    available: () => nodes().some((node) => isSequence(node)),
    run: () => removeSelectedTracks(world),
  });

  return null;
}
