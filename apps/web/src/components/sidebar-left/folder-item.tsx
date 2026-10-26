/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, Show } from "solid-js";
import { toast } from "somoto";
import { basename } from "@diffusionstudio/assets";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { Icon } from "../ui/icon";
import { MiddleEllipsis } from "../ui/middle-ellipsis";
import { useLibrary } from "@/engine/library";

import type { AssetLibrary } from "@diffusionstudio/assets";

/** Drag payloads: comma-separated asset ids, and newline-separated folder paths. */
export const ASSET_DRAG_TYPE = "application/x-asset-id";
export const FOLDER_DRAG_TYPE = "application/x-folder-path";

export function isAssetOrFolderDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  return types.includes(ASSET_DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE);
}

/**
 * Handles a drop of an internal asset/folder drag onto the target folder
 * ('' = root). Returns true when the event was an internal drag.
 */
export function handleFolderDrop(library: AssetLibrary | undefined, event: DragEvent, target: string): boolean {
  if (!library) return false;

  const assetIds = event.dataTransfer?.getData(ASSET_DRAG_TYPE)?.split(",").filter(Boolean) ?? [];
  const folders = event.dataTransfer?.getData(FOLDER_DRAG_TYPE)?.split("\n").filter(Boolean) ?? [];
  if (!assetIds.length && !folders.length) return false;

  const assets = assetIds.map((id) => library.get(id)).filter((asset) => asset !== undefined);
  if (assets.length) library.move(assets, target);

  for (const folder of folders) {
    // A selected folder dropped on itself stays put; the rest of the selection goes in.
    if (folder === target) continue;
    if (target.startsWith(`${folder}/`)) {
      toast("Cannot move a folder into itself");
    } else {
      library.moveFolder(folder, target);
    }
  }
  return true;
}

export type FolderItemProps = {
  /** The folder's library path. */
  path: string;
  renaming: boolean;
  selected: boolean;
  /** Selected along with other items: the menu then acts on all of them. */
  multiple: boolean;
  onSelect(event: MouseEvent): void;
  onContextSelect(): void;
  onDragStart(event: DragEvent): void;
  onRenameStart(): void;
  onRenameEnd(): void;
  /** Escape in the name field: keeps the old name. */
  onRenameCancel(): void;
  onOpen(): void;
  /** Deletes the selection. */
  onDelete(): void;
};

export function FolderItem(props: FolderItemProps) {
  const library = useLibrary();
  const [isDropTarget, setIsDropTarget] = createSignal(false);

  const name = () => basename(props.path);
  const childCount = createMemo(() => {
    const children = library()?.childrenOf(props.path);
    return children ? children.folders.length + children.assets.length : 0;
  });

  const handleDragOver = (event: DragEvent) => {
    if (!isAssetOrFolderDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDropTarget(true);
  };

  const handleDrop = (event: DragEvent) => {
    if (!isAssetOrFolderDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDropTarget(false);
    handleFolderDrop(library(), event, props.path);
  };

  const commitRename = (nextName: string) => {
    if (!props.renaming) return;
    props.onRenameEnd();
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === name()) return;
    library()?.renameFolder(props.path, trimmed);
  };

  const handleRenameKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onRenameCancel();
    }
  };

  let input: HTMLInputElement | undefined;

  const handleFocusElement = (el: HTMLInputElement) => {
    input = el;
    queueMicrotask(() => {
      el.focus();
      el.select();
    });
  };

  // The open menu traps focus, so "Rename" cannot focus the field; focus it
  // once the menu is gone, instead of handing focus back to the trigger.
  const handleMenuCloseAutoFocus = (event: Event) => {
    if (!props.renaming || !input) return;
    event.preventDefault();
    input.focus();
    input.select();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        as="div"
        class="flex flex-col gap-1 text-left"
        data-folder-path={props.path}
        draggable={true}
        onDragStart={(event: DragEvent) => props.onDragStart(event)}
        on:dragover={handleDragOver}
        on:dragleave={() => setIsDropTarget(false)}
        on:drop={handleDrop}
        onClick={(event: MouseEvent) => props.onSelect(event)}
        onDblClick={() => props.onOpen()}
        onContextMenu={() => props.onContextSelect()}
      >
        <div
          data-drop-target={isDropTarget()}
          data-selected={props.selected}
          class="relative aspect-video w-full rounded bg-muted flex items-center justify-center after:pointer-events-none after:absolute after:-inset-px after:rounded-[5px] after:opacity-0 after:ring-2 after:ring-inset after:ring-ring after:z-10 data-[drop-target=true]:after:opacity-100 data-[selected=true]:after:opacity-100"
        >
          <Icon name="folder-thumbnail" class="w-8 h-6 text-muted-foreground pointer-events-none" />
          <Show when={childCount() > 0}>
            <div class="absolute left-1 top-1 z-20 flex h-4 items-center justify-center rounded bg-overlay px-1">
              <span class="text-xxs text-primary-foreground">{childCount()}</span>
            </div>
          </Show>
        </div>
        <Show
          when={props.renaming}
          fallback={
            <MiddleEllipsis
              text={name()}
              data-selected={props.selected}
              class="text-xs text-muted-foreground select-none data-[selected=true]:text-foreground"
            />
          }
        >
          <input
            ref={handleFocusElement}
            type="text"
            name="folder-name"
            autocomplete="off"
            value={name()}
            onKeyDown={handleRenameKeyDown}
            onBlur={(e) => commitRename(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            class="text-xs text-foreground truncate bg-transparent rounded-sm outline-none ring-1 ring-primary px-0.5"
          />
        </Show>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent class="w-[220px]" onCloseAutoFocus={handleMenuCloseAutoFocus}>
          <Show when={!props.multiple}>
            <ContextMenuItem onSelect={props.onOpen}>
              Open
              <ContextMenuShortcut>⌘↓</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={props.onRenameStart}>Rename</ContextMenuItem>
            <ContextMenuSeparator />
          </Show>
          <ContextMenuItem onSelect={props.onDelete}>
            Delete
            <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  );
}
