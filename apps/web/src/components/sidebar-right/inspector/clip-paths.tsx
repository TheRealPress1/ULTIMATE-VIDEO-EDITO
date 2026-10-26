/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show } from "solid-js";
import { PanelSection } from "@/components/ui/panel-section";
import { Cache } from "@diffusionstudio/runtime";
import { useDerived, useEditor } from "@/engine/hooks";
import { ContainerRow } from "./masks";

import type { Entity } from "koota";

// Stable identity, so a node without clip paths does not resample every tick.
const NO_CLIP_PATHS: Entity[] = [];

type ClipPathsSettingsProps = {
  selection: Entity[];
};

/**
 * The `<clipPath>`s the selected node was given in its JSX, one row each.
 * Clip paths are on their way out of the UI in favour of masks: nothing here
 * adds or edits one, a row only removes it, and a node without any shows no
 * section at all.
 */
export function ClipPathsSettings(props: ClipPathsSettingsProps) {
  const editor = useEditor();
  const entity = () => props.selection[0]!;

  // Cache is derived state, written without change events.
  const clipPaths = useDerived(() => entity().get(Cache)?.clipPaths ?? NO_CLIP_PATHS);

  return (
    <Show when={clipPaths().length > 0}>
      <PanelSection title="Clip Path">
        <For each={clipPaths()}>
          {(clipPath) => (
            <ContainerRow
              container={clipPath}
              label="Shape"
              onRemove={() => editor.remove(clipPath)}
            />
          )}
        </For>
      </PanelSection>
    </Show>
  );
}
