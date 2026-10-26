/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/host";
import { ChatStore } from "../src/host/store";
import { FakeHarness } from "../src/host/fake";
import { CheckpointStore } from "../src/host/checkpoints";
import type { HostMsg } from "../src/protocol";

let dir: string;
let host: AgentHost;
let store: ChatStore;
const messages: HostMsg[] = [];
const connection = { send: (message: HostMsg) => { messages.push(message); } };
const input = { projectId: "project", cwd: "/tmp/lifecycle-project", text: "hello", model: { harness: "claude" as const, model: "fake-fast" } };

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "agent-chat-lifecycle-"));
  store = new ChatStore(dir);
  const fake = new FakeHarness({ tickMs: 1 });
  host = new AgentHost({
    store, harnesses: [fake],
    env: Promise.resolve({ env: {}, extraDirs: [] }), mcp: { name: "test", url: "http://localhost/unused" }, version: "test",
  });
  await host.start();
  return fake;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await host?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
  messages.length = 0;
});

async function idle(chatId: string) {
  await vi.waitFor(async () => {
    expect((await host.handle(connection, "chats.open", { chatId })).chat.status).toBe("idle");
  });
}

it("settles a turn despite a terminal metadata failure and allows the next turn", async () => {
  await setup();
  const writeMeta = store.writeMeta.bind(store);
  let fail = true;
  vi.spyOn(store, "writeMeta").mockImplementation((meta) => {
    if (fail && meta.status === "idle") return Promise.reject(new Error("disk is full"));
    return writeMeta(meta);
  });
  const { chatId } = await host.handle(connection, "turn.send", input);
  await idle(chatId);
  const snapshot = await host.handle(connection, "chats.open", { chatId });
  expect(snapshot.pending).toBeNull();
  expect(snapshot.items).toContainEqual(expect.objectContaining({ kind: "notice", level: "error", text: expect.stringContaining("disk is full") }));
  expect(messages).toContainEqual(expect.objectContaining({ t: "event", event: expect.objectContaining({ type: "turn.completed" }) }));

  fail = false;
  await expect(host.handle(connection, "turn.send", { ...input, chatId, text: "continue" })).resolves.toEqual({ chatId });
  await idle(chatId);
  expect((await store.readMeta(chatId))?.status).toBe("idle");
});

it("does not leave a running or ghost chat when the initial save fails", async () => {
  await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await idle(chatId);
  const writeMeta = store.writeMeta.bind(store);
  vi.spyOn(store, "writeMeta").mockImplementation((meta) => {
    if (meta.status === "running") return Promise.reject(new Error("read-only storage"));
    return writeMeta(meta);
  });
  await expect(host.handle(connection, "turn.send", { ...input, chatId })).rejects.toThrow("read-only storage");
  await expect(host.handle(connection, "turn.send", input)).rejects.toThrow("read-only storage");
  expect(await host.handle(connection, "chats.list", { projectId: input.projectId })).toEqual([
    expect.objectContaining({ id: chatId, status: "idle" }),
  ]);
});

it("surfaces question-status persistence failures and still accepts Stop", async () => {
  await setup();
  const writeMeta = store.writeMeta.bind(store);
  vi.spyOn(store, "writeMeta").mockImplementation((meta) => {
    if (meta.status === "waiting") return Promise.reject(new Error("cannot save question"));
    return writeMeta(meta);
  });
  const { chatId } = await host.handle(connection, "turn.send", { ...input, text: "ask me" });
  await vi.waitFor(async () => {
    const snapshot = await host.handle(connection, "chats.open", { chatId });
    expect(snapshot.pending).not.toBeNull();
    expect(snapshot.items).toContainEqual(expect.objectContaining({ kind: "notice", level: "error", text: expect.stringContaining("cannot save question") }));
  });
  await host.handle(connection, "turn.interrupt", { chatId });
  const snapshot = await host.handle(connection, "chats.open", { chatId });
  expect(snapshot.chat.status).toBe("idle");
  expect(snapshot.pending).toBeNull();
});

it("does not let a disconnected subscriber strand a running turn", async () => {
  await setup();
  const broken = { send() { throw new Error("socket closed"); } };
  const { chatId } = await host.handle(broken, "turn.send", input);
  await idle(chatId);
  expect((await host.handle(connection, "chats.open", { chatId })).items).toContainEqual(expect.objectContaining({ kind: "assistant" }));
});

it("shuts down cleanly when interrupt settles the active turn before it returns", async () => {
  const fake = await setup();
  const { chatId } = await host.handle(connection, "turn.send", { ...input, text: "ask me" });
  await vi.waitFor(async () => expect((await host.handle(connection, "chats.open", { chatId })).pending).not.toBeNull());
  const session = fake.sessions[0]!;
  const interrupt = session.interrupt.bind(session);
  vi.spyOn(session, "interrupt").mockImplementation(async () => {
    await interrupt();
    await idle(chatId);
  });
  await expect(host.stop()).resolves.toBeUndefined();
  expect((await store.readMeta(chatId))?.status).toBe("idle");
});

it("opens a recovered chat even when storage is still unavailable after restart", async () => {
  await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await idle(chatId);
  await host.stop();
  const meta = (await store.readMeta(chatId))!;
  await store.writeMeta({ ...meta, status: "running" });
  vi.spyOn(store, "append").mockRejectedValue(new Error("storage remains full"));
  host = new AgentHost({ store, harnesses: [], env: Promise.resolve({ env: {}, extraDirs: [] }), mcp: null, version: "test" });
  await expect(host.start()).resolves.toBeUndefined();
  const snapshot = await host.handle(connection, "chats.open", { chatId });
  expect(snapshot.chat.status).toBe("idle");
  expect(snapshot.pending).toBeNull();
  expect(snapshot.items).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining("storage remains full") }));
  expect(snapshot.items.filter((item) => item.kind === "user")).toHaveLength(1);
});

it("recovers a project's checkpoint once using its latest folder, with a visible error", async () => {
  await setup();
  const first = await host.handle(connection, "turn.send", input);
  await idle(first.chatId);
  const second = await host.handle(connection, "turn.send", { ...input, cwd: "/tmp/moved-project" });
  await idle(second.chatId);
  await host.stop();
  const checkpoint = new CheckpointStore(dir);
  const recover = vi.spyOn(checkpoint, "recover").mockRejectedValue(new Error("source was changed externally"));
  host = new AgentHost({ store, checkpoints: checkpoint, harnesses: [], env: Promise.resolve({ env: {}, extraDirs: [] }), mcp: null, version: "test" });
  await host.start();
  expect(recover).toHaveBeenCalledExactlyOnceWith(input.projectId, "/tmp/moved-project");
  const snapshot = await host.handle(connection, "chats.open", { chatId: second.chatId });
  const notices = snapshot.items.filter((item) => item.kind === "notice" && item.text.includes("source was changed externally"));
  expect(notices).toHaveLength(1);
});

it("hands every session the chat store, so harnesses can keep it from the agent", async () => {
  const fake = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await idle(chatId);
  expect(fake.sessions.at(-1)!.opened.dataDir).toBe(resolve(dir));
});
