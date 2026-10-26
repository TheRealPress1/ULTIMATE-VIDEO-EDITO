/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { PromptInput } from "../genai/prompt-input";
import { CommandBar } from "../commands";
import { ObjectMaskBar } from "./object-mask-bar";
import { MaskBar } from "./mask-bar";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Tool, ToolType } from "@diffusionstudio/runtime";
import { useWorld } from "@diffusionstudio/koota-solid";
import { cancelMask, cancelObjectMask, clearMaskTarget, useTool } from "@/engine";
import { usePromptInput } from "@/context/prompt-input";
import { useCommands } from "@/context/commands";
import { TOOLBAR_SLOTS, useLayout } from "@/context/layout";
import { TOOLBAR_SLOT_ANCHOR, TOOLBAR_SLOT_CLASS, isTopSlot } from "./toolbar-slot";
import { cx } from "@/lib/cva";
import { LOCAL_MODE } from "@/lib/environment";
import { isInputTarget } from "@/utils";

import type { ToolbarSlot } from "@/context/layout";

const CURSOR_TOOLS = [
  { tool: ToolType.MOVE, label: 'Move', shortcut: 'V', icon: 'move', menuIcon: 'move-small' },
  { tool: ToolType.HAND, label: 'Hand', shortcut: 'H', icon: 'hand', menuIcon: 'hand' },
  { tool: ToolType.OBJECT_MASK, label: 'Object Mask', shortcut: 'M', icon: 'object-mask', menuIcon: 'object-mask' },
] as const;

const SHAPE_TOOLS = [
  { tool: ToolType.RECT, label: 'Rectangle', shortcut: 'R', icon: 'tool.rectangle', menuIcon: 'tool.rectangle-small' },
  { tool: ToolType.ELLIPSE, label: 'Ellipse', shortcut: 'O', icon: 'tool.ellipse', menuIcon: 'tool.ellipse-small' },
  { tool: ToolType.POLYGON, label: 'Polygon', shortcut: undefined, icon: 'tool.polygon', menuIcon: 'tool.polygon-small' },
] as const;

type ShapeTool = (typeof SHAPE_TOOLS)[number];

// The shape the toolbar offers: the one last picked, however it was picked.
// Outlives the toolbar, which unmounts with the canvas.
const [lastShapeTool, setLastShapeTool] = createSignal<ShapeTool>(SHAPE_TOOLS[0]);

/** How far the pointer goes, pressed on the toolbar, before the press is a drag rather than a click. */
const DRAG_THRESHOLD = 4;

