/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatStore } from "../src/host/store";

import type { ChatMeta } from "../src/host/store";

let dir: string;
let store: ChatStore;

const meta = (id: string): ChatMeta => ({
  id,
  projectId: "p",
  title: "t",
  harness: "claude",
  model: "m",
  status: "idle",
  createdAt: 1,
  updatedAt: 2,
  cwd: "/p",
  resume: null,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-chat-store-"));
  store = new ChatStore(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("ChatStore", () => {
  it("lists nothing when the folder does not exist yet", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.readTranscript("nope")).toEqual({ items: [], pending: null, turnId: null, chat: null });
  });

  it("round-trips meta atomically and lists it", async () => {
    await store.writeMeta(meta("a"));
    await store.writeMeta({ ...meta("a"), title: "renamed" });
    await store.writeMeta(meta("b"));
    const listed = await store.list();
    expect(listed.map((entry) => [entry.id, entry.title]).sort()).toEqual([
      ["a", "renamed"],
      ["b", "t"],
    ]);
    expect(readFileSync(join(dir, "chats", "a", "meta.json"), "utf8")).not.toContain(".tmp");
  });

  it("preserves the prior resume record if syncing its replacement fails", async () => {
    await store.writeMeta({ ...meta("a"), resume: { claude: { sessionId: "before" } } });
    const path = join(dir, "chats", "a", "meta.json");
    const file = await open(path, "r");
    const prototype = Object.getPrototypeOf(file);
    await file.close();
    vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("metadata fsync failed"));
    await expect(store.writeMeta({ ...meta("a"), resume: { claude: { sessionId: "after" } } })).rejects.toThrow("metadata fsync failed");
    expect((await store.readMeta("a"))?.resume).toEqual({ claude: { sessionId: "before" } });
    expect(readdirSync(join(dir, "chats", "a"))).toEqual(["meta.json"]);
  });

  it("reports a directory sync failure and safely retries the committed cursor", async () => {
    await store.writeMeta(meta("a"));
    const file = await open(join(dir, "chats", "a", "meta.json"), "r");
    const prototype = Object.getPrototypeOf(file);
    const sync = prototype.sync;
    await file.close();
    let failDirectory = true;
    vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof file) {
      if (failDirectory && (await this.stat()).isDirectory()) {
        failDirectory = false;
        throw new Error("directory fsync failed");
      }
      await sync.call(this);
    });
    const confirmed = { ...meta("a"), resume: { claude: { sessionId: "confirmed" } } };
    await expect(store.writeMeta(confirmed)).rejects.toThrow("directory fsync failed");
    await store.writeMeta(confirmed);
    expect((await store.readMeta("a"))?.resume).toEqual(confirmed.resume);
    expect(readdirSync(join(dir, "chats", "a"))).toEqual(["meta.json"]);
  });

  it("folds the event log into a transcript and skips a torn trailing line", async () => {
    await store.writeMeta(meta("a"));
    await store.append("a", { type: "turn.started", turnId: "t", model: "m", user: { id: "u", kind: "user", text: "hi" } });
    await store.append("a", { type: "item.completed", item: { id: "x", kind: "assistant", text: "hello" } });
    await store.append("a", { type: "turn.completed", turnId: "t", status: "completed" });
    appendFileSync(join(dir, "chats", "a", "events.jsonl"), '{"type":"item.comp');
    const transcript = await store.readTranscript("a");
    expect(transcript.items.map((item) => item.id)).toEqual(["u", "x"]);
    expect(transcript.turnId).toBeNull();
  });

  it("removes a chat's folder", async () => {
    await store.writeMeta(meta("a"));
    await store.remove("a");
    expect(await store.list()).toEqual([]);
    expect(await store.readMeta("a")).toBeNull();
  });

  it("keeps new events separate from a torn trailing line after recovery", async () => {
    await store.writeMeta(meta("a"));
    await store.append("a", { type: "turn.started", turnId: "before", model: "m", user: { id: "u1", kind: "user", text: "before crash" } });
    const path = join(dir, "chats", "a", "events.jsonl");
    appendFileSync(path, '{"type":"item.comp');

    // The first append after restarting must itself survive the torn fragment.
    store = new ChatStore(dir);
    await store.append("a", { type: "turn.completed", turnId: "recovered", status: "interrupted" });
    expect((await store.readTranscript("a")).turnId).toBeNull();
    await store.append("a", { type: "turn.started", turnId: "after", model: "m", user: { id: "u2", kind: "user", text: "after crash" } });
    expect((await store.readTranscript("a")).items.map((item) => item.id)).toEqual(["u1", "u2"]);
    expect(readFileSync(path, "utf8")).toContain('{"type":"item.comp\n');
  });

  it("retries failed event appends in order before saving metadata", async () => {
    await store.writeMeta(meta("a"));
    const path = join(dir, "chats", "a", "events.jsonl");
    mkdirSync(path);
    await expect(store.append("a", { type: "turn.started", turnId: "t", model: "m", user: { id: "u", kind: "user", text: "keep this prompt" } })).rejects.toThrow();
    await expect(store.append("a", { type: "item.completed", item: { id: "a", kind: "assistant", text: "keep this response" } })).rejects.toThrow();

    rmSync(path, { recursive: true });
    await store.writeMeta(meta("a"));
    const transcript = await store.readTranscript("a");
    expect(transcript.items.map((item) => item.id)).toEqual(["u", "a"]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("does not duplicate an event when fsync fails after all bytes were written", async () => {
    await store.writeMeta(meta("a"));
    const path = join(dir, "chats", "a", "events.jsonl");
    const file = await open(path, "a+");
    const prototype = Object.getPrototypeOf(file);
    await file.close();
    vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("fsync failed"));
    await expect(store.append("a", { type: "turn.started", turnId: "t", model: "m", user: { id: "u", kind: "user", text: "saved once" } })).rejects.toThrow("fsync failed");
    await store.append("a", { type: "turn.completed", turnId: "t", status: "completed" });
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect((await store.readTranscript("a")).items).toHaveLength(1);
  });

  it("completes only the missing bytes after a partial append fails", async () => {
    await store.writeMeta(meta("a"));
    const path = join(dir, "chats", "a", "events.jsonl");
    const file = await open(path, "a+");
    const prototype = Object.getPrototypeOf(file);
    const append = prototype.appendFile;
    await file.close();
    vi.spyOn(prototype, "appendFile").mockImplementationOnce(async function (this: typeof file, data: unknown) {
      const bytes = data as Buffer;
      await append.call(this, bytes.subarray(0, bytes.length - 7));
      throw new Error("disk full during append");
    });
    await expect(store.append("a", { type: "turn.started", turnId: "t", model: "m", user: { id: "u", kind: "user", text: "keep 🎬" } })).rejects.toThrow("disk full during append");
    await store.writeMeta(meta("a"));
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0].user.text).toBe("keep 🎬");
  });
});
