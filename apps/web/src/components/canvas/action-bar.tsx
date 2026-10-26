/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bar over the canvas, beside the toolbar, that a tool or a command puts
// up while it works: what it applies to, and the way out. The pieces here are
// what bars share; what goes between them is each bar's own.

import { Match, Show, Switch, onCleanup, onMount } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { Name } from "@diffusionstudio/runtime";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getClipFallbackName } from "@/engine/timeline/style";
import { cx } from "@/lib/cva";
import { useLayout } from "@/context/layout";
import { BAR_SLOT_CLASS } from "./toolbar-slot";

import type { Entity } from "koota";
import type { JSX } from "solid-js";

export function ActionBar(props: { class?: string; children: JSX.Element }) {
  const { toolbarSlot } = useLayout();

  return (
    <div
      class={cx(
        "absolute z-10 rounded-xl px-1.5 py-1 bg-background border border-border flex gap-1 items-center",
        BAR_SLOT_CLASS[toolbarSlot()],
        props.class,
      )}
    >
      {props.children}
    </div>
  );
}

/**
 * Whether a key press is the bar's to answer: not one typed into a field,
 * nor one an open menu, popover or dialog has the focus for — Esc there
 * closes that, not the bar.
 */
export function isBarKey(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return false;
  if (!(target instanceof HTMLElement)) return true;
  return !target.isContentEditable && !target.closest('[role="dialog"], [role="menu"], [role="listbox"]');
}

/**
 * Calls `handler` on the key presses that `matches`, while the calling
 * component is mounted, ahead of the editor's shortcuts, which then never
 * see them: ⌘↵ and Esc mean something else there.
 */
export function useBarKey(matches: (event: KeyboardEvent) => boolean, handler: () => void): void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!matches(event) || !isBarKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    handler();
  };

  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
}

type ActionBarTargetProps = {
  /** What the action is applied to. */
  nodes: Entity[];
  /** What it does to them: "Upscale". */
  verb: string;
  /** Them, counted: "3 layers". */
  plural?: string;
  /** What to select, while nothing it applies to is. */
  empty: string;
};

/** What the bar's action applies to: the node by name, or how many; what to select while there are none. */
export function ActionBarTarget(props: ActionBarTargetProps) {
  return (
    <span class="px-2 text-xs text-muted-foreground whitespace-nowrap">
      <Switch>
        <Match when={props.nodes.length === 0}>{props.empty}</Match>
        <Match when={props.nodes.length === 1}>
          {props.verb} <NodeName node={props.nodes[0]!} />
        </Match>
        <Match when={props.nodes.length > 1}>
          {props.verb} <span class="text-foreground">{props.nodes.length} {props.plural ?? "layers"}</span>
        </Match>
      </Switch>
    </span>
  );
}

function NodeName(props: { node: Entity }) {
  const world = useWorld();
  const name = useTrait(() => props.node, Name);
  return <span class="text-foreground">{name()?.value || getClipFallbackName(world, props.node)}</span>;
}

/** What confirming costs, once that is known. */
export function ActionBarCredits(props: { credits: number | undefined }) {
  return (
    <Show when={props.credits !== undefined}>
      <span class="flex items-center pr-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        <Icon name="ai-credits-small" />
        {props.credits!.toLocaleString()}
      </span>
    </Show>
  );
}

export function ActionBarCancel(props: { onCancel(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger as={Button} variant="ghost" class="text-muted-foreground" onClick={() => props.onCancel()}>
        Cancel
      </TooltipTrigger>
      <TooltipContent shortcut="Esc">Cancel</TooltipContent>
    </Tooltip>
  );
}

type ActionBarConfirmProps = {
  onConfirm(): void;
  disabled?: boolean;
  /** What confirming does, on hover. */
  hint?: JSX.Element;
  /** The button's label; "Confirm" when left out. */
  children?: JSX.Element;
};

/** The bar's go-ahead, on ⌘↵ as well as on a click. */
export function ActionBarConfirm(props: ActionBarConfirmProps) {
  // ⌘↵ is the bar's while it has a Confirm, even a disabled one: the editor
  // would wrap the selection in a scene.
  useBarKey(
    (event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey,
    () => {
      if (!props.disabled) props.onConfirm();
    },
  );

  return (
    <Tooltip>
      <TooltipTrigger as={Button} disabled={props.disabled} onClick={() => props.onConfirm()}>
        {props.children ?? "Confirm"}
      </TooltipTrigger>
      <TooltipContent shortcut="⌘↵">{props.hint ?? "Confirm"}</TooltipContent>
    </Tooltip>
  );
}
