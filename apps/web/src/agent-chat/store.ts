/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The chat state the UI renders, at module level so it outlives any page:
// a Solid store fed by the host's snapshots and events through the shared
// reducer. Deltas are batched per animation frame. Everything the host
// owns (chats, transcripts, questions) is a view here; what is ours alone
// is the draft per chat, which tab is up, and which chat each project shows.

import { batch, createRoot } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { toast } from "somoto";

import {
  AgentChatError,
  emptyTranscript,
  reduce,
  type ChatEvent,
  type ChatSnapshot,
  type ChatSummary,
  type ChatFoldersState,
  type HarnessInfo,
  type Item,
  type ModelRef,
  type RequestResponse,
  type ConnectionState,
} from "@diffusionstudio/agent-chat";
import type { Transcript } from "@diffusionstudio/agent-chat";

import { store as settings } from "@/init";
import { track } from "@/lib/analytics";
import { createStoredSignal } from "@/lib/store";
import { projectRoute } from "@/hooks/use-project-route";
import type { ProjectInfo } from "@/projects";
import { flushProjectEdits } from "@/projects/edits";

import { attachmentFromPath, attachmentPaths, mergeAttachments, type Attachment } from "./attachments";
import { client, hasHost } from "./connection";

export type SidebarTab = "assets" | "chat" | "footage";

export type Draft = { text: string; attachments: Attachment[] };

/** The draft key for a chat that does not exist yet. */
export const draftKey = (projectId: string, chatId: string | null): string => chatId ?? `new:${projectId}`;

type State = {
  connection: ConnectionState;
  harnesses: HarnessInfo[];
  /** Transcripts by chat id, for every chat opened this session. */
  chats: Record<string, Transcript>;
  /** History by project id, newest first. */
  lists: Record<string, ChatSummary[]>;
  /** Recoverable deleted conversations, separate from the normal history. */
  deletedLists: Record<string, ChatSummary[]>;
  folders: ChatFoldersState;
  foldersLoaded: boolean;
  foldersError: string | null;
  drafts: Record<string, Draft>;
  /** The user item shown while `turn.send` is in flight, by draft key. */
  sending: Record<string, Item | null>;
};

const EMPTY_DRAFT: Draft = { text: "", attachments: [] };
const PROBE_MAX_AGE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 4000;

const [state, setState] = createStore<State>({
  connection: "closed",
  harnesses: [],
  chats: {},
  lists: {},
  deletedLists: {},
  folders: { version: 1, revision: 0, folders: [], assignments: {} },
  foldersLoaded: false,
  foldersError: null,
  drafts: {},
  sending: {},
});

export { state as chatState };

// --- settings that persist ---------------------------------------------

const root = createRoot(() => {
  const [tab, setTab] = createStoredSignal(settings.define<SidebarTab>("leftSidebar.tab", "assets"));
  const [model, setModel] = createStoredSignal(settings.define<ModelRef | null>("agentChat.model", null));
  const [active, setActive] = createStoredSignal(settings.define<Record<string, string>>("agentChat.active", {}));
  return { tab, setTab, model, setModel, active, setActive };
});

/** Which tab the left sidebar shows; persists across sessions. */
export const sidebarTab = root.tab;
export const setSidebarTab = root.setTab;

/** The remembered model, whether or not its harness is currently ready. */
export const storedModel = root.model;
export const setStoredModel = root.setModel;

/** Sentinel for "the empty draft chat" in the per-project active map. */
const DRAFT = "";

/** The chat a project's panel shows: the remembered one, else the newest, else a draft (null). */
export function activeChatId(projectId: string): string | null {
  const remembered = root.active()[projectId];
  if (remembered === DRAFT) return null;
  if (remembered) {
    const list = state.lists[projectId];
    const chat = list?.find((entry) => entry.id === remembered) ?? (list === undefined ? state.chats[remembered]?.chat : undefined);
    if (chat?.projectId === projectId && chat.deletedAt === undefined) return remembered;
  }
  return state.lists[projectId]?.find((chat) => chat.deletedAt === undefined)?.id ?? null;
}

export function setActiveChat(projectId: string, chatId: string | null): void {
  root.setActive({ ...root.active(), [projectId]: chatId ?? DRAFT });
}

/** A default selection becomes explicit before history can change its order. */
function preserveActiveChat(projectId: string): void {
  const current = activeChatId(projectId);
  if (current && root.active()[projectId] !== current) setActiveChat(projectId, current);
}

