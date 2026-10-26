/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createSignal } from "solid-js";
import { toast } from "somoto";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { TextField, TextFieldInput } from "@/components/ui/text-field";
import {
  createCollection,
  deleteCollection,
  renameCollection,
  type CollectionRecord,
} from "@/projects";

import { DashboardSidebarItem } from "./sidebar";

type DashboardSidebarCollectionsProps = {
  collections: CollectionRecord[];
  /** The collection the projects view lists, if it lists one. */
  activeId: string | null;
  onOpen(collection: CollectionRecord): void;
};

/**
 * The collections in the sidebar, each opening the projects filed in it, and
 * the row that adds one. A collection's menu renames it in place or deletes
 * it; deleting one keeps its projects, at the top level.
 */
export function DashboardSidebarCollections(props: DashboardSidebarCollectionsProps) {
  const [adding, setAdding] = createSignal(false);

  // A folder just named is opened, ready to fill.
  const handleAdd = async (name: string) => {
    setAdding(false);
    try {
      const collection = await createCollection(name);
      props.onOpen(collection);
    } catch (e) {
      toast.error("Failed to add folder", { description: (e as Error).message });
    }
  };

  return (
    <>
      <For each={props.collections}>
        {(collection) => (
          <CollectionItem
            collection={collection}
            active={props.activeId === collection.id}
            onOpen={() => props.onOpen(collection)}
          />
        )}
      </For>
      <Show
        when={adding()}
        fallback={<DashboardSidebarItem icon="plus-add" label="Add folder..." onClick={() => setAdding(true)} />}
      >
        <SidebarNameField
          icon="navigation.folder"
          value="Untitled Folder"
          placeholder="Folder name"
          onCommit={handleAdd}
          onCancel={() => setAdding(false)}
        />
      </Show>
    </>
  );
}

type CollectionItemProps = {
  collection: CollectionRecord;
  active: boolean;
  onOpen(): void;
};

function CollectionItem(props: CollectionItemProps) {
  const [renaming, setRenaming] = createSignal(false);

  const handleRename = async (name: string) => {
    setRenaming(false);
    if (name === props.collection.name) return;
    try {
      await renameCollection(props.collection, name);
    } catch (e) {
      toast.error("Failed to rename folder", { description: (e as Error).message });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteCollection(props.collection.id);
    } catch (e) {
      toast.error("Failed to delete folder", { description: (e as Error).message });
    }
  };

  return (
    <Show
      when={!renaming()}
      fallback={
        <SidebarNameField
          icon="navigation.folder"
          value={props.collection.name}
          placeholder="Folder name"
          onCommit={handleRename}
          onCancel={() => setRenaming(false)}
        />
      }
    >
      <ContextMenu modal={false}>
        <ContextMenuTrigger as="div" class="contents">
          <DashboardSidebarItem
            icon="navigation.folder"
            label={props.collection.name}
            active={props.active}
            onClick={props.onOpen}
          />
        </ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent class="w-45 gap-0">
            <ContextMenuItem onSelect={() => setRenaming(true)}>Rename</ContextMenuItem>
            <ContextMenuItem onSelect={handleDelete}>Delete folder</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenu>
    </Show>
  );
}

type SidebarNameFieldProps = {
  icon: string;
  value: string;
  placeholder: string;
  /** Enter, or focus leaving, with a name typed: the trimmed name. */
  onCommit(name: string): void;
  /** Escape, or focus leaving with nothing typed. */
  onCancel(): void;
};

/** A sidebar row whose label is a field, for naming a collection in place. */
function SidebarNameField(props: SidebarNameFieldProps) {
  // Enter blurs the field on its way out; the blur must not answer again.
  let settled = false;

  const settle = (name: string | null) => {
    if (settled) return;
    settled = true;
    if (name) props.onCommit(name);
    else props.onCancel();
  };

  // A field mounted from a context-menu selection gets its focus taken back
  // by the trigger as the menu closes, so it claims focus after that.
  const handleRef = (el: HTMLInputElement) => {
    queueMicrotask(() => {
      el.focus();
      el.select();
    });
  };

  const handleKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settle(null);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      settle(event.currentTarget.value.trim());
    }
  };

  return (
    <div class="my-0.5 flex h-7 w-full shrink-0 items-center gap-1 rounded-md pl-0 pr-1">
      <span class="grid size-7 shrink-0 place-items-center overflow-clip">
        <Icon name={props.icon} class="text-muted-foreground" />
      </span>
      <TextField class="min-w-0 flex-1">
        <TextFieldInput
          uiSize="compact"
          type="text"
          ref={handleRef}
          value={props.value}
          onKeyDown={handleKeyDown}
          onBlur={(event) => settle(event.currentTarget.value.trim())}
          placeholder={props.placeholder}
          aria-label={props.placeholder}
          class="h-5 w-full border border-ring bg-input px-1 py-0 ring-1 ring-inset ring-ring"
        />
      </TextField>
    </div>
  );
}