export function Toolbar() {
  const world = useWorld();
  const { promptInputOpen, promptInputConfig, setPromptInputOpen } = usePromptInput();
  const generationOpen = () => !LOCAL_MODE && promptInputOpen();
  const commands = useCommands();
  const { toolbarSlot, setToolbarSlot } = useLayout();
  const selectedTool = useTool();
  const cursorTool = createMemo(() => CURSOR_TOOLS.find((cursor) => cursor.tool === selectedTool()));
  const shapeTool = createMemo(() => SHAPE_TOOLS.find((shape) => shape.tool === selectedTool()));
  // Editing a path's vertices is the pen's other half, as in Figma.
  const penTool = () => selectedTool() === ToolType.PEN || selectedTool() === ToolType.PATH_EDIT;

  createEffect(() => {
    const shape = shapeTool();
    if (shape) setLastShapeTool(shape);
  });

  createEffect(() => {
    if (selectedTool() !== ToolType.MASK) {
      clearMaskTarget();
    }
  });

  // One bar over the canvas at a time, whichever came up last: a command's
  // bar puts down the prompt box and the tools that have bars of their own,
  // and either of those coming up takes the command's bar down.
  createEffect(on(commands.active, (command) => {
    if (!command) return;
    setPromptInputOpen(false);
    if (selectedTool() === ToolType.OBJECT_MASK) cancelObjectMask(world);
    if (selectedTool() === ToolType.MASK) cancelMask(world);
  }));

  createEffect(on([promptInputOpen, selectedTool], ([open, tool]) => {
    if ((!LOCAL_MODE && open) || tool === ToolType.OBJECT_MASK || tool === ToolType.MASK) commands.close();
  }));

  const handleToolChange = (tool: ToolType) => {
    world.set(Tool, { value: tool });
  }

  // G opens and closes the prompt box, as its button does. The box lives
  // here rather than in the engine, so its key is bound here rather than in
  // the engine's shortcut table.
  const handleGenerateKey = (event: KeyboardEvent) => {
    if (LOCAL_MODE) return;
    if (event.key.toLowerCase() !== "g" || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isInputTarget(event)) return;

    event.preventDefault();
    setPromptInputOpen(!promptInputOpen());
  };

  onMount(() => {
    if (!LOCAL_MODE) window.addEventListener("keydown", handleGenerateKey);
  });
  onCleanup(() => window.removeEventListener("keydown", handleGenerateKey));

  // Dragging the toolbar shows the other slots it can go to, the one nearest
  // the pointer drawn wide; the toolbar stays put until it is let go of, and
  // then moves there.
  let toolbar!: HTMLDivElement;
  const [dropSlot, setDropSlot] = createSignal<ToolbarSlot>();
  const dragging = () => dropSlot() !== undefined;
  let press: { x: number; y: number; pointerId: number } | undefined;

  const nearestSlot = (x: number, y: number) => {
    const canvas = toolbar.offsetParent!.getBoundingClientRect();
    let nearest = toolbarSlot();
    let nearestDistance = Infinity;
    for (const slot of TOOLBAR_SLOTS) {
      const anchor = TOOLBAR_SLOT_ANCHOR[slot];
      const distance = Math.hypot(
        x - (canvas.left + anchor.x * canvas.width),
        y - (canvas.top + anchor.y * canvas.height),
      );
      if (distance < nearestDistance) {
        nearest = slot;
        nearestDistance = distance;
      }
    }
    return nearest;
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== press?.pointerId) return;
    if (!dragging()) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
      // Captured, the press no longer ends in a click on the button it began on.
      toolbar.setPointerCapture(event.pointerId);
    }
    setDropSlot(nearestSlot(event.clientX, event.clientY));
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== press?.pointerId) return;
    press = undefined;
    const slot = dropSlot();
    if (slot) setToolbarSlot(slot);
    setDropSlot(undefined);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  };

  const handlePointerDown = (event: PointerEvent) => {
    // Menus open on the press: one begun on their trigger is theirs.
    if (event.button !== 0 || (event.target as Element).closest("[aria-haspopup]")) return;
    press = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  onCleanup(() => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  });

  // Up top, the menus open downwards, into the canvas.
  const menuPlacement = () => (isTopSlot(toolbarSlot()) ? "bottom-start" : "top-start");

  return (
    <>
      <Show when={generationOpen()}>
        <PromptInput initialConfig={promptInputConfig()} />
      </Show>
      <Show when={!generationOpen()}>
        <Switch fallback={<CommandBar />}>
          <Match when={selectedTool() === ToolType.OBJECT_MASK}>
            <ObjectMaskBar />
          </Match>
          <Match when={selectedTool() === ToolType.MASK}>
            <MaskBar />
          </Match>
        </Switch>
      </Show>
      <Show when={dragging()}>
        <For each={TOOLBAR_SLOTS.filter((slot) => slot !== toolbarSlot())}>
          {(slot) => (
            // As tall as the toolbar: its buttons, padding and border.
            <div
              class={cx(
                "absolute z-10 h-10.5 rounded-xl bg-foreground/6 pointer-events-none transition-all duration-150",
                TOOLBAR_SLOT_CLASS[slot],
                slot === dropSlot() ? "w-55" : "w-10.5",
              )}
            />
          )}
        </For>
      </Show>
      {/* Up top, it sits over the desktop window's drag strip, which would take its clicks. */}
      <div
        ref={toolbar}
        class={cx(
          "absolute rounded-xl p-1.5 bg-background border border-border-strong flex gap-2 items-center z-30",
          TOOLBAR_SLOT_CLASS[toolbarSlot()],
          dragging() && "cursor-grabbing",
        )}
        style="-webkit-app-region: no-drag;"
        onPointerDown={handlePointerDown}
      >
        <div class="flex gap-1">
          <Tooltip>
            <TooltipTrigger
              as={Button}
              size="icon-square"
              class={cursorTool() ? 'text-foreground' : 'text-muted-foreground'}
              variant={cursorTool() ? 'default' : 'ghost'}
              onClick={() => handleToolChange(cursorTool()?.tool ?? ToolType.MOVE)}
            >
              <Icon name={(cursorTool() ?? CURSOR_TOOLS[0]!).icon} />
            </TooltipTrigger>
            <TooltipContent shortcut={(cursorTool() ?? CURSOR_TOOLS[0]!).shortcut}>
              {(cursorTool() ?? CURSOR_TOOLS[0]!).label}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu placement={menuPlacement()}>
            <Tooltip>
              <TooltipTrigger<typeof DropdownMenuTrigger>
                as={(triggerProps: object) => (
                  <DropdownMenuTrigger<typeof Button>
                    {...triggerProps}
                    as={(buttonProps) => (
                      <Button {...buttonProps} size="icon-select" variant="ghost" class="text-muted-foreground">
                        <Icon name="chevron-down" />
                      </Button>
                    )}
                  />
                )}
              />
              <TooltipContent>Select tool</TooltipContent>
            </Tooltip>
            <DropdownMenuPortal>
              <DropdownMenuContent>
                <For each={CURSOR_TOOLS}>
                  {(cursor) => (
                    <DropdownMenuItem class="px-0 pr-2 gap-0.5" onSelect={() => handleToolChange(cursor.tool)}>
                      <div classList={{ "visible": selectedTool() === cursor.tool }} class="invisible">
                        <Icon name="confirm-check" class="text-foreground" />
                      </div>
                      <Icon name={cursor.menuIcon} class="text-foreground" />
                      <span class="mx-1 flex-1 whitespace-nowrap">{cursor.label}</span>
                      <DropdownMenuShortcut class="pl-6">{cursor.shortcut}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  )}
                </For>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
        </div>
        <Separator orientation="vertical" class="min-h-5" />
        <Tooltip>
          <TooltipTrigger
            as={Button}
            size="icon-square"
            variant={selectedTool() === ToolType.SCENE ? 'default' : 'ghost'}
            onClick={() => handleToolChange(ToolType.SCENE)}
            class={selectedTool() === ToolType.SCENE ? 'text-foreground' : 'text-muted-foreground'}
          >
            <Icon name="frame" class="size-5" />
          </TooltipTrigger>
          <TooltipContent shortcut="F">Scene</TooltipContent>
        </Tooltip>
        <div class="flex gap-1">
          <Tooltip>
            <TooltipTrigger
              as={Button}
              size="icon-square"
              variant={shapeTool() ? 'default' : 'ghost'}
              onClick={() => handleToolChange(lastShapeTool().tool)}
              class={shapeTool() ? 'text-foreground' : 'text-muted-foreground'}
            >
              <Icon name={lastShapeTool().icon} />
            </TooltipTrigger>
            <TooltipContent shortcut={lastShapeTool().shortcut}>{lastShapeTool().label}</TooltipContent>
          </Tooltip>
          <DropdownMenu placement={menuPlacement()}>
            <Tooltip>
              <TooltipTrigger<typeof DropdownMenuTrigger>
                as={(triggerProps: object) => (
                  <DropdownMenuTrigger<typeof Button>
                    {...triggerProps}
                    as={(buttonProps) => (
                      <Button {...buttonProps} size="icon-select" variant="ghost" class="text-muted-foreground">
                        <Icon name="chevron-down" />
                      </Button>
                    )}
                  />
                )}
              />
              <TooltipContent>Shape tools</TooltipContent>
            </Tooltip>
            <DropdownMenuPortal>
              <DropdownMenuContent>
                <For each={SHAPE_TOOLS}>
                  {(shape) => (
                    <DropdownMenuItem class="px-0 pr-2 gap-0.5" onSelect={() => handleToolChange(shape.tool)}>
                      <div classList={{ "visible": selectedTool() === shape.tool }} class="invisible">
                        <Icon name="confirm-check" class="text-foreground" />
                      </div>
                      <Icon name={shape.menuIcon} class="text-foreground" />
                      <span class="mx-1 flex-1 whitespace-nowrap">{shape.label}</span>
                      <DropdownMenuShortcut class="pl-6">{shape.shortcut}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  )}
                </For>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
        </div>
        <Tooltip>
          <TooltipTrigger
            as={Button}
            size="icon-square"
            variant={penTool() ? 'default' : 'ghost'}
            onClick={() => handleToolChange(ToolType.PEN)}
            class={penTool() ? 'text-foreground' : 'text-muted-foreground'}
          >
            <Icon name="tool.pen" />
          </TooltipTrigger>
          <TooltipContent shortcut="P">Pen</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            as={Button}
            size="icon-square"
            variant={selectedTool() === ToolType.TEXT ? 'default' : 'ghost'}
            onClick={() => handleToolChange(ToolType.TEXT)}
            class={selectedTool() === ToolType.TEXT ? 'text-foreground' : 'text-muted-foreground'}
          >
            <Icon name="tool.text" />
          </TooltipTrigger>
          <TooltipContent shortcut="T">Text</TooltipContent>
        </Tooltip>
        <Show when={!LOCAL_MODE}>
          <Tooltip>
            <TooltipTrigger
              as={Button}
              size="icon-square"
              class={promptInputOpen() ? 'text-foreground' : 'text-muted-foreground'}
              variant={promptInputOpen() ? 'default' : 'ghost'}
              onClick={() => setPromptInputOpen(!promptInputOpen())}
            >
              <Icon name="ai-generate" class="size-7" />
            </TooltipTrigger>
            <TooltipContent shortcut="G">AI generate</TooltipContent>
          </Tooltip>
        </Show>
        <Separator orientation="vertical" class="min-h-5" />
        <Tooltip>
          <TooltipTrigger
            as={Button}
            size="icon-square"
            variant="ghost"
            class="text-muted-foreground"
            onClick={() => commands.setPaletteOpen(true)}
          >
            <Icon name="tool.actions-spotlight" />
          </TooltipTrigger>
          <TooltipContent shortcut="⌘K">Actions</TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}
