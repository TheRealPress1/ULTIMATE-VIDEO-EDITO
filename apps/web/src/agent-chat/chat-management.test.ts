import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatFoldersState, ChatSummary } from "@diffusionstudio/agent-chat";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  changed: null as null | ((chat: ChatSummary) => void),
  foldersChanged: null as null | ((folders: ChatFoldersState) => void),
  snapshots: new Map<string, (message: unknown) => void>(),
  unsubscribed: vi.fn(),
  frames: [] as Array<() => void>,
}));
vi.mock("@/projects/edits", () => ({ flushProjectEdits: vi.fn() }));
vi.mock("@/init", () => ({ store: { define: (_key: string, value: unknown) => ({ value }) } }));
vi.mock("@/lib/store", async () => {
  const { createSignal } = await import("solid-js");
  return { createStoredSignal: (entry: { value: unknown }) => createSignal(entry.value) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-project-route", () => ({ projectRoute: (id: string) => `/project/${id}` }));
vi.mock("./attachments", () => ({
  attachmentFromPath: (path: string) => ({ path }), attachmentPaths: (items: unknown[]) => items,
  mergeAttachments: (a: unknown[], b: unknown[]) => [...a, ...b],
}));
vi.mock("./connection", () => ({
  hasHost: () => true,
  client: {
    state: "open", request: mocks.request, onState: () => () => {}, onHarnesses: () => () => {},
    onChatChanged: (listener: (chat: ChatSummary) => void) => { mocks.changed = listener; return () => {}; },
    onChatFoldersChanged: (listener: (folders: ChatFoldersState) => void) => { mocks.foldersChanged = listener; return () => {}; },
    open: (id: string, listener: (message: unknown) => void) => {
      mocks.snapshots.set(id, listener);
      return () => mocks.unsubscribed(id);
    },
    connect() {},
  },
}));

const chat = (id = "one", extra: Partial<ChatSummary> = {}): ChatSummary => ({
  id, projectId: "project", title: `Conversation ${id}`, harness: "claude", model: "fixture",
  status: "idle", createdAt: 10, updatedAt: 10, ...extra,
});
const folders = (revision: number, assignments: Record<string, string> = {}): ChatFoldersState => ({
  version: 1, revision, folders: [{ id: "folder", name: "Episode 2", createdAt: 10 }], assignments,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const store = await import("./store");
  store.ensureConnected();
  return store;
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.request.mockReset();
  mocks.unsubscribed.mockReset();
  mocks.snapshots.clear();
  mocks.changed = null;
  mocks.foldersChanged = null;
  mocks.frames = [];
  vi.stubGlobal("requestAnimationFrame", (frame: () => void) => { mocks.frames.push(frame); return 1; });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat management state", () => {
  it("keeps the implicitly selected transcript when another chat is renamed, restored, or reordered by refresh", async () => {
    const store = await setup(), current = chat("current", { updatedAt: 20 }), other = chat("other");
    mocks.request.mockResolvedValueOnce([current, other]);
    await store.refreshChats("project");
    expect(store.activeChatId("project")).toBe(current.id);
    const renamed = { ...other, title: "Interview notes", updatedAt: 30 };
    mocks.request.mockResolvedValueOnce(renamed);
    await store.renameChat(other.id, renamed.title);
    expect(store.chatState.lists.project[0]?.id).toBe(other.id);
    expect(store.activeChatId("project")).toBe(current.id);
    mocks.request.mockResolvedValueOnce(chat("restored", { updatedAt: 40 }));
    await store.restoreChat("restored");
    expect(store.activeChatId("project")).toBe(current.id);
    mocks.request.mockResolvedValueOnce([chat("newest", { updatedAt: 50 }), renamed, current]);
    await store.refreshChats("project");
    expect(store.activeChatId("project")).toBe(current.id);
  });

  it("falls back when the implicitly selected chat is deleted while preserving an explicit new-chat draft", async () => {
    const store = await setup(), current = chat("current", { updatedAt: 20 }), other = chat("other");
    mocks.request.mockResolvedValueOnce([current, other]);
    await store.refreshChats("project");
    mocks.changed!({ ...current, updatedAt: 30, deletedAt: 30 });
    expect(store.activeChatId("project")).toBe(other.id);
    store.setActiveChat("project", null);
    mocks.changed!({ ...other, title: "New title", updatedAt: 40 });
    expect(store.activeChatId("project")).toBeNull();
  });

  it("stops selecting a cached transcript absent from a refreshed authoritative history", async () => {
    const store = await setup(), current = chat("current", { updatedAt: 20 }), other = chat("other");
    mocks.request.mockResolvedValueOnce([current, other]);
    await store.refreshChats("project");
    store.openChat(current.id);
    mocks.snapshots.get(current.id)!({ type: "snapshot", snapshot: { chat: current, items: [], pending: null, seq: 1 } });
    store.setActiveChat("project", current.id);
    // The deletion happened elsewhere while disconnected, so only the new list reports it.
    mocks.request.mockResolvedValueOnce([other]);
    await store.refreshChats("project");
    expect(store.activeChatId("project")).toBe(other.id);
    mocks.changed!({ ...current, updatedAt: 30 });
    expect(store.activeChatId("project")).toBe(other.id);
  });

  it("keeps the active chat, draft, and subscription when deletion fails", async () => {
    const store = await setup(), original = chat();
    mocks.changed!(original);
    store.openChat(original.id);
    mocks.snapshots.get(original.id)!({ type: "snapshot", snapshot: { chat: original, items: [], pending: null, seq: 1 } });
    store.setActiveChat("project", original.id);
    store.setDraftText(original.id, "Keep this unsent instruction");
    mocks.request.mockRejectedValueOnce(new Error("Disk full"));
    await expect(store.deleteChat("project", original.id)).rejects.toThrow("Disk full");
    expect(store.activeChatId("project")).toBe(original.id);
    expect(store.chatState.lists.project).toEqual([original]);
    expect(store.draft(original.id).text).toBe("Keep this unsent instruction");
    expect(mocks.unsubscribed).not.toHaveBeenCalled();
  });

  it("deletes only after confirmation, ignores stale events and snapshots, and restores the draft and folder", async () => {
    const store = await setup(), original = chat(), another = chat("two", { updatedAt: 9 });
    mocks.changed!(original); mocks.changed!(another);
    mocks.foldersChanged!(folders(1, { one: "folder" }));
    store.openChat(original.id);
    const deliver = mocks.snapshots.get(original.id)!;
    deliver({ type: "snapshot", snapshot: { chat: original, items: [], pending: null, seq: 1 } });
    store.setActiveChat("project", original.id);
    store.setDraftText(original.id, "Unsent thought");
    deliver({ type: "event", seq: 2, event: { type: "item.completed", item: { id: "late", kind: "assistant", text: "Earlier reply" } } });
    const pending = deferred<ChatSummary>();
    mocks.request.mockReturnValueOnce(pending.promise);
    const deletion = store.deleteChat("project", original.id);
    await Promise.resolve();
    expect(store.activeChatId("project")).toBe(original.id);
    const deleted = { ...original, deletedAt: 20, updatedAt: 20 };
    mocks.changed!(deleted); pending.resolve(deleted); await deletion;
    expect(store.activeChatId("project")).toBe(another.id);
    expect(store.chatState.deletedLists.project).toEqual([deleted]);
    expect(mocks.unsubscribed).toHaveBeenCalledOnce();
    deliver({ type: "snapshot", snapshot: { chat: original, items: [], pending: null, seq: 1 } });
    deliver({ type: "event", seq: 3, event: { type: "chat.updated", chat: original } });
    mocks.frames.forEach((frame) => frame());
    expect(store.chatState.lists.project.map((entry) => entry.id)).toEqual([another.id]);
    expect(store.chatState.chats.one).toBeUndefined();
    const restored = { ...original, updatedAt: 30 };
    mocks.request.mockResolvedValueOnce(restored);
    await store.restoreChat(original.id);
    expect(store.chatState.lists.project[0]).toEqual(restored);
    expect(store.chatState.deletedLists.project).toEqual([]);
    expect(store.chatState.folders.assignments.one).toBe("folder");
    expect(store.draft(original.id).text).toBe("Unsent thought");
  });

  it("does not undo a rename or lose newly discovered chats when an older list resolves", async () => {
    const store = await setup(), original = chat();
    mocks.changed!(original);
    const pending = deferred<ChatSummary[]>();
    mocks.request.mockReturnValueOnce(pending.promise);
    const refresh = store.refreshChats("project");
    await Promise.resolve();
    const renamed = { ...original, title: "Rheesa interview", updatedAt: 20 };
    mocks.changed!(renamed);
    mocks.changed!(chat("new", { updatedAt: 21 }));
    pending.resolve([original]); await refresh;
    expect(store.chatState.lists.project.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "new", title: "Conversation new" }, { id: "one", title: "Rheesa interview" },
    ]);
  });

  it("does not resurrect deleted chats from a list or a delayed rename response", async () => {
    const store = await setup(), original = chat();
    mocks.changed!(original);
    const rename = deferred<ChatSummary>();
    mocks.request.mockReturnValueOnce(rename.promise);
    const renaming = store.renameChat(original.id, "Changed title");
    await Promise.resolve();
    const deleted = { ...original, title: "Changed title", updatedAt: 30, deletedAt: 30 };
    mocks.changed!(deleted);
    rename.resolve({ ...original, title: "Changed title", updatedAt: 20 }); await renaming;
    mocks.request.mockResolvedValueOnce([original]);
    await store.refreshChats("project");
    expect(store.chatState.lists.project).toEqual([]);
    expect(store.chatState.deletedLists.project).toEqual([deleted]);
  });

  it("loads transcript items without replacing newer metadata or selecting a chat for another project", async () => {
    const store = await setup(), original = chat();
    mocks.changed!({ ...original, title: "Renamed", updatedAt: 20 });
    store.openChat(original.id);
    mocks.snapshots.get(original.id)!({ type: "snapshot", snapshot: {
      chat: original, items: [{ id: "reply", kind: "assistant", text: "Saved transcript" }], pending: null, seq: 1,
    } });
    expect(store.transcriptOf(original.id).items).toHaveLength(1);
    expect(store.summaryOf("project", original.id)?.title).toBe("Renamed");
    store.setActiveChat("unrelated", original.id);
    expect(store.activeChatId("unrelated")).toBeNull();
    expect(store.summaryOf("unrelated", original.id)).toBeNull();
  });

  it("keeps newer folder organization when an old refresh resolves and never changes project binding", async () => {
    const store = await setup(), original = chat();
    mocks.changed!(original);
    const pending = deferred<ChatFoldersState>();
    mocks.request.mockReturnValueOnce(pending.promise);
    const loading = store.refreshChatFolders();
    await Promise.resolve();
    mocks.foldersChanged!(folders(2, { one: "folder" }));
    pending.resolve(folders(1)); await loading;
    expect(store.chatState.folders.assignments.one).toBe("folder");
    expect(store.chatState.folders.revision).toBe(2);
    mocks.request.mockResolvedValueOnce({ version: 1, revision: 3, folders: [], assignments: {} });
    await store.deleteChatFolder("folder");
    expect(store.chatState.folders.assignments).toEqual({});
    expect(store.chatState.lists.project).toEqual([original]);
  });

  it("reports a folder-load failure and preserves the last saved organization after a failed move", async () => {
    const store = await setup();
    mocks.foldersChanged!(folders(1, { one: "folder" }));
    mocks.request.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(store.refreshChatFolders()).rejects.toThrow("Storage unavailable");
    expect(store.chatState.foldersError).toBe("Storage unavailable");
    expect(store.chatState.foldersLoaded).toBe(true);
    mocks.request.mockRejectedValueOnce(new Error("Could not save"));
    await expect(store.moveChatToFolder("one", null)).rejects.toThrow("Could not save");
    expect(store.chatState.folders.assignments.one).toBe("folder");
  });
});
