/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import { toast } from "somoto";
import type { ChatSummary } from "@diffusionstudio/agent-chat";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuPortal,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import type { ProjectInfo } from "@/projects";
import {
  activeChatId, chatState, createChatFolder, deleteChat, deleteChatFolder, moveChatToFolder,
  refreshChatFolders, refreshDeletedChats, renameChat, renameChatFolder, restoreChat,
} from "./store";

export type SidebarConversation = { chat: ChatSummary; project: ProjectInfo };
type NameAction =
  | { kind: "chat"; chat: ChatSummary }
  | { kind: "folder"; id: string; name: string }
  | { kind: "create"; chat?: ChatSummary };

/** Shared menu target for mouse, a two-finger click, the menu key, and the visible more button. */
function RowMenu(props: { children: JSX.Element; label: string; menu: JSX.Element; onClosing?(): boolean }) {
  let trigger!: HTMLDivElement;
  const openMenu = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = trigger.getBoundingClientRect();
    trigger.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: rect.right - 20, clientY: rect.bottom,
    }));
  };
  return <ContextMenu modal={false}>
    <ContextMenuTrigger as="div" ref={trigger} class="cutroom-chat-row-shell" onKeyDown={(event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openMenu(event);
    }}>
      {props.children}
      <button type="button" class="cutroom-chat-more" aria-label={`Options for ${props.label}`} title="Chat options" onClick={openMenu}>
        <Icon name="more-three-dots" class="size-4" />
      </button>
    </ContextMenuTrigger>
    <ContextMenuPortal><ContextMenuContent class="w-56 gap-0" onCloseAutoFocus={(event) => {
      // Naming dialogs take focus after the menu closes.
      if (props.onClosing?.()) event.preventDefault();
    }}>{props.menu}</ContextMenuContent></ContextMenuPortal>
  </ContextMenu>;
}

