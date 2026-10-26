/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/host";
import { ChatStore } from "../src/host/store";
import { FakeHarness } from "../src/host/fake";
import type { ChatMeta } from "../src/host/store";
import type { HostMsg } from "../src/protocol";

let dir: string;
let store: ChatStore;
let host: AgentHost;
let fake: FakeHarness;
const messages: HostMsg[] = [];
const observer: HostMsg[] = [];
const connection = { send: (message: HostMsg) => { messages.push(message); } };
const input = { projectId: "project", cwd: "/tmp/chat-management-project", text: "First draft", model: { harness: "claude" as const, model: "fake-fast" } };

async function start() {
  host = new AgentHost({ store, harnesses: [fake], env: Promise.resolve({ env: {}, extraDirs: [] }),
    mcp: { name: "test", url: "http://localhost/unused" }, version: "test" });
  await host.start();
  host.connect(connection);
  host.connect({ send: (message) => { observer.push(message); } });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-management-"));
  store = new ChatStore(dir);
  fake = new FakeHarness({ tickMs: 1, slowWords: 2, holdSlow: true });
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await host.stop();
  await rm(dir, { recursive: true, force: true });
  messages.length = 0;
  observer.length = 0;
});

async function idle(chatId: string) {
  await vi.waitFor(async () => expect((await host.handle(connection, "chats.open", { chatId })).chat.status).toBe("idle"));
}

async function create() {
  const { chatId } = await host.handle(connection, "turn.send", input);
  await idle(chatId);
  return chatId;
}

it("renames durably, informs an unopened history list, and retains the title on continuation and restart", async () => {
  const chatId = await create();
  const before = (await store.readMeta(chatId))!;
  const renamed = await host.handle(connection, "chats.rename", { chatId, title: "  Episode two · final edit  " });
  expect(renamed.title).toBe("Episode two · final edit");
  expect(renamed.updatedAt).toBeGreaterThan(before.updatedAt);
  expect((await store.readMeta(chatId))!.title).toBe(renamed.title);
  expect(observer).toContainEqual({ t: "chat.changed", chat: renamed });
  await host.handle(connection, "turn.send", { ...input, chatId, text: "Continue the edit" });
  await idle(chatId);
  expect((await host.handle(connection, "chats.open", { chatId })).chat.title).toBe(renamed.title);
  await host.stop();
  await start();
  const reopened = await host.handle(connection, "chats.open", { chatId });
  expect(reopened.chat.title).toBe(renamed.title);
  expect(reopened.items.filter((item) => item.kind === "user")).toHaveLength(2);
  expect(fake.sessions.at(-1)!.opened.resume).toEqual(before.resume);
});

it("rejects empty and oversized names without changing stored metadata", async () => {
  const chatId = await create();
  const before = await store.readMeta(chatId);
  for (const title of ["", "   ", "x".repeat(161)]) {
    await expect(host.handle(connection, "chats.rename", { chatId, title })).rejects.toMatchObject({ code: "bad-request" });
  }
  expect(await store.readMeta(chatId)).toEqual(before);
});

it("deletes recoverably across restart without changing the transcript, resume cursor, or folder assignment", async () => {
  const chatId = await create();
  const snapshot = await host.handle(connection, "chats.open", { chatId });
  const stored = (await store.readMeta(chatId))!;
  const eventsPath = join(dir, "chats", chatId, "events.jsonl");
  const events = await readFile(eventsPath, "utf8");
  const folders = await host.handle(connection, "chatFolders.create", { name: "Episode 2", chatId });
  const deleted = await host.handle(connection, "chats.delete", { chatId });
  expect(deleted.deletedAt).toEqual(expect.any(Number));
  expect(deleted.updatedAt).toBeGreaterThan(snapshot.chat.updatedAt);
  expect(await host.handle(connection, "chats.list", { projectId: input.projectId })).toEqual([]);
  expect(await host.handle(connection, "chats.list", { projectId: input.projectId, deleted: true })).toEqual([deleted]);
  await expect(host.handle(connection, "chats.open", { chatId })).rejects.toMatchObject({ code: "not-found" });
  await expect(host.handle(connection, "turn.send", { ...input, chatId })).rejects.toMatchObject({ code: "not-found" });
  await host.stop();
  await start();
  expect(await host.handle(connection, "chats.list", { projectId: input.projectId })).toEqual([]);
  const restored = await host.handle(connection, "chats.restore", { chatId });
  expect(restored.deletedAt).toBeUndefined();
  expect(restored.updatedAt).toBeGreaterThan(deleted.updatedAt);
  expect((await host.handle(connection, "chats.open", { chatId })).items).toEqual(snapshot.items);
  expect((await store.readMeta(chatId))!.resume).toEqual(stored.resume);
  expect((await host.handle(connection, "chatFolders.get", {})).assignments).toEqual(folders.assignments);
  expect(await readFile(eventsPath, "utf8")).toBe(events);
});

it("does not publish or hide a chat when its deletion save fails, and can retry", async () => {
  const chatId = await create();
  const before = (await host.handle(connection, "chats.open", { chatId })).chat;
  const save = vi.spyOn(store, "writeMeta").mockRejectedValueOnce(new Error("disk full"));
  observer.length = 0;
  await expect(host.handle(connection, "chats.delete", { chatId })).rejects.toThrow("disk full");
  expect(await host.handle(connection, "chats.list", { projectId: input.projectId })).toEqual([before]);
  expect((await store.readMeta(chatId))!.deletedAt).toBeUndefined();
  expect(observer.filter((message) => message.t === "chat.changed")).toEqual([]);
  save.mockRestore();
  await expect(host.handle(connection, "chats.delete", { chatId })).resolves.toMatchObject({ id: chatId, deletedAt: expect.any(Number) });
});

