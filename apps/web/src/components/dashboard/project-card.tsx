/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, batch, createResource, createSignal } from "solid-js";
import { toast } from "somoto";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TextField, TextFieldInput } from "@/components/ui/text-field";
import { track } from "@/lib/analytics";
import { listEditors, openInEditor, revealPath, type EditorInfo } from "@/lib/shell";
import {
  duplicateProject,
  isWindowsDesktop,
  listCollections,
  moveProjectsToCollection,
  renameProject,
  type ProjectRecord,
} from "@/projects";

import { DashboardCardButton, DashboardCardPreview, DashboardProjectThumbnail } from "./shared";
import { formatEditedAt } from "./utils";

type DashboardProjectCardProps = {
  project: ProjectRecord;
  /** Whether the card is selected in its grid. */
  active: boolean;
  /** What the menu acts on: the selection the card is in, or the card alone. */
  targets: ProjectRecord[];
  /** A click, with its modifiers, or Space, without, landed on the card. */
  onSelect: (event?: MouseEvent) => void;
  /** A right-click landed on the card. */
  onContextMenu: () => void;
  /** The card was double-clicked, or Open chosen from the menu. */
  onOpen: () => void;
  /** Delete was chosen from the menu, for the targets. */
  onDelete: () => void;
  /** A rename or duplicate changed the projects on disk; the owner refetches its list. */
  onChanged: () => void;
};

/**
 * A project in a dashboard grid: thumbnail, name, and last-edited time, with
 * the context menu that opens it (here, in the file manager, or in a code
 * editor), renames, duplicates, files it in a collection, and deletes it.
 * Rename happens inline, in place of the name, and lives here so every grid
 * that shows projects gets the same menu. With more than one project
 * selected, the menu only duplicates, files, and deletes them all.
 */
