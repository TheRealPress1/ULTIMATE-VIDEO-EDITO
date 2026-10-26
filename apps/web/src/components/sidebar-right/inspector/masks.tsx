/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For } from "solid-js";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/ui/icon";
import { ItemRow } from "@/components/ui/item-row";
import { PanelSection } from "@/components/ui/panel-section";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { Cache, Name } from "@diffusionstudio/runtime";
import { beginMaskFor } from "@/engine/mask";
import { useDerived, useEditor } from "@/engine/hooks";

import type { Entity } from "koota";

// Stable identity, so a node without masks does not resample every tick.
const NO_MASKS: Entity[] = [];

type MasksSettingsProps = {
  selection: Entity[];
};

/**
 * The `<mask>`s of the selected node, one row each (several intersect). A
 * mask is the layers under it and has no inspector of its own: a row selects
 * its layers, whose transform, time and appearance panels are then the ones
 * shown. The plus picks up the mask tool, whose bar over the canvas puts the
 * layers selected there into a new mask of this node.
 */
export function MasksSettings(props: MasksSettingsProps) {
  const world = useWorld();
  const editor = useEditor();
  const entity = () => props.selection[0]!;

  // Cache is derived state, written without change events.
  const masks = useDerived(() => entity().get(Cache)?.masks ?? NO_MASKS);

  return (
    <PanelSection
      title="Masks"
      actions={
        <Tooltip>
          <TooltipTrigger
            as={Button}
            size="icon"
            variant="ghost"
            class="text-muted-foreground"
            onClick={() => beginMaskFor(world, entity())}
          >
            <Icon name="plus-add" />
          </TooltipTrigger>
          <TooltipContent>Add mask</TooltipContent>
        </Tooltip>
      }
    >
      <For each={masks()}>
        {(mask) => (
          <ContainerRow
            container={mask}
            label="Mask"
            onSelect={() => {
              // A mask drawn from a file has no layers to select.
              const children = mask.get(Cache)?.children ?? [];
              if (children.length) editor.select(children);
            }}
            onRemove={() => editor.remove(mask)}
          />
        )}
      </For>
    </PanelSection>
  );
}

type ContainerRowProps = {
  /** The `<mask>` or `<clipPath>`. */
  container: Entity;
  label: string;
  onSelect?(): void;
  onRemove(): void;
};

/** One mask or clip path of a node: its name selects its layers (when it can), the × removes it with them. */
export function ContainerRow(props: ContainerRowProps) {
  const name = useTrait(() => props.container, Name);

  return (
    <ItemRow
      label={props.label}
      value={name()?.value || props.label}
      icon={<Icon name="mask-small" />}
      class="text-foreground"
      onClick={props.onSelect}
    >
      <Tooltip>
        <TooltipTrigger
          as={Button}
          size="icon"
          variant="ghost"
          class="text-muted-foreground"
          onClick={props.onRemove}
        >
          <Icon name="close-remove-small" />
        </TooltipTrigger>
        <TooltipContent>Remove {props.label.toLowerCase()}</TooltipContent>
      </Tooltip>
    </ItemRow>
  );
}