/** Folders organize conversations only. Their video project and agent working directory never change. */
export function SidebarHistory(props: {
  chats: SidebarConversation[];
  projects: ProjectInfo[];
  projectId?: string;
  onOpen(project: ProjectInfo, chatId: string): void;
  onNew(): void;
}) {
  const [naming, setNaming] = createSignal<NameAction>();
  const [name, setName] = createSignal("");
  const [nameError, setNameError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [pending, setPending] = createSignal<string[]>([]);
  const [collapsed, setCollapsed] = createSignal<string[]>([]);
  const [showDeleted, setShowDeleted] = createSignal(false);
  const [deletedLoading, setDeletedLoading] = createSignal(false);
  const [deletedError, setDeletedError] = createSignal("");
  let nameInput: HTMLInputElement | undefined;
  let deletedRequest = 0;

  const organizationReady = () => chatState.foldersLoaded && !chatState.foldersError;
  const folders = createMemo(() => [...chatState.folders.folders].sort((a, b) => a.name.localeCompare(b.name)));
  const folderFor = (id: string) => {
    const assigned = chatState.folders.assignments[id];
    return folders().some((folder) => folder.id === assigned) ? assigned : undefined;
  };
  const unfiled = createMemo(() => props.chats.filter(({ chat }) => !folderFor(chat.id)));
  const deleted = createMemo(() => {
    const projects = new Map(props.projects.map((project) => [project.id, project]));
    return Object.values(chatState.deletedLists).flat()
      .filter((chat) => projects.has(chat.projectId))
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .map((chat) => ({ chat, project: projects.get(chat.projectId)! }));
  });

  createEffect(() => {
    if (chatState.connection === "open") void refreshChatFolders().catch(() => {});
  });
  const loadDeleted = async () => {
    const request = ++deletedRequest;
    setDeletedLoading(true); setDeletedError("");
    try { await Promise.all(props.projects.map((project) => refreshDeletedChats(project.id))); }
    catch (error) { if (request === deletedRequest) setDeletedError((error as Error).message); }
    finally { if (request === deletedRequest) setDeletedLoading(false); }
  };
  const toggleDeleted = () => {
    setShowDeleted((current) => !current);
    if (showDeleted()) void loadDeleted();
  };
  const run = async (id: string, action: () => Promise<unknown>, failure: string) => {
    if (pending().includes(id)) return;
    setPending((ids) => [...ids, id]);
    try { await action(); }
    catch (error) { toast.error(failure, { description: (error as Error).message }); }
    finally { setPending((ids) => ids.filter((value) => value !== id)); }
  };
  const askName = (action: NameAction) => {
    setName(action.kind === "chat" ? action.chat.title : action.kind === "folder" ? action.name : "");
    setNameError(""); setNaming(action);
  };
  const saveName = async (event: SubmitEvent) => {
    event.preventDefault();
    const action = naming(), value = name().trim();
    if (!action || saving()) return;
    if (!value) { setNameError("Enter a name."); return; }
    setSaving(true); setNameError("");
    try {
      if (action.kind === "chat") await renameChat(action.chat.id, value);
      else if (action.kind === "folder") await renameChatFolder(action.id, value);
      else await createChatFolder(value, action.chat?.id);
      setNaming(undefined);
    } catch (error) { setNameError((error as Error).message); }
    finally { setSaving(false); }
  };
  const remove = (chat: ChatSummary) => void run(chat.id, async () => {
    await deleteChat(chat.projectId, chat.id);
    toast.success("Chat moved to Recently deleted", {
      duration: 8000,
      action: { label: "Undo", onClick: () => void run(chat.id, () => restoreChat(chat.id), "Could not restore chat") },
    });
  }, "Could not delete chat");
  const move = (chat: ChatSummary, folderId: string | null) => void run(chat.id, async () => {
    await moveChatToFolder(chat.id, folderId);
    if (folderId) setCollapsed((ids) => ids.filter((id) => id !== folderId));
  }, "Could not move chat");

  const conversation = (id: string, inTrash = false) => {
    const initial = (inTrash ? deleted() : props.chats).find(({ chat }) => chat.id === id)!;
    const entry = () => (inTrash ? deleted() : props.chats).find(({ chat }) => chat.id === id) ?? initial;
    const busy = () => pending().includes(entry().chat.id);
    const editing = () => entry().chat.status !== "idle";
    return <RowMenu label={entry().chat.title} onClosing={() => !!naming()} menu={<>
      <Show when={inTrash} fallback={<>
        <ContextMenuItem onSelect={() => props.onOpen(entry().project, entry().chat.id)}>Open chat</ContextMenuItem>
        <ContextMenuItem disabled={busy() || editing()} onSelect={() => askName({ kind: "chat", chat: entry().chat })}>Rename…</ContextMenuItem>
        <ContextMenuSub><ContextMenuSubTrigger disabled={busy() || !organizationReady()}>Move to folder</ContextMenuSubTrigger>
          <ContextMenuPortal><ContextMenuSubContent class="w-56 gap-0">
            <For each={folders()}>{(folder) => <ContextMenuItem disabled={folderFor(entry().chat.id) === folder.id} onSelect={() => move(entry().chat, folder.id)}>
              <Icon name="navigation.folder" /><span class="min-w-0 flex-1 truncate">{folder.name}</span>
              <Show when={folderFor(entry().chat.id) === folder.id}><Icon name="confirm-check" /></Show>
            </ContextMenuItem>}</For>
            <Show when={folders().length > 0}><ContextMenuSeparator /></Show>
            <ContextMenuItem onSelect={() => askName({ kind: "create", chat: entry().chat })}><Icon name="plus-add" />New folder…</ContextMenuItem>
          </ContextMenuSubContent></ContextMenuPortal>
        </ContextMenuSub>
        <Show when={folderFor(entry().chat.id)}><ContextMenuItem disabled={busy() || !organizationReady()} onSelect={() => move(entry().chat, null)}>Remove from folder</ContextMenuItem></Show>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={busy() || editing()} onSelect={() => remove(entry().chat)}><Icon name="trash" />Delete chat</ContextMenuItem>
        <Show when={editing()}><p class="px-2 py-1 text-[10px] text-muted-foreground">Rename or delete after the current edit ends.</p></Show>
      </>}>
        <ContextMenuItem disabled={busy()} onSelect={() => void run(entry().chat.id, () => restoreChat(entry().chat.id), "Could not restore chat")}><Icon name="undo" />Restore chat</ContextMenuItem>
      </Show>
      <ContextMenuSeparator />
      <p class="truncate px-2 py-1 text-[10px] text-muted-foreground" title={entry().project.displayName}>{entry().project.displayName}</p>
    </>}>
      <button type="button" class="cutroom-chat-row" title={entry().chat.title}
        classList={{ "is-active": !inTrash && props.projectId === entry().project.id && activeChatId(entry().project.id) === entry().chat.id }}
        disabled={inTrash} onClick={() => props.onOpen(entry().project, entry().chat.id)}>
        <span>{entry().chat.title}</span>
        <Show when={entry().chat.status === "running"}><Icon name="spinner-loader" class="size-3.5 shrink-0 animate-spin text-muted-foreground" /></Show>
        <Show when={entry().chat.status === "waiting"}><span class="cutroom-unread-dot" title="Waiting for your reply" /></Show>
      </button>
    </RowMenu>;
  };

  return <>
    <div class="cutroom-chats-heading">
      <span>{showDeleted() ? "Recently deleted" : "Chats"}</span>
      <div class="flex items-center gap-1">
        <Show when={!showDeleted()}>
          <button type="button" aria-label="New chat folder" title="New folder" disabled={!organizationReady()} onClick={() => askName({ kind: "create" })}><Icon name="navigation.folder" class="size-4" /></button>
          <button type="button" aria-label="New conversation" title="New conversation" onClick={props.onNew}><Icon name="plus-add" /></button>
        </Show>
        <Show when={showDeleted()}><button type="button" aria-label="Back to chats" title="Back to chats" onClick={toggleDeleted}><Icon name="arrow-left" class="size-4" /></button></Show>
      </div>
    </div>
    <div class="cutroom-chat-history">
      <Show when={showDeleted()} fallback={<>
        <Show when={chatState.foldersError}><div role="alert" class="px-2 py-2 text-xs text-destructive">Could not load chat folders.<button class="block underline" onClick={() => void refreshChatFolders().catch(() => {})}>Try again</button></div></Show>
        <For each={folders()}>{(folder) => {
          const entries = () => props.chats.filter(({ chat }) => folderFor(chat.id) === folder.id);
          const expanded = () => !collapsed().includes(folder.id);
          return <section class="cutroom-chat-folder" aria-label={`Chat folder ${folder.name}`}>
            <RowMenu label={folder.name} onClosing={() => !!naming()} menu={<>
              <ContextMenuItem disabled={pending().includes(folder.id)} onSelect={() => askName({ kind: "folder", id: folder.id, name: folder.name })}>Rename folder…</ContextMenuItem>
              <ContextMenuItem disabled={pending().includes(folder.id)} onSelect={() => void run(folder.id, async () => {
                await deleteChatFolder(folder.id);
                toast.success("Folder removed. Your chats are still in Chats.");
              }, "Could not remove folder")}>Remove folder</ContextMenuItem>
            </>}>
              <button type="button" class="cutroom-chat-row cutroom-chat-folder-toggle" aria-expanded={expanded()} onClick={() => setCollapsed((ids) => expanded() ? [...ids, folder.id] : ids.filter((id) => id !== folder.id))}>
                <Icon name={expanded() ? "chevron-down" : "chevron-right"} class="size-3" /><Icon name="navigation.folder" class="size-4" />
                <span class="min-w-0 flex-1 truncate">{folder.name}</span><span class="cutroom-chat-count">{entries().length}</span>
              </button>
            </RowMenu>
            <Show when={expanded()}><div class="cutroom-chat-folder-contents">
              <For each={entries().map(({ chat }) => chat.id)} fallback={<p class="cutroom-folder-empty">Move a chat here using its menu.</p>}>{(entry) => conversation(entry)}</For>
            </div></Show>
          </section>;
        }}</For>
        <Show when={folders().length && unfiled().length}><p class="cutroom-chat-section-label">Other chats</p></Show>
        <For each={unfiled().map(({ chat }) => chat.id)}>{(entry) => conversation(entry)}</For>
        <Show when={!props.chats.length && !folders().length}><p class="cutroom-chat-empty">Your conversations will appear here.</p></Show>
      </>}>
        <Show when={deletedError()}><div class="px-2 py-2 text-xs text-destructive" role="alert">{deletedError()}<button class="block underline" onClick={() => void loadDeleted()}>Try again</button></div></Show>
        <Show when={!deletedLoading()} fallback={<p class="cutroom-chat-empty">Loading chats…</p>}>
          <For each={deleted().map(({ chat }) => chat.id)} fallback={<p class="cutroom-chat-empty">No deleted chats.</p>}>{(entry) => conversation(entry, true)}</For>
          <Show when={deleted().length > 0}><p class="cutroom-chat-empty">Use a chat’s menu to restore it.</p></Show>
        </Show>
      </Show>
    </div>
    <Show when={!showDeleted()}><button type="button" class="cutroom-chat-trash" onClick={toggleDeleted}><Icon name="trash" class="size-3.5" />Recently deleted</button></Show>
    <Dialog open={!!naming()} onOpenChange={(open) => { if (!open && !saving()) setNaming(undefined); }}>
      <DialogPortal><DialogContent class="sm:max-w-sm" showCloseButton={!saving()} onOpenAutoFocus={(event) => {
        event.preventDefault(); queueMicrotask(() => { nameInput?.focus(); nameInput?.select(); });
      }}>
        <form onSubmit={saveName} class="flex flex-col gap-4">
          <DialogHeader><DialogTitle>{naming()?.kind === "chat" ? "Rename chat" : naming()?.kind === "folder" ? "Rename folder" : "New chat folder"}</DialogTitle>
            <DialogDescription>{naming()?.kind === "chat" ? "Give this conversation a name you can find later." : "Keep related conversations together."}</DialogDescription>
          </DialogHeader>
          <label class="space-y-1 text-xs">Name<input ref={nameInput} aria-label={naming()?.kind === "chat" ? "Chat name" : "Folder name"} value={name()} disabled={saving()}
            maxLength={naming()?.kind === "chat" ? 160 : 100} onInput={(event) => setName(event.currentTarget.value)}
            class="mt-1 block h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
          <Show when={nameError()}><p role="alert" class="text-xs text-destructive">{nameError()}</p></Show>
          <DialogFooter><Button type="button" variant="secondary" disabled={saving()} onClick={() => setNaming(undefined)}>Cancel</Button><Button type="submit" disabled={saving() || !name().trim()}>{saving() ? "Saving…" : naming()?.kind === "create" ? "Create folder" : "Save"}</Button></DialogFooter>
        </form>
      </DialogContent></DialogPortal>
    </Dialog>
  </>;
}
