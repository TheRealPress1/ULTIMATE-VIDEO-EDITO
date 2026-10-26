/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { basename, dirname } from "@diffusionstudio/assets";
import { usePromptInput } from "@/context/prompt-input";
import { restoreConfig } from "@/components/genai/saved-config";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { useWorld } from "@diffusionstudio/koota-solid";
import { SidebarTabs } from "@/agent-chat";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { toast } from "somoto";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Breadcrumbs,
  BreadcrumbList,
  BreadcrumbsEllipsis,
  BreadcrumbsItem,
  BreadcrumbsLink,
  BreadcrumbsSeparator,
} from "../ui/breadcrumbs";
import { LazyAssetItem } from "./asset-item";
import { clearRevealRequest, revealRequest } from "./reveal";
import { FolderItem, handleFolderDrop, isAssetOrFolderDrag, ASSET_DRAG_TYPE, FOLDER_DRAG_TYPE } from "./folder-item";
import { useLibrary } from "@/engine/library";
import { useAssetSelection } from "@/engine/hooks";
import { droppedFiles, importClipboard, importFiles, insertAssetsAtPlayhead, insertAssetsAtStart, pickAndImport } from "@/engine/asset-actions";
import { clipboardHasMedia, hasMedia, pastedMedia, readClipboardMedia } from "@/lib/clipboard";
import { isInputTarget } from "@/utils";
import { useCommand } from "@/context/commands";
import { LOCAL_MODE } from "@/lib/environment";

import type { Asset, AssetLibrary } from "@diffusionstudio/assets";

/** The ancestors of a folder path, root excluded, nearest last. */
/**
 * A grid item's selection key: an asset id or a folder path, told apart by
 * prefix so the two kinds can share one ordered list.
 */
const assetKey = (id: string) => `asset:${id}`;
const folderKey = (path: string) => `folder:${path}`;
const isAssetKey = (key: string) => key.startsWith("asset:");
const keyValue = (key: string) => key.slice(key.indexOf(":") + 1);

function ancestorsOf(path: string): string[] {
  const chain: string[] = [];
  for (let folder = path; folder; folder = dirname(folder)) chain.unshift(folder);
  return chain;
}

