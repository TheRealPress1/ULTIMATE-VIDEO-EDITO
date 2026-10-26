/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal, onMount, onCleanup, For, Show, createMemo } from "solid-js";
import { assetFolder, assetName } from "@diffusionstudio/assets";
import { replaceAssetSource, saveAssetAs } from "@/engine/asset-actions";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { AssetThumbnail } from "../ui/asset-thumbnail";
import { MiddleEllipsis } from "../ui/middle-ellipsis";
import { formatAssetDuration } from "@/utils";
import { useLibrary } from "@/engine/library";

import type { Asset } from "@diffusionstudio/assets";

export type LazyAssetItemProps = {
  asset: Asset;
  selected: boolean;
  /** Selected along with other items: the menu then acts on all of them. */
  multiple: boolean;
  onSelect(event: MouseEvent): void;
  onContextSelect(): void;
  onDragStart(event: DragEvent): void;
  /** Inserts the selection at the start of the timeline. */
  onInsertAtStart(): void;
  /** Inserts the selection at the playhead. */
  onInsertAtPlayhead(): void;
  /** Every folder in the library, offered as move targets. */
  folders: string[];
  /** Moves the selection into a folder ('' = root). */
  onMove(folder: string): void;
  /** Deletes the selection. */
  onDelete(): void;
};

/**
 * A lazy loaded asset item. Clears the buffer when not visible.
 */
export function LazyAssetItem(props: LazyAssetItemProps) {
  const library = useLibrary();

  const [isVisible, setIsVisible] = createSignal(false);
  const [isRenaming, setIsRenaming] = createSignal(false);
  const assetDuration = createMemo(() => formatAssetDuration(props.asset));
  const name = () => assetName(props.asset);

  let ref: HTMLDivElement | undefined;

  onMount(() => {
    if (!ref) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { rootMargin: "100px" }
    );

    observer.observe(ref);
    onCleanup(() => observer.disconnect());
  });

  const commitRename = (nextName: string) => {
    if (!isRenaming()) return;
    setIsRenaming(false);
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === name()) return;
    library()?.rename(props.asset, trimmed);
  };

  const handleRenameKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsRenaming(false);
    }
  };

  const handleFocusElement = (el: HTMLInputElement) => {
    queueMicrotask(() => {
      el.focus();
      el.select();
    });
  };

  const handleReplaceMedia = async () => {
    const lib = library();
    if (lib) await replaceAssetSource(lib, props.asset);
  };

  const handleSaveAs = () => saveAssetAs(props.asset);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        as="div"
        class="flex flex-col gap-1 text-left"
        data-asset-id={props.asset.id}
        draggable={true}
        onDragStart={(event: DragEvent) => props.onDragStart(event)}
        onClick={(event: MouseEvent) => props.onSelect(event)}
        onContextMenu={() => props.onContextSelect()}>
        <div
          ref={ref}
          data-selected={props.selected}
          class="relative aspect-video w-full rounded bg-muted after:pointer-events-none after:absolute after:-inset-px after:rounded-[5px] after:opacity-0 after:ring-2 after:ring-inset after:ring-ring after:z-10 data-[selected=true]:after:opacity-100"
        >
          <Show when={isVisible()}>
            <AssetThumbnail asset={props.asset} class="absolute inset-0 overflow-clip rounded" cache={library()?.cache} />
          </Show>
          <Show when={assetDuration()}>
            {(duration) => (
              <div class="absolute left-1 top-1 z-20 flex h-4 items-center justify-center rounded bg-overlay px-1">
                <span class="text-xxs text-primary-foreground">
                  {duration()}
                </span>
              </div>
            )}
          </Show>
        </div>
        <Show
          when={isRenaming()}
          fallback={
            <MiddleEllipsis
              text={name()}
              data-selected={props.selected}
              class="text-xs text-muted-foreground select-none data-[selected=true]:text-foreground"
              title={props.asset.source}
            />
          }
        >
          <input
            ref={handleFocusElement}
            type="text"
            name="asset-name"
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
        <ContextMenuContent class="w-[180px]">
          <ContextMenuSub>
            <ContextMenuSubTrigger>Insert...</ContextMenuSubTrigger>
            <ContextMenuPortal>
              <ContextMenuSubContent class="w-[180px]">
                <ContextMenuGroup>
                  <ContextMenuItem onSelect={props.onInsertAtStart}>
                    Insert at start
                    <ContextMenuShortcut>⇧,</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={props.onInsertAtPlayhead}>
                    Insert at playhead
                    <ContextMenuShortcut>,</ContextMenuShortcut>
                  </ContextMenuItem>
                </ContextMenuGroup>
              </ContextMenuSubContent>
            </ContextMenuPortal>
          </ContextMenuSub>
          <Show when={props.folders.length > 0}>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Move to...</ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent class="w-[220px]">
                  <ContextMenuGroup>
                    <ContextMenuItem
                      disabled={!props.multiple && assetFolder(props.asset) === ""}
                      onSelect={() => props.onMove("")}>
                      All assets
                    </ContextMenuItem>
                    <For each={props.folders}>
                      {(folder) => (
                        <ContextMenuItem
                          disabled={!props.multiple && assetFolder(props.asset) === folder}
                          onSelect={() => props.onMove(folder)}>
                          <MiddleEllipsis text={folder} title={folder} class="min-w-0 flex-1" />
                        </ContextMenuItem>
                      )}
                    </For>
                  </ContextMenuGroup>
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>
          </Show>
          <Show when={!props.multiple}>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onSelect={() => setIsRenaming(true)}>
                Rename
              </ContextMenuItem>
              <ContextMenuItem onSelect={handleReplaceMedia}>
                Replace
              </ContextMenuItem>
              <ContextMenuItem onSelect={handleSaveAs}>
                Save as
              </ContextMenuItem>
            </ContextMenuGroup>
          </Show>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={props.onDelete}>
            Delete
            <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  );
}