it("does not replace the existing title or restore a deleted chat when metadata storage fails", async () => {
  const chatId = await create();
  const save = vi.spyOn(store, "writeMeta").mockRejectedValueOnce(new Error("read only"));
  await expect(host.handle(connection, "chats.rename", { chatId, title: "New title" })).rejects.toThrow("read only");
  expect((await host.handle(connection, "chats.open", { chatId })).chat.title).toBe(input.text);
  save.mockRestore();
  await host.handle(connection, "chats.delete", { chatId });
  vi.spyOn(store, "writeMeta").mockRejectedValueOnce(new Error("read only"));
  await expect(host.handle(connection, "chats.restore", { chatId })).rejects.toThrow("read only");
  expect(await host.handle(connection, "chats.list", { projectId: input.projectId })).toEqual([]);
  expect((await store.readMeta(chatId))!.deletedAt).toEqual(expect.any(Number));
});

it("refuses destructive metadata changes while an edit runs but permits folder organization", async () => {
  const { chatId } = await host.handle(connection, "turn.send", { ...input, text: "slow edit" });
  await expect(host.handle(connection, "chats.rename", { chatId, title: "new" })).rejects.toMatchObject({ code: "busy" });
  await expect(host.handle(connection, "chats.delete", { chatId })).rejects.toMatchObject({ code: "busy" });
  const before = (await store.readMeta(chatId))!;
  const folders = await host.handle(connection, "chatFolders.create", { name: "Active edit", chatId });
  const folderId = folders.folders[0]!.id;
  expect(folders.assignments[chatId]).toBe(folderId);
  const after = (await store.readMeta(chatId))!;
  expect(after.projectId).toBe(before.projectId);
  expect(after.cwd).toBe(before.cwd);
  expect((await host.handle(connection, "chats.open", { chatId })).chat.status).toBe("running");
  await host.handle(connection, "turn.interrupt", { chatId });
  await idle(chatId);
});

it("rejects new edits and competing metadata operations while a rename is still committing", async () => {
  const chatId = await create();
  const original = store.writeMeta.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const write = vi.spyOn(store, "writeMeta").mockImplementation(async (meta) => { await gate; await original(meta); });
  const rename = host.handle(connection, "chats.rename", { chatId, title: "Committing" });
  await vi.waitFor(() => expect(write).toHaveBeenCalled());
  await expect(host.handle(connection, "turn.send", { ...input, chatId })).rejects.toMatchObject({ code: "busy" });
  await expect(host.handle(connection, "chats.delete", { chatId })).rejects.toMatchObject({ code: "busy" });
  release();
  await rename;
  write.mockRestore();
  await host.handle(connection, "turn.send", { ...input, chatId });
  await idle(chatId);
});

it("permanently removes deleted chats when their actual project is removed", async () => {
  const chatId = await create();
  await host.handle(connection, "chats.delete", { chatId });
  await host.deleteChats(input.projectId);
  expect(await store.readMeta(chatId)).toBeNull();
  await expect(host.handle(connection, "chats.restore", { chatId })).rejects.toMatchObject({ code: "not-found" });
});

it("waits for turn startup when project teardown races the first metadata save", async () => {
  const original = store.writeMeta.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let meta: ChatMeta | undefined;
  vi.spyOn(store, "writeMeta").mockImplementationOnce(async (value) => { meta = value; await gate; await original(value); });
  const sending = host.handle(connection, "turn.send", { ...input, text: "slow edit" });
  await vi.waitFor(() => expect(meta).toBeDefined());
  const deleting = host.deleteChats(input.projectId);
  release();
  const { chatId } = await sending;
  await deleting;
  expect(await store.readMeta(chatId)).toBeNull();
  expect(await host.handle(connection, "chats.list", { projectId: input.projectId })).toEqual([]);
});

it("broadcasts folder changes and validates chats without changing their editing context", async () => {
  const chatId = await create();
  const before = (await store.readMeta(chatId))!;
  const first = await host.handle(connection, "chatFolders.create", { name: "Rheesa", chatId });
  expect(observer).toContainEqual({ t: "chatFolders.changed", state: first });
  const id = first.folders[0]!.id;
  const renamed = await host.handle(connection, "chatFolders.rename", { folderId: id, name: "Episode 2" });
  expect(renamed.revision).toBeGreaterThan(first.revision);
  await host.handle(connection, "chatFolders.move", { chatId, folderId: null });
  expect(await store.readMeta(chatId)).toEqual(before);
  await host.handle(connection, "chats.delete", { chatId });
  await expect(host.handle(connection, "chatFolders.move", { chatId, folderId: id })).rejects.toMatchObject({ code: "not-found" });
  await expect(host.handle(connection, "chatFolders.create", { name: "Invalid", chatId: "missing" })).rejects.toMatchObject({ code: "not-found" });
  const deleted = await host.handle(connection, "chatFolders.delete", { folderId: id });
  expect(deleted.folders).toEqual([]);
});