export function Assets() {
  let root: HTMLDivElement | undefined;
  let scroller: HTMLDivElement | undefined;
  let dragCounter = 0;
  let createdFolder: string | null = null;

  const world = useWorld();
  const library = useLibrary();
  const assetSelection = useAssetSelection();
  const { openPromptInput } = usePromptInput();
  const [query, setQuery] = createSignal("");
  const [assetFilter, setAssetFilter] = createSignal<AssetFilter>("ALL");
  const [isDragging, setIsDragging] = createSignal(false);
  const [renamingFolder, setRenamingFolder] = createSignal<string | null>(null);

  const [currentFolder, setCurrentFolder] = createSignal("");

  const allAssets = createMemo(() => library()?.list().filter((asset) => asset.type !== "SCRIPT") ?? []);
  const allFolders = createMemo(() => [...(library()?.folders() ?? [])].sort());

  const activeFilterLabel = () => {
    const value = assetFilter();
    if (value === "ALL") return null;
    return ASSET_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? null;
  };

  /** Whether an entry is in view: of the filtered type, matching the search, or in the open folder. */
  const isShown = (entry: { type: string; path: string }): boolean => {
    const q = query().trim().toLowerCase();
    const selectedFilter = assetFilter();
    if (selectedFilter !== "ALL" && entry.type !== selectedFilter) return false;
    if (q) return basename(entry.path).toLowerCase().includes(q);
    return dirname(entry.path) === currentFolder();
  };

  const filteredAssets = createMemo(() => allAssets().filter(isShown));

  const visibleFolders = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (q) {
      return allFolders().filter((folder) => basename(folder).toLowerCase().includes(q));
    }
    return library()?.childrenOf(currentFolder()).folders ?? [];
  });

  const itemCount = createMemo(() => visibleFolders().length + filteredAssets().length);

  /** The items in the grid, in its order: folders first, then assets. */
  const visibleKeys = createMemo(() => [
    ...visibleFolders().map(folderKey),
    ...filteredAssets().map((asset) => assetKey(asset.id)),
  ]);

  const selectedKeys = createMemo(() => new Set([
    ...assetSelection.folders().map(folderKey),
    ...assetSelection.ids().map(assetKey),
  ]));

  const setSelection = (keys: Iterable<string>) => {
    const unique = [...new Set(keys)];
    assetSelection.set({
      ids: unique.filter(isAssetKey).map(keyValue),
      folders: unique.filter((key) => !isAssetKey(key)).map(keyValue),
    });
  };

  // Finder's selection, as the dashboard's project grid has it: where a
  // Shift range starts, where Shift-arrows move from, and what was selected
  // before the range — the range is added to that.
  let anchor: string | null = null;
  let lead: string | null = null;
  let base: ReadonlySet<string> = new Set();

  const selectOnly = (key: string) => {
    setSelection([key]);
    anchor = lead = key;
    base = new Set();
  };

  const toggleSelected = (key: string) => {
    const next = new Set(selectedKeys());
    if (!next.delete(key)) next.add(key);
    setSelection(next);
    anchor = lead = key;
    base = new Set([...next].filter((entry) => entry !== key));
  };

  /** Selects anchor through `key` on top of `base`, or just `key` when the anchor is off the grid. */
  const selectRangeTo = (key: string) => {
    const keys = visibleKeys();
    const from = anchor === null ? -1 : keys.indexOf(anchor);
    const to = keys.indexOf(key);
    if (from < 0 || to < 0) return selectOnly(key);

    setSelection([...base, ...keys.slice(Math.min(from, to), Math.max(from, to) + 1)]);
    lead = key;
  };

  const selectAll = () => {
    const keys = visibleKeys();
    setSelection(keys);
    anchor = keys[0] ?? null;
    lead = keys.at(-1) ?? null;
    base = new Set();
  };

  const clearSelection = () => {
    setSelection([]);
    anchor = lead = null;
    base = new Set();
  };

  /** Selects what an import brought in; a dismissed picker or a refused drop keeps the selection. */
  const selectImported = (assets: ReadonlyArray<Asset>) => {
    if (!assets.length) return;
    const keys = assets.map((asset) => assetKey(asset.id));
    setSelection(keys);
    anchor = keys[0];
    lead = keys.at(-1)!;
    base = new Set();
    root?.focus();
  };

  // Items that leave the grid (another folder opened, filtered out, moved or
  // deleted) leave the selection, so keys never act on what is not in view.
  createEffect(() => {
    const visible = new Set(visibleKeys());
    const selected = untrack(selectedKeys);
    const kept = [...selected].filter((key) => visible.has(key));
    if (kept.length !== selected.size) setSelection(kept);
  });

  const handleItemClick = (key: string, event: MouseEvent) => {
    if (event.shiftKey) selectRangeTo(key);
    else if (event.metaKey || event.ctrlKey) toggleSelected(key);
    else selectOnly(key);
    root?.focus();
  };

  /** A right-click keeps a selection it lands in, like Finder; elsewhere it selects the item alone. */
  const handleItemContextMenu = (key: string) => {
    if (!selectedKeys().has(key)) selectOnly(key);
    root?.focus();
  };

  /** Drags the whole selection when the item is part of it, the item alone otherwise. */
  const handleItemDragStart = (key: string, event: DragEvent) => {
    const keys = selectedKeys().has(key) ? [...selectedKeys()] : [key];
    const assetIds = keys.filter(isAssetKey).map(keyValue);
    const folders = keys.filter((entry) => !isAssetKey(entry)).map(keyValue);
    if (assetIds.length) event.dataTransfer?.setData(ASSET_DRAG_TYPE, assetIds.join(","));
    if (folders.length) event.dataTransfer?.setData(FOLDER_DRAG_TYPE, folders.join("\n"));
    if (keys.length > 1) setSelectionDragImage(keys, event);
  };

  /**
   * Shows every dragged item under the pointer, where it sits in the grid, as
   * Finder does: copies of the items in view, laid out as they are, become the
   * drag image. Items scrolled out of view are left out, their thumbnails are
   * not loaded.
   */
  const setSelectionDragImage = (keys: string[], event: DragEvent) => {
    const viewport = scroller?.getBoundingClientRect();
    if (!event.dataTransfer || !viewport) return;

    const items = keys
      .map((key) => itemElement(key))
      .filter((element) => element !== null)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom);
    if (items.length < 2) return;

    const left = Math.min(...items.map(({ rect }) => rect.left));
    const top = Math.min(...items.map(({ rect }) => rect.top));

    // Off screen: the browser takes its picture of the element while it is in
    // the document, and it can go once the drag has begun.
    const image = document.createElement("div");
    image.style.cssText = "position: fixed; left: -10000px; top: 0; pointer-events: none;";
    for (const { element, rect } of items) {
      const copy = element.cloneNode(true) as HTMLElement;
      copy.removeAttribute("id");
      copy.style.cssText = `position: absolute; left: ${rect.left - left}px; top: ${rect.top - top}px; width: ${rect.width}px; height: ${rect.height}px;`;
      image.append(copy);
    }
    document.body.append(image);
    event.dataTransfer.setDragImage(image, event.clientX - left, event.clientY - top);
    setTimeout(() => image.remove());
  };

  const selectedAssets = () => {
    const lib = library();
    if (!lib) return [];
    return assetSelection.ids().map((id) => lib.get(id)).filter((asset) => asset !== undefined);
  };

  const insertSelectionAtStart = () => insertAssetsAtStart(world, selectedAssets());
  const insertSelectionAtPlayhead = () => insertAssetsAtPlayhead(world, selectedAssets());

  /** Moves the selection into a folder ('' = root), as a drop onto it would. */
  const moveSelectionTo = (target: string) => {
    const lib = library();
    if (!lib) return;
    const assets = selectedAssets();
    if (assets.length) lib.move(assets, target);
    for (const folder of assetSelection.folders()) {
      if (folder === target || dirname(folder) === target) continue;
      if (target.startsWith(`${folder}/`)) {
        toast("Cannot move a folder into itself");
      } else {
        lib.moveFolder(folder, target);
      }
    }
  };

  const deleteSelection = async () => {
    const lib = library();
    if (!lib) return;
    const assets = selectedAssets();
    const folders = assetSelection.folders();
    try {
      if (assets.length) await lib.remove(assets);
      // A folder inside another selected folder is gone with it.
      for (const folder of folders) {
        if (lib.folders().has(folder)) await lib.deleteFolder(folder);
      }
    } catch (e) {
      toast.error("Failed to delete", { description: (e as Error).message });
    }
  };

  const itemElement = (key: string) => {
    const attribute = isAssetKey(key) ? "data-asset-id" : "data-folder-path";
    return root?.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(keyValue(key))}"]`) ?? null;
  };

  const scrollToItem = (key: string) => {
    itemElement(key)?.scrollIntoView({ block: "nearest" });
  };

  // Deep paths collapse like the breadcrumbs docs example:
  // All assets / … / parent / current, with the hidden folders in a dropdown.
  const folderPath = createMemo(() => ancestorsOf(currentFolder()));
  const collapsedFolders = createMemo(() => {
    const path = folderPath();
    return path.length > 2 ? path.slice(0, -2) : [];
  });
  const tailFolders = createMemo(() => {
    const path = folderPath();
    return path.length > 2 ? path.slice(-2) : path;
  });

  const openFolder = (path: string) => {
    setQuery("");
    setCurrentFolder(path);
  };

  const handleGoToParent = () => {
    if (currentFolder()) openFolder(dirname(currentFolder()));
  };

  const isItemTarget = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    return element?.closest("[data-asset-id], [data-folder-path]") != null;
  };

  // A folder that went away (deleted, moved) closes to the nearest one left.
  createEffect(() => {
    const folders = library()?.folders();
    let folder = currentFolder();
    if (!folders || !folder || folders.has(folder)) return;
    while (folder && !folders.has(folder)) folder = dirname(folder);
    setCurrentFolder(folder);
  });

  // A reveal from elsewhere (the canvas menu's Reveal in assets): its folder
  // opens, unfiltered, with its assets selected and the first scrolled to.
  createEffect(() => {
    const request = revealRequest();
    if (!request) return;
    clearRevealRequest();

    untrack(() => {
      setQuery("");
      setAssetFilter("ALL");
      setCurrentFolder(request.folder);
      const keys = request.ids.map(assetKey);
      setSelection(keys);
      anchor = keys[0] ?? null;
      lead = keys.at(-1) ?? null;
      base = new Set();
      root?.focus();
      requestAnimationFrame(() => keys[0] && scrollToItem(keys[0]));
    });
  });

  const withLibrary = (run: (library: AssetLibrary) => void | Promise<void>) => {
    const lib = library();
    if (!lib) {
      toast("No project open", { description: "Open a project to manage its assets." });
      return;
    }
    return run(lib);
  };

  const handleImportAssets = () => withLibrary(async (lib) => selectImported(await pickAndImport(lib, currentFolder())));

  /** Media copied in another app, into the folder in view: from the menu. */
  const handlePaste = () => withLibrary(async (lib) => {
    selectImported(await importClipboard(lib, await readClipboardMedia(), currentFolder()));
  });

  /**
   * ⌘V with the panel in focus. Without media copied in another app, the
   * paste goes on to the stage, as it would with the panel out of focus.
   */
  const handlePasteEvent = (event: ClipboardEvent) => {
    if (isInputTarget(event)) return;
    const media = pastedMedia(event);
    const lib = library();
    if (!hasMedia(media) || !lib) return;
    event.preventDefault();
    event.stopPropagation();
    importClipboard(lib, media, currentFolder()).then(selectImported);
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter = 0;
    setIsDragging(false);

    document.body.style.cursor = "default";

    const lib = library();
    if (!lib) return;
    if (handleFolderDrop(lib, event, currentFolder())) return;
    selectImported(await importFiles(lib, droppedFiles(event), currentFolder()));
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const isExternalFileDrag = (event: DragEvent) => {
    const types = event.dataTransfer?.types ?? [];
    return (
      types.includes("Files") &&
      !types.includes(ASSET_DRAG_TYPE) &&
      !types.includes(FOLDER_DRAG_TYPE)
    );
  };

  const handleDragEnter = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isExternalFileDrag(event)) return;
    dragCounter++;
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isExternalFileDrag(event)) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setIsDragging(false);
    }
  };


  /** Moves the lead an item over, or a row up or down, as Finder's icon view does. */
  const moveSelection = (arrow: string, extend: boolean) => {
    const keys = visibleKeys();
    if (keys.length === 0) return;

    const columns = 2;
    const count = keys.length;
    const current = lead === null ? -1 : keys.indexOf(lead);

    let index: number;
    if (current < 0) {
      index = 0;
    } else {
      if (arrow === "ArrowLeft") index = current - 1;
      else if (arrow === "ArrowRight") index = current + 1;
      else if (arrow === "ArrowUp") index = current - columns;
      // Down from a row above a short last row lands on its last item.
      else if (current + columns < count) index = current + columns;
      else if (Math.floor(current / columns) < Math.floor((count - 1) / columns)) index = count - 1;
      else return;

      if (index < 0 || index >= count) return;
    }

    const key = keys[index];
    if (extend && anchor !== null) selectRangeTo(key);
    else selectOnly(key);
    scrollToItem(key);
  };

  /**
   * Finder's keys for the grid: arrows move the selection and Shift-arrows
   * grow it, ⌘A selects every item in view and ⌥⌘A or Escape none, ⌘↓ opens
   * the selected folder and ⌘↑ goes up, ⌫ deletes the selection, , inserts it
   * at the playhead and ⇧, at the start of the timeline. Handled keys stop
   * here, so the canvas does not act on them too.
   */
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable
    ) {
      return;
    }

    const command = event.metaKey || event.ctrlKey;

    if (event.key === "Backspace" || event.key === "Delete") {
      if (selectedKeys().size > 0) {
        event.preventDefault();
        event.stopPropagation();
        void deleteSelection();
        return;
      }

      if (currentFolder()) {
        event.preventDefault();
        handleGoToParent();
      }

      return;
    }

    // By code: ⇧ turns the comma of ⇧, into another character.
    if (!command && !event.altKey && event.code === "Comma") {
      if (assetSelection.ids().length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) insertSelectionAtStart();
      else insertSelectionAtPlayhead();
      return;
    }

    // By code: ⌥ turns the A of ⌥⌘A into another character on a Mac.
    if (command && event.code === "KeyA") {
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey) clearSelection();
      else selectAll();
      return;
    }

    if (event.key === "Escape" && selectedKeys().size > 0) {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      return;
    }

    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    event.stopPropagation();

    if (command && event.key === "ArrowDown") {
      const folders = assetSelection.folders();
      if (folders.length === 1 && assetSelection.ids().length === 0) openFolder(folders[0]);
    } else if (command && event.key === "ArrowUp") {
      handleGoToParent();
    } else if (!command && !event.altKey) {
      moveSelection(event.key, event.shiftKey);
    }
  };

  const handleBackgroundClick = (event: MouseEvent) => {
    if (!isItemTarget(event.target)) clearSelection();
  };

  const hasAssets = () => allAssets().length > 0;
  const hasContent = () => hasAssets() || allFolders().length > 0;
  const isFiltering = () => query().trim().length > 0 || assetFilter() !== "ALL";
  const isEmptyView = () => visibleFolders().length === 0 && filteredAssets().length === 0;

  const handleCreateFolder = () => withLibrary((lib) => {
    const parent = currentFolder();
    const name = lib.uniqueFolderName(parent, "New folder");
    const folder = lib.createFolder(parent ? `${parent}/${name}` : name);
    createdFolder = folder;
    setRenamingFolder(folder);
  });

  const handleRenameEnd = () => {
    createdFolder = null;
    setRenamingFolder(null);
  };

  // The open menu traps focus, so "Create folder" cannot focus the new folder's
  // name field; focus it once the menu is gone, instead of the panel.
  const handleMenuCloseAutoFocus = (event: Event) => {
    const folder = renamingFolder();
    if (!folder) return;
    event.preventDefault();
    const input = itemElement(folderKey(folder))?.querySelector("input");
    input?.focus();
    input?.select();
  };

  // Escape while naming a folder just created takes the folder back.
  const handleRenameCancel = async (folder: string) => {
    const created = createdFolder === folder;
    handleRenameEnd();
    const lib = library();
    if (!created || !lib) return;
    try {
      await lib.deleteFolder(folder);
    } catch (e) {
      toast.error("Failed to delete", { description: (e as Error).message });
    }
  };

  /**
   * The panel's own keys, the ones its menu advertises. These commands are the
   * library's rather than the stage's, so they are bound here and not in the
   * engine's shortcut table, and they act on the folder the panel is showing —
   * the same folder the buttons import into.
   */
  const handleShortcut = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || isInputTarget(event)) return;
    const key = event.key.toLowerCase();

    if (key === "i" && !event.shiftKey) {
      event.preventDefault();
      void handleImportAssets();
      return;
    }

    if (key === "n" && event.shiftKey) {
      event.preventDefault();
      handleCreateFolder();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleShortcut);
    onCleanup(() => window.removeEventListener("keydown", handleShortcut));
  });

  // The same two in the palette, into the folder the panel is showing.
  useCommand({
    id: "import-assets",
    title: "Import media",
    group: "Assets",
    icon: "download",
    keywords: ["assets", "files", "upload", "add"],
    shortcut: ["⌘", "I"],
    run: () => void handleImportAssets(),
  });

  useCommand({
    id: "new-folder",
    title: "Create folder",
    group: "Assets",
    icon: "navigation.folder",
    keywords: ["new folder", "directory", "organize"],
    shortcut: ["⇧", "⌘", "N"],
    run: handleCreateFolder,
  });

  return (
    <div
      on:drop={handleDrop}
      on:dragover={handleDragOver}
      on:dragenter={handleDragEnter}
      on:dragleave={handleDragLeave}
      class="relative flex flex-col flex-1 min-h-0 text-foreground text-sm focus:outline-none"
      tabIndex={0}
      ref={root}
      onKeyDown={handleKeyDown}
      on:paste={handlePasteEvent}
    >
      <div class="h-12 shrink-0 flex items-center gap-2 px-4 border-y border-border [[data-platform=win32]_&]:border-t-0">
        <div class="flex-1 min-w-0 flex items-center">
          <SidebarTabs />
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <Show when={hasAssets()}>
            <DropdownMenu placement="bottom-start">
              <Tooltip>
                <TooltipTrigger<typeof DropdownMenuTrigger>
                  as={(triggerProps: object) => (
                    <DropdownMenuTrigger<typeof Button>
                      {...triggerProps}
                      as={(buttonProps) => (
                        <Button
                          {...buttonProps}
                          size="icon"
                          variant="ghost"
                          class="text-muted-foreground data-expanded:bg-accent data-expanded:text-foreground"
                        >
                          <Icon name="preferences-adjust" />
                        </Button>
                      )}
                    />
                  )}
                />
                <TooltipContent>Filter assets</TooltipContent>
              </Tooltip>
              <DropdownMenuPortal>
                <DropdownMenuContent class="w-36">
                  <For each={ASSET_FILTER_OPTIONS}>
                    {(option) => (
                      <DropdownMenuItem
                        tone="neutral"
                        class="gap-1 px-0 pr-2"
                        onSelect={() => setAssetFilter(option.value)}
                      >
                        <FilterIconStack
                          icon={option.icon}
                          selected={assetFilter() === option.value}
                        />
                        <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                          {option.label}
                        </span>
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </Show>
          <Tooltip>
            <TooltipTrigger
              as={Button}
              size="icon"
              variant="ghost"
              aria-label="Import assets"
              class="text-muted-foreground"
              onClick={handleImportAssets}
            >
              <Icon name="plus-add" />
            </TooltipTrigger>
            <TooltipContent shortcut="⌘I">Import assets</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Show when={hasContent() && !isDragging()}>
        <div class="shrink-0 px-4 pt-4 pb-1 flex flex-col gap-4">
          <Show when={currentFolder() !== ""}>
            <Breadcrumbs separator="/">
              <BreadcrumbList class="text-xs gap-1 sm:gap-1">
                <BreadcrumbCrumb label="All assets" folder="" onOpen={openFolder} />
                <Show when={collapsedFolders().length > 0}>
                  <BreadcrumbsSeparator />
                  <BreadcrumbsItem>
                    <DropdownMenu placement="bottom-start">
                      <DropdownMenuTrigger class="flex items-center gap-1 rounded outline-none focus-ring hover:text-foreground">
                        <BreadcrumbsEllipsis class="size-4" />
                        <span class="sr-only">Show parent folders</span>
                      </DropdownMenuTrigger>
                      <DropdownMenuPortal>
                        <DropdownMenuContent class="w-40">
                          <For each={collapsedFolders()}>
                            {(folder) => (
                              <DropdownMenuItem
                                tone="neutral"
                                onSelect={() => openFolder(folder)}
                              >
                                <span class="truncate">{basename(folder)}</span>
                              </DropdownMenuItem>
                            )}
                          </For>
                        </DropdownMenuContent>
                      </DropdownMenuPortal>
                    </DropdownMenu>
                  </BreadcrumbsItem>
                </Show>
                <For each={tailFolders()}>
                  {(folder) => (
                    <>
                      <BreadcrumbsSeparator />
                      <BreadcrumbCrumb
                        label={basename(folder)}
                        folder={folder}
                        current={folder === currentFolder()}
                        onOpen={openFolder}
                      />
                    </>
                  )}
                </For>
              </BreadcrumbList>
            </Breadcrumbs>
          </Show>
          <div class="relative">
            <div class="absolute left-1 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
              <Icon name="search" />
            </div>
            <input
              type="text"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={`Search in ${itemCount()} ${itemCount() === 1 ? "item" : "items"}`}
              class="w-full h-7 rounded-md bg-input pl-8 pr-0 text-xs text-foreground placeholder:text-muted-foreground outline-none focus-ring"
            />
          </div>
          <Show when={activeFilterLabel()} keyed>
            {(label) => (
              <div class="flex flex-wrap gap-2">
                <FilterBadge
                  label={label}
                  onRemove={() => setAssetFilter("ALL")}
                />
              </div>
            )}
          </Show>
        </div>
      </Show>

      <div class="relative flex-1 min-h-0 flex flex-col">
        <Show when={isDragging()}>
          <div class="absolute inset-x-2 bottom-2 top-0 z-50 p-2 bg-background rounded-xl border border-ring">
            <div class="absolute inset-0 bg-accent/20 rounded-xl" />
            <div class="size-full flex items-center justify-center rounded-md border border-dashed border-border-input">
              <Icon name="plus-add" class="text-muted-foreground" />
              <span class="text-xxs font-450 text-muted-foreground">Drop media here</span>
            </div>
          </div>
        </Show>
        {/* The grid's own items open their own menus and stop the event,
            so this one only answers a right-click on empty space. */}
        <ContextMenu>
          <ContextMenuTrigger
            as="div"
            ref={scroller}
            class="flex-1 min-h-0 overflow-y-auto p-4 pt-3"
            onClick={handleBackgroundClick}
          >
            <Show when={isEmptyView() && !isFiltering()}>
              <div class="h-full flex flex-col items-center justify-center gap-4 px-6 pb-[88px] pt-4">
                <div class="flex flex-col items-center gap-1">
                  <Icon name="navigation.folder" class="size-8 text-muted-foreground" />
                  <span class="text-xs font-450 text-muted-foreground">
                    Add media
                  </span>
                  <p class="text-xxs text-muted-foreground text-center">
                    {LOCAL_MODE
                      ? "Drag files here or import from your computer."
                      : "Drag here, import from your computer, or generate something new with AI."}
                  </p>
                </div>
                <div class="flex flex-col gap-2 w-full">
                  <Show when={!LOCAL_MODE}>
                    <Button variant="secondary" class="w-full" onClick={() => openPromptInput(restoreConfig("IMAGE"))}>
                      Generate with AI
                    </Button>
                  </Show>
                  <Button variant="default" class="w-full" onClick={handleImportAssets}>
                    Import media
                  </Button>
                </div>
              </div>
            </Show>
            <Show when={isEmptyView() && isFiltering()}>
              <div class="h-full flex items-center justify-center text-xs text-muted-foreground">
                No matching assets
              </div>
            </Show>
            <Show when={!isEmptyView()}>
              <div class="grid grid-cols-2 gap-x-2 gap-y-4">
                <For each={visibleFolders()}>
                  {(folder) => (
                    <FolderItem
                      path={folder}
                      renaming={renamingFolder() === folder}
                      selected={selectedKeys().has(folderKey(folder))}
                      multiple={selectedKeys().size > 1 && selectedKeys().has(folderKey(folder))}
                      onSelect={(event) => handleItemClick(folderKey(folder), event)}
                      onContextSelect={() => handleItemContextMenu(folderKey(folder))}
                      onDragStart={(event) => handleItemDragStart(folderKey(folder), event)}
                      onRenameStart={() => setRenamingFolder(folder)}
                      onRenameEnd={handleRenameEnd}
                      onRenameCancel={() => void handleRenameCancel(folder)}
                      onOpen={() => openFolder(folder)}
                      onDelete={deleteSelection}
                    />
                  )}
                </For>
                <For each={filteredAssets()}>
                  {(asset) => (
                    <LazyAssetItem
                      asset={asset}
                      selected={selectedKeys().has(assetKey(asset.id))}
                      multiple={selectedKeys().size > 1 && selectedKeys().has(assetKey(asset.id))}
                      onSelect={(event) => handleItemClick(assetKey(asset.id), event)}
                      onContextSelect={() => handleItemContextMenu(assetKey(asset.id))}
                      onDragStart={(event) => handleItemDragStart(assetKey(asset.id), event)}
                      onInsertAtStart={insertSelectionAtStart}
                      onInsertAtPlayhead={insertSelectionAtPlayhead}
                      folders={allFolders()}
                      onMove={moveSelectionTo}
                      onDelete={deleteSelection}
                    />
                  )}
                </For>
              </div>
            </Show>
          </ContextMenuTrigger>
          <ContextMenuPortal>
            <ContextMenuContent class="w-52" onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <ContextMenuItem onSelect={handleImportAssets}>
                Import assets
                <ContextMenuShortcut>⌘I</ContextMenuShortcut>
              </ContextMenuItem>
              <Show when={!LOCAL_MODE}>
                <ContextMenuItem onSelect={() => openPromptInput(restoreConfig("IMAGE"))}>
                  Generate with AI
                </ContextMenuItem>
              </Show>
              <ContextMenuItem disabled={!clipboardHasMedia()} onSelect={handlePaste}>
                Paste
                <ContextMenuShortcut>⌘V</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={handleCreateFolder}>
                Create folder
                <ContextMenuShortcut>⇧⌘N</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={visibleKeys().length === 0} onSelect={selectAll}>
                Select all
                <ContextMenuShortcut>⌘A</ContextMenuShortcut>
              </ContextMenuItem>
              <Show when={currentFolder() !== ""}>
                <ContextMenuItem onSelect={handleGoToParent}>
                  Go to parent folder
                  <ContextMenuShortcut>⌘↑</ContextMenuShortcut>
                </ContextMenuItem>
              </Show>
            </ContextMenuContent>
          </ContextMenuPortal>
        </ContextMenu>
      </div>
    </div>
  );
}

type AssetFilter = "ALL" | "VIDEO" | "IMAGE" | "AUDIO" | "TRANSCRIPT";

const ASSET_FILTER_OPTIONS: ReadonlyArray<{
  value: AssetFilter;
  label: string;
  icon: string;
}> = [
    { value: "ALL", label: "All", icon: "all-media-types" },
    { value: "VIDEO", label: "Video", icon: "video" },
    { value: "IMAGE", label: "Image", icon: "media-image" },
    { value: "AUDIO", label: "Audio", icon: "media-audio" },
    { value: "TRANSCRIPT", label: "Captions", icon: "captions-small" },
  ];

type FilterIconStackProps = {
  icon: string;
  selected: boolean;
};

function FilterIconStack(props: FilterIconStackProps) {
  return (
    <div class="flex items-center">
      <span class="w-6 h-7 shrink-0 flex items-center justify-center">
        <Show when={props.selected}>
          <Icon name="confirm-check" class="text-popover-foreground" />
        </Show>
      </span>
      <span class="w-7 h-7 flex items-center justify-center">
        <Icon name={props.icon} class="text-popover-foreground" />
      </span>
    </div>
  );
}

type BreadcrumbCrumbProps = {
  label: string;
  folder: string;
  current?: boolean;
  onOpen(folder: string): void;
};

/**
 * One segment of the folder path. Clicking navigates there; assets and
 * folders can be dropped on it to move them to that level.
 */
function BreadcrumbCrumb(props: BreadcrumbCrumbProps) {
  const [isDropTarget, setIsDropTarget] = createSignal(false);
  const library = useLibrary();

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
    handleFolderDrop(library(), event, props.folder);
  };

  return (
    <BreadcrumbsItem>
      <BreadcrumbsLink
        as="button"
        current={props.current}
        data-drop-target={isDropTarget()}
        class="max-w-32 truncate rounded px-1 outline-none focus-ring data-[current]:text-muted-foreground hover:text-foreground data-[drop-target=true]:ring-2 data-[drop-target=true]:ring-inset data-[drop-target=true]:ring-ring"
        onClick={() => props.onOpen(props.folder)}
        on:dragover={handleDragOver}
        on:dragleave={() => setIsDropTarget(false)}
        on:drop={handleDrop}
      >
        {props.label}
      </BreadcrumbsLink>
    </BreadcrumbsItem>
  );
}

type FilterBadgeProps = {
  label: string;
  onRemove: () => void;
};

function FilterBadge(props: FilterBadgeProps) {
  return (
    <button
      class="h-5 rounded bg-input pl-1 pr-0 inline-flex items-center gap-1 text-xxs text-foreground outline-none focus-ring"
      onClick={props.onRemove}
    >
      <span>{props.label}</span>
      <span class="relative w-4 h-5 flex items-center justify-center overflow-hidden">
        <Icon name="close-remove-small" class="absolute -left-1 -top-0.5" />
      </span>
    </button>
  );
}