// --- connection ---------------------------------------------------------

let connected = false;
let harnessesAt = 0;

/** Connects once; safe to call from anywhere the chat is about to be used. */
export function ensureConnected(): void {
  if (connected) return;
  connected = true;
  client.onState((connection) => setState("connection", connection));
  client.onHarnesses((harnesses) => {
    harnessesAt = Date.now();
    // Probes return fresh JSON objects even when availability and models did
    // not change. Keep keyed identities so a refresh cannot remount an open
    // model submenu (or its currently focused model item).
    setState("harnesses", reconcile(harnesses, { key: "id" }));
  });
  client.onChatChanged(upsertSummary);
  client.onChatFoldersChanged(applyChatFolders);
  setState("connection", hasHost() ? "connecting" : "unavailable");
  if (hasHost()) client.connect();
}

/** Resolves once the socket is open, or rejects after a short wait. */
function whenOpen(): Promise<void> {
  ensureConnected();
  if (client.state === "open") return Promise.resolve();
  if (!hasHost()) return Promise.reject(new AgentChatError("disconnected", "Chat runs in the desktop app"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new AgentChatError("disconnected", "The agent host is not running"));
    }, CONNECT_TIMEOUT_MS);
    const stop = client.onState((connection) => {
      if (connection !== "open") return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** Re-runs the probes when the cached ones are older than a minute. */
export function refreshHarnesses(force = false): void {
  if (client.state !== "open" || (!force && Date.now() - harnessesAt < PROBE_MAX_AGE_MS)) return;
  harnessesAt = Date.now();
  void client.request("harnesses.list", { refresh: true }).catch(() => {});
}

export const readyHarnesses = (): HarnessInfo[] => state.harnesses.filter((harness) => harness.status === "ready");

/** Families picked before anything is remembered, best first, across every ready harness. */
const PREFERRED_MODELS = [/astra/i, /sol/i, /fable/i, /opus/i];

/**
 * The model the composers send with: the remembered one if its harness is
 * ready, else the best preferred family on offer, else the first ready default.
 */
export function currentModel(): ModelRef | null {
  const ready = readyHarnesses();
  const remembered = root.model();
  if (remembered) {
    const harness = ready.find((entry) => entry.id === remembered.harness);
    if (harness && harness.models.some((model) => model.id === remembered.model)) return remembered;
  }
  for (const pattern of PREFERRED_MODELS) {
    for (const harness of ready) {
      const match = harness.models.find((model) => pattern.test(model.id) || pattern.test(model.label));
      if (match) return { harness: harness.id, model: match.id };
    }
  }
  const first = ready[0];
  if (!first) return null;
  const model = first.defaultModel ?? first.models[0]?.id;
  return model ? { harness: first.id, model } : null;
}

/** The label the pickers show for a model ref. */
export function modelLabel(ref: ModelRef | null): string {
  if (!ref) return "No agent available";
  const harness = state.harnesses.find((entry) => entry.id === ref.harness);
  return harness?.models.find((model) => model.id === ref.model)?.label ?? ref.model;
}

// --- events -------------------------------------------------------------

const queue = new Map<string, ChatEvent[]>();
let flushScheduled = false;
/** Latest host metadata, including tombstones, outlives transcript subscriptions. */
const summaries = new Map<string, ChatSummary>();
const summaryChanges = new Map<string, number>();
const listRequests = new Map<string, number>();
let summaryChange = 0;
/** New chats whose optimistic item waits for the first snapshot, by chat id → draft key. */
const awaitingSnapshot = new Map<string, string>();

function flush(): void {
  flushScheduled = false;
  if (queue.size === 0) return;
  const pending = [...queue];
  queue.clear();
  batch(() => {
    for (const [chatId, events] of pending) {
      if (summaries.get(chatId)?.deletedAt !== undefined) continue;
      let transcript = state.chats[chatId] ?? emptyTranscript();
      for (const event of events) {
        transcript = reduce(transcript, event);
        if (event.type === "turn.started") setState("sending", chatId, null);
      }
      transcript = { ...transcript, chat: summaries.get(chatId) ?? transcript.chat };
      setState("chats", chatId, transcript);
    }
  });
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flush);
  // A hidden tab gets no frames; the timer keeps history and status honest.
  setTimeout(flush, 120);
}

function newerSummary(chat: ChatSummary): ChatSummary {
  const previous = summaries.get(chat.id);
  return previous && previous.updatedAt >= chat.updatedAt ? previous : chat;
}

function upsertSummary(incoming: ChatSummary): void {
  const previous = summaries.get(incoming.id);
  if (previous && previous.updatedAt > incoming.updatedAt) return;
  const chat = incoming;
  // A rename, restore, or another chat's activity must not switch the transcript
  // just because the editor initially selected the newest conversation.
  preserveActiveChat(chat.projectId);
  summaries.set(chat.id, chat);
  summaryChanges.set(chat.id, ++summaryChange);
  const deleted = chat.deletedAt !== undefined;
  const target = deleted ? "deletedLists" : "lists";
  const other = deleted ? "lists" : "deletedLists";
  batch(() => {
    setState(target, chat.projectId, (list) => [...(list ?? []).filter((entry) => entry.id !== chat.id), chat].sort((a, b) => b.updatedAt - a.updatedAt));
    if (state[other][chat.projectId]) setState(other, chat.projectId, (list) => list.filter((entry) => entry.id !== chat.id));
    if (deleted) {
      queue.delete(chat.id);
      const awaiting = awaitingSnapshot.get(chat.id);
      awaitingSnapshot.delete(chat.id);
      if (awaiting) setState("sending", awaiting, null);
      setState("sending", chat.id, null);
      setState("chats", chat.id, undefined!);
    } else if (state.chats[chat.id]) {
      setState("chats", chat.id, "chat", reconcile(chat));
    }
  });
  if (deleted) {
    subscriptions.get(chat.id)?.();
    subscriptions.delete(chat.id);
    if (root.active()[chat.projectId] === chat.id) setActiveChat(chat.projectId, activeChatId(chat.projectId));
  }
}

const subscriptions = new Map<string, () => void>();

/** Subscribes to a chat (once); the transcript lands in the store and stays current. */
export function openChat(chatId: string): void {
  ensureConnected();
  if (summaries.get(chatId)?.deletedAt !== undefined) return;
  if (subscriptions.has(chatId)) return;
  const unsubscribe = client.open(chatId, (message) => {
    if (message.type === "snapshot") {
      applySnapshot(message.snapshot);
      const key = awaitingSnapshot.get(chatId);
      if (key) {
        awaitingSnapshot.delete(chatId);
        setState("sending", key, null);
      }
      return;
    }
    if (message.event.type === "chat.updated") {
      upsertSummary(message.event.chat);
      return;
    }
    if (summaries.get(chatId)?.deletedAt !== undefined) return;
    const events = queue.get(chatId);
    if (events) events.push(message.event);
    else queue.set(chatId, [message.event]);
    scheduleFlush();
  });
  subscriptions.set(chatId, unsubscribe);
}

function applySnapshot(snapshot: ChatSnapshot): void {
  const chat = newerSummary(snapshot.chat);
  if (chat.deletedAt !== undefined) return;
  queue.delete(snapshot.chat.id);
  batch(() => {
    setState("chats", snapshot.chat.id, { items: snapshot.items, pending: snapshot.pending, turnId: null, chat });
    upsertSummary(chat);
  });
}

/** Fetches a project's history; the store keeps it current from then on. */
export async function refreshChats(projectId: string): Promise<void> {
  try {
    await refreshChatList(projectId, false);
  } catch {
    // Offline: whatever the store holds stays.
  }
}

/** Deleted history errors are shown by the caller rather than disguised as an empty bin. */
export async function refreshDeletedChats(projectId: string): Promise<void> {
  await refreshChatList(projectId, true);
}

async function refreshChatList(projectId: string, deleted: boolean): Promise<void> {
  await whenOpen();
  const key = `${deleted ? "deleted" : "active"}:${projectId}`;
  const request = (listRequests.get(key) ?? 0) + 1;
  listRequests.set(key, request);
  const started = summaryChange;
  const list = await client.request("chats.list", { projectId, ...(deleted ? { deleted: true } : {}) });
  if (listRequests.get(key) !== request) return;
  const entries = new Map<string, ChatSummary>();
  for (const incoming of list) {
    const chat = newerSummary(incoming);
    if (chat.projectId === projectId) entries.set(chat.id, chat);
  }
  // A new chat or management operation can arrive while this list is in flight.
  for (const [id, changed] of summaryChanges) {
    const chat = summaries.get(id)!;
    if (changed > started && chat.projectId === projectId) entries.set(id, chat);
  }
  const result = [...entries.values()].filter((chat) => (chat.deletedAt !== undefined) === deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const chat of result) summaries.set(chat.id, chat);
  if (!deleted) preserveActiveChat(projectId);
  setState(deleted ? "deletedLists" : "lists", projectId, result);
}

function applyChatFolders(folders: ChatFoldersState): void {
  if (state.foldersLoaded && folders.revision < state.folders.revision) return;
  batch(() => {
    setState("folders", reconcile(folders));
    setState("foldersLoaded", true);
    setState("foldersError", null);
  });
}

export async function refreshChatFolders(): Promise<void> {
  try {
    await whenOpen();
    applyChatFolders(await client.request("chatFolders.get", {}));
  } catch (error) {
    setState("foldersError", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// --- drafts -------------------------------------------------------------

export const draft = (key: string): Draft => state.drafts[key] ?? EMPTY_DRAFT;

export function setDraftText(key: string, text: string): void {
  setState("drafts", key, { ...draft(key), text });
}

export function setDraftAttachments(key: string, attachments: Attachment[]): void {
  setState("drafts", key, { ...draft(key), attachments });
}

export function clearDraft(key: string): void {
  setState("drafts", key, EMPTY_DRAFT);
}

/** Return an unsent prompt without losing the next prompt typed while waiting. */
export function restoreDraft(key: string, unsent: Draft): void {
  const current = draft(key);
  setState("drafts", key, {
    text: current.text === unsent.text ? current.text : [unsent.text, current.text].filter(Boolean).join("\n\n"),
    attachments: mergeAttachments(current.attachments, unsent.attachments),
  });
}

// --- actions ------------------------------------------------------------

export type SendOptions = {
  projectId: string;
  cwd: string;
  chatId: string | null;
  text: string;
  attachments: string[];
  model: ModelRef;
  /** Final lifecycle guard after connection/save, immediately before dispatch. */
  beforeDispatch?: () => void;
};

/** Sends a turn; resolves with the chat id as soon as the host accepted it. */
export async function send(options: SendOptions): Promise<string> {
  const key = draftKey(options.projectId, options.chatId);
  track("prompt_sent", {
    new_chat: !options.chatId,
    harness: options.model.harness,
    model: options.model.model,
    length: options.text.length,
    attachments: options.attachments.length,
  });
  const optimistic: Item = {
    id: `optimistic-${Date.now()}`,
    kind: "user",
    text: options.text,
    ...(options.attachments.length ? { attachments: options.attachments } : {}),
  };
  setState("sending", key, optimistic);
  try {
    await whenOpen();
    // The agent's checkpoint must include the latest timeline, media links
    // and settings, including any gesture still waiting on the save debounce.
    await flushProjectEdits(options.cwd);
    options.beforeDispatch?.();
    const { chatId } = await client.request("turn.send", {
      ...(options.chatId ? { chatId: options.chatId } : {}),
      projectId: options.projectId,
      cwd: options.cwd,
      text: options.text,
      ...(options.attachments.length ? { attachments: options.attachments } : {}),
      model: options.model,
    });
    if (!options.chatId) {
      awaitingSnapshot.set(chatId, key);
      setActiveChat(options.projectId, chatId);
    }
    openChat(chatId);
    flush();
    if (options.chatId) setState("sending", key, null);
    return chatId;
  } catch (error) {
    setState("sending", key, null);
    throw error;
  }
}

/** The host checks current source before restoring, so newer edits are never discarded. */
export async function reviewEdit(projectId: string) {
  await whenOpen();
  return client.request("edits.review", { projectId });
}

export async function restoreEdit(projectId: string, checkpointId: string, cwd: string, direction: "undo" | "redo") {
  await whenOpen();
  // Otherwise a queued autosave can land after Undo and replace its result.
  // It also lets the host detect newer manual edits before touching files.
  await flushProjectEdits(cwd);
  return client.request("edits.restore", { projectId, checkpointId, cwd, direction });
}

export async function interrupt(chatId: string): Promise<void> {
  await client.request("turn.interrupt", { chatId });
}

export async function respond(chatId: string, requestId: string, response: RequestResponse): Promise<void> {
  await client.request("request.respond", { chatId, requestId, response });
}

export async function renameChat(chatId: string, title: string): Promise<ChatSummary> {
  await whenOpen();
  const chat = await client.request("chats.rename", { chatId, title });
  upsertSummary(chat);
  return chat;
}

/** Deletion is recoverable. Keep an unsent draft available if the chat is restored. */
export async function deleteChat(_projectId: string, chatId: string): Promise<void> {
  await whenOpen();
  upsertSummary(await client.request("chats.delete", { chatId }));
}

export async function restoreChat(chatId: string): Promise<ChatSummary> {
  await whenOpen();
  const chat = await client.request("chats.restore", { chatId });
  upsertSummary(chat);
  return chat;
}

export async function createChatFolder(name: string, chatId?: string): Promise<ChatFoldersState> {
  await whenOpen();
  const folders = await client.request("chatFolders.create", { name, ...(chatId ? { chatId } : {}) });
  applyChatFolders(folders);
  return folders;
}

export async function renameChatFolder(folderId: string, name: string): Promise<void> {
  await whenOpen();
  applyChatFolders(await client.request("chatFolders.rename", { folderId, name }));
}

export async function deleteChatFolder(folderId: string): Promise<void> {
  await whenOpen();
  applyChatFolders(await client.request("chatFolders.delete", { folderId }));
}

export async function moveChatToFolder(chatId: string, folderId: string | null): Promise<void> {
  await whenOpen();
  applyChatFolders(await client.request("chatFolders.move", { chatId, folderId }));
}

/** The transcript to render for a chat; empty until its snapshot lands. */
export const transcriptOf = (chatId: string | null): Transcript => (chatId ? (state.chats[chatId] ?? emptyTranscript()) : emptyTranscript());

/** The summary as the host last reported it; the list's copy until the transcript's arrives. */
export function summaryOf(projectId: string, chatId: string | null): ChatSummary | null {
  if (!chatId) return null;
  const chat = state.chats[chatId]?.chat ?? state.lists[projectId]?.find((entry) => entry.id === chatId);
  return chat?.projectId === projectId && chat.deletedAt === undefined ? chat : null;
}

// --- home-view handoff ---------------------------------------------------

export type StartChatOptions = {
  project: ProjectInfo;
  text: string;
  attachments: string[];
  model: ModelRef;
};

/**
 * Starts a chat from the dashboard: sends the first turn, makes the new chat
 * the project's active one and opens the Chat tab, so the editor lands with
 * the reply already streaming. On failure the text survives as the project's
 * draft and the error is a toast; home navigates either way.
 */
export async function startChat(options: StartChatOptions): Promise<void> {
  const projectId = options.project.id;
  setSidebarTab("chat");
  // The layout provider is not mounted on the dashboard, so its stored key
  // is written directly: the editor reads it when it mounts.
  settings.define<boolean>("layout.uiVisible", true).value = true;
  try {
    await send({ 
      projectId, 
      cwd: options.project.dir, 
      chatId: null, 
      text: options.text, 
      attachments: options.attachments, 
      model: options.model,
    });
  } catch (error) {
    setActiveChat(projectId, null);
    restoreDraft(draftKey(projectId, null), {
      text: options.text,
      attachments: options.attachments.map(attachmentFromPath),
    });
    toast.error("Could not start the chat", { description: (error as Error).message });
  }
}

/** The route a started chat lands on. */
export const chatRoute = (project: ProjectInfo): string => projectRoute(project.id || project.name);

export { attachmentPaths };

/** Left sidebar width by tab: room for about 50 characters of 12 px text on the Chat tab. */
export const ASSETS_SIDEBAR_WIDTH = 264;
export const CHAT_SIDEBAR_WIDTH = 340;
export const FOOTAGE_SIDEBAR_WIDTH = 380;

export const leftSidebarWidth = (): number => sidebarTab() === "footage"
  ? FOOTAGE_SIDEBAR_WIDTH
  : sidebarTab() === "chat" ? CHAT_SIDEBAR_WIDTH : ASSETS_SIDEBAR_WIDTH;

/** For the empty state: why nothing can be sent right now, or null. */
export function blockedReason(): string | null {
  if (state.connection === "unavailable") return "Chat runs in the desktop app.";
  if (state.connection !== "open") return "Connecting to the agent host…";
  if (state.harnesses.length && state.harnesses.every((harness) => harness.status === "checking")) return "Looking for Claude Code and Codex…";
  if (!readyHarnesses().length) {
    const detail = state.harnesses.map((harness) => harness.detail).find(Boolean);
    return detail ? `No agent is ready. ${detail}.` : "Install Claude Code or Codex to chat.";
  }
  return null;
}