export function DashboardProjectCard(props: DashboardProjectCardProps) {
  const [renaming, setRenaming] = createSignal(false);
  const [renameDraft, setRenameDraft] = createSignal("");
  const [editors] = createResource(listEditors, { initialValue: [] });
  const multiple = () => props.targets.length > 1;

  const startRenaming = () => {
    batch(() => {
      setRenameDraft(props.project.displayName);
      setRenaming(true);
    });
  };

  const stopRenaming = () => {
    batch(() => {
      setRenaming(false);
      setRenameDraft("");
    });
  };

  const handleOpen = () => {
    if (renaming()) return;
    props.onOpen();
  };

  const handleReveal = async () => {
    try {
      await revealPath(props.project.dir);
    } catch (e) {
      toast.error("Failed to show the folder", { description: (e as Error).message });
    }
  };

  const handleOpenInEditor = async (editor: EditorInfo) => {
    try {
      await openInEditor(editor.id, props.project.dir);
    } catch (e) {
      toast.error(`Failed to open in ${editor.label}`, { description: (e as Error).message });
    }
  };

  const handleDuplicate = async () => {
    try {
      for (const project of props.targets) {
        await duplicateProject(project.dir);
        track("project_duplicated");
      }
    } catch (e) {
      toast.error("Failed to duplicate project", { description: (e as Error).message });
    } finally {
      props.onChanged();
    }
  };

  const handleRenameInput = (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    setRenameDraft(event.currentTarget.value);
  };

  // The input mounts from a context-menu selection, which restores focus to
  // the trigger on close — so the input must claim focus itself, after that.
  const handleRenameInputRef = (el: HTMLInputElement) => {
    queueMicrotask(() => {
      el.focus();
      el.select();
    });
  };

  const handleBlurRenameInput = () => {
    stopRenaming();
  };

  const handleKeyDownRenameInput = async (event: KeyboardEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    const trimmedName = renameDraft().trim();

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();

      stopRenaming();
      input.blur();
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();

      if (trimmedName.length > 0 && renaming()) {
        try {
          await renameProject(props.project.dir, trimmedName);
          props.onChanged();
        } catch (e) {
          toast.error("Failed to rename project", { description: (e as Error).message });
        }
      }

      stopRenaming();
      input.blur();
    }
  };

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) props.onContextMenu();
      }}
    >
      <ContextMenuTrigger as="div" class="contents">
        <DashboardCardButton
          active={props.active}
          onClick={props.onSelect}
          onDoubleClick={handleOpen}
        >
          <DashboardCardPreview>
            <DashboardProjectThumbnail cover={props.project.cover} />
          </DashboardCardPreview>
          <div class="flex flex-col gap-1 px-2">
            <div class="relative h-4 w-full">
              <Show
                when={renaming()}
                fallback={
                  <p class="min-w-0 truncate text-xs text-foreground">
                    {props.project.displayName}
                  </p>
                }
              >
                <TextField class="contents">
                  <TextFieldInput
                    uiSize="compact"
                    type="text"
                    ref={handleRenameInputRef}
                    value={renameDraft()}
                    onInput={handleRenameInput}
                    onBlur={handleBlurRenameInput}
                    onKeyDown={handleKeyDownRenameInput}
                    placeholder="Project name"
                    aria-label="Project name"
                    class="absolute inset-x-0 top-1/2 h-5 w-full -translate-y-1/2 border border-ring bg-input px-1 py-0 ring-1 ring-inset ring-ring"
                  />
                </TextField>
              </Show>
            </div>
            <p class="min-w-0 truncate text-xs text-muted-foreground">
              {formatEditedAt(props.project.modifiedAt)}
            </p>
          </div>
        </DashboardCardButton>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent class="w-45 gap-0">
          <Show
            when={!multiple()}
            fallback={
              <>
                <ContextMenuItem onSelect={handleDuplicate}>Duplicate {props.targets.length} projects</ContextMenuItem>
                <MoveToMenu projects={props.targets} />
                <ContextMenuSeparator class="my-2" />
                <ContextMenuItem onSelect={props.onDelete}>Delete {props.targets.length} projects</ContextMenuItem>
              </>
            }
          >
            <ContextMenuItem onSelect={handleOpen}>Open</ContextMenuItem>
            <ContextMenuSeparator class="my-2" />
            <ContextMenuItem onSelect={handleReveal}>
              {isWindowsDesktop() ? "Show in Explorer" : "Show in Finder"}
            </ContextMenuItem>
            <For each={editors()}>
              {(editor) => (
                <ContextMenuItem onSelect={() => handleOpenInEditor(editor)}>Open in {editor.label}</ContextMenuItem>
              )}
            </For>
            <ContextMenuSeparator class="my-2" />
            <ContextMenuItem onSelect={startRenaming}>Rename</ContextMenuItem>
            <ContextMenuItem onSelect={handleDuplicate}>Duplicate</ContextMenuItem>
            <MoveToMenu projects={props.targets} />
            <ContextMenuSeparator class="my-2" />
            <ContextMenuItem onSelect={props.onDelete}>Delete</ContextMenuItem>
          </Show>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  );
}

/**
 * Move to ▸ every collection, checked for the one `projects` are filed in. A
 * project is in one collection at most: checking another moves it there, and
 * unchecking the checked one takes it back to the top level. Mounts with the
 * menu, so the collections are read when it opens.
 */
function MoveToMenu(props: { projects: ProjectRecord[] }) {
  const [collections] = createResource(listCollections, { initialValue: [] });
  // Checked only when every project is in it, so a mixed selection checks none.
  const isIn = (id: string) => props.projects.every((project) => project.collectionId === id);

  const move = async (collectionId: string | undefined) => {
    try {
      await moveProjectsToCollection(props.projects.map((project) => project.dir), collectionId);
    } catch (e) {
      toast.error("Failed to move project", { description: (e as Error).message });
    }
  };

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
      <ContextMenuPortal>
        <ContextMenuSubContent class="w-45 gap-0">
          <For
            each={collections()}
            fallback={<ContextMenuItem disabled>No folders</ContextMenuItem>}
          >
            {(collection) => (
              <ContextMenuCheckboxItem
                checked={isIn(collection.id)}
                onChange={(checked) => move(checked ? collection.id : undefined)}
              >
                <span class="min-w-0 flex-1 truncate">{collection.name}</span>
              </ContextMenuCheckboxItem>
            )}
          </For>
        </ContextMenuSubContent>
      </ContextMenuPortal>
    </ContextMenuSub>
  );
}
