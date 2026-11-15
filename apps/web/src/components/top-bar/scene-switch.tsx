/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show } from "solid-js";
import { useQuery, useTrait } from "@diffusionstudio/koota-solid";
import { Name, Scene } from "@diffusionstudio/runtime";

import { Icon } from "@/components/ui/icon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useActiveScene, useEditor } from "@/engine/hooks";

import type { Entity } from "koota";

/**
 * Which scene the monitor and the timeline are on, after the project's name.
 * Only a project with more than one scene has a choice to make.
 */
export function SceneSwitch() {
  const scenes = useQuery(Scene);
  const active = useActiveScene();
  const editor = useEditor();
  const name = useTrait(active, Name);

  return (
    <Show when={scenes().length > 1}>
      <span class="cutroom-crumb-sep" aria-hidden="true">/</span>
      <DropdownMenu placement="bottom-start">
        <DropdownMenuTrigger as="button" type="button" class="cutroom-scene-switch" aria-label="Scene">
          <span class="min-w-0 truncate">{name()?.value || "Scene"}</span>
          <Icon name="chevron-down" class="size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="min-w-[180px]">
            <For each={scenes()}>{(scene) => <SceneItem scene={scene} active={active() === scene} onSelect={() => editor.activate(scene)} />}</For>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </Show>
  );
}

function SceneItem(props: { scene: Entity; active: boolean; onSelect: () => void }) {
  const name = useTrait(() => props.scene, Name);

  return (
    <DropdownMenuItem onSelect={props.onSelect} class={props.active ? "font-550" : undefined}>
      <span class="cutroom-scene-dot" classList={{ "is-active": props.active }} aria-hidden="true" />
      {name()?.value || "Scene"}
    </DropdownMenuItem>
  );
}
