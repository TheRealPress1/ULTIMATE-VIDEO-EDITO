/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useWorld } from "@diffusionstudio/koota-solid";
import { Scene } from "@diffusionstudio/runtime";
import { useProject } from "@/context/project";
import { generateCaptions } from "@/engine/generate";
import { useActiveScene, useSelection } from "@/engine/hooks";

/**
 * Captions for the selected scene, or the active one, the one being edited,
 * when nothing is selected. A selection without a scene in it has none: other
 * nodes are not captioned.
 */
export function useAutoCaptions() {
  const world = useWorld();
  const project = useProject();
  const { nodes } = useSelection();
  const active = useActiveScene();

  const scene = () => {
    const selected = nodes();
    return selected.length ? selected.find((node) => node.has(Scene)) ?? null : active();
  };

  const generate = () => {
    const target = scene();
    if (target) {
      generateCaptions(world, target, project.dir());
    }
  };

  return { scene, generate };
}
