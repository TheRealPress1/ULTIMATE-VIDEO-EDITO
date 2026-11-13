/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For } from "solid-js";
import { useQuery, useTrait } from "@diffusionstudio/koota-solid";
import { Name, Scene } from "@diffusionstudio/runtime";
import { useActiveScene, useEditor } from "@/engine/hooks";

import type { Entity } from "koota";

/**
 * The program monitor's tabs: one per scene, the active one underlined, as a
 * sequence's tab is in an editing timeline. A press makes that scene the one
 * the monitor shows and the timeline edits.
 */
export function SceneTabs() {
  const scenes = useQuery(Scene);
  const active = useActiveScene();
  const editor = useEditor();

  return (
    <div class="cutroom-scene-tabs" role="tablist" aria-label="Scenes">
      <span class="cutroom-scene-tabs-label">Program</span>
      <For each={scenes()}>
        {(scene) => <SceneTab scene={scene} active={active() === scene} onSelect={() => editor.activate(scene)} />}
      </For>
    </div>
  );
}

function SceneTab(props: { scene: Entity; active: boolean; onSelect: () => void }) {
  const name = useTrait(() => props.scene, Name);

  return (
    <button type="button" role="tab" aria-selected={props.active} class="cutroom-scene-tab" classList={{ "is-active": props.active }} onClick={props.onSelect}>
      {name()?.value || "Scene"}
    </button>
  );
}
