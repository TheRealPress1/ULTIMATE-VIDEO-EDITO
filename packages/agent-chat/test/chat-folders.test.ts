/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatFolderStore } from "../src/host/chat-folders";

let dir: string;
let store: ChatFolderStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-chat-folders-"));
  store = new ChatFolderStore(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("ChatFolderStore", () => {
  it("does not create a record while reading an empty store", async () => {
    expect(await store.get()).toEqual({ version: 1, revision: 0, folders: [], assignments: {} });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("persists names and assignments across restart without exposing mutable state", async () => {
    const created = await store.create("  Episode one  ", "chat-a");
    const id = created.folders[0]!.id;
    expect(created.folders[0]!.name).toBe("Episode one");
    expect(created.assignments).toEqual({ "chat-a": id });
    created.folders[0]!.name = "An unsaved mutation";
    created.assignments["chat-a"] = "another-folder";
    store = new ChatFolderStore(dir);
    expect((await store.get()).folders[0]!.name).toBe("Episode one");
    await store.rename(id, "  Interviews  ");
    await store.move("chat-b", id);
    expect(await new ChatFolderStore(dir).get()).toMatchObject({
      folders: [{ id, name: "Interviews" }], assignments: { "chat-a": id, "chat-b": id },
    });
    expect(readdirSync(dir)).toEqual(["chat-folders.json"]);
  });

  it("serializes concurrent changes without losing folders or assignments", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.create(`Episode ${index}`, `chat-${index}`)));
    const final = await store.get();
    expect(final.folders).toHaveLength(20);
    expect(Object.keys(final.assignments)).toHaveLength(20);
    expect(final.revision).toBe(20);
    expect(results.map((state) => state.folders.length)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    for (let index = 0; index < 20; index++) {
      expect(final.assignments[`chat-${index}`]).toBe(final.folders[index]!.id);
    }
  });

  it("only advances the revision for actual changes and upgrades old records", async () => {
    writeFileSync(join(dir, "chat-folders.json"), JSON.stringify({ version: 1, folders: [], assignments: {} }));
    expect((await store.get()).revision).toBe(0);
    const created = await store.create("One", "chat-a");
    const id = created.folders[0]!.id;
    expect(created.revision).toBe(1);
    expect((await store.rename(id, "  One  ")).revision).toBe(1);
    expect((await store.move("chat-a", id)).revision).toBe(1);
    expect((await store.move("already-unfiled", null)).revision).toBe(1);
    expect((await store.move("chat-a", null)).revision).toBe(2);
    expect((await store.delete(id)).revision).toBe(3);
    expect((await new ChatFolderStore(dir).get()).revision).toBe(3);
  });

  it("unfiles only the deleted folder's chats and retains other placement", async () => {
    const first = (await store.create("One", "chat-a")).folders[0]!.id;
    const second = (await store.create("Two", "chat-b")).folders[1]!.id;
    await store.move("chat-c", first);
    const deleted = await store.delete(first);
    expect(deleted.folders.map((folder) => folder.id)).toEqual([second]);
    expect(deleted.assignments).toEqual({ "chat-b": second });
    expect((await store.move("chat-b", null)).assignments).toEqual({});
    expect((await store.move("already-unfiled", null)).assignments).toEqual({});
  });

  it("retains the prior record and cleans its temporary file if saving fails", async () => {
    const original = await store.create("Keep this", "chat-a");
    const path = join(dir, "chat-folders.json");
    const before = readFileSync(path, "utf8");
    const file = await open(path, "r");
    const prototype = Object.getPrototypeOf(file);
    await file.close();
    vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("folder fsync failed"));
    await expect(store.rename(original.folders[0]!.id, "Not saved")).rejects.toThrow("folder fsync failed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(await store.get()).toEqual(original);
    expect(readdirSync(dir)).toEqual(["chat-folders.json"]);
    expect((await store.rename(original.folders[0]!.id, "Retry succeeds")).folders[0]!.name).toBe("Retry succeeds");
  });

  it.each([
    "{broken json",
    JSON.stringify({ version: 2, folders: [], assignments: {} }),
    JSON.stringify({ version: 1, revision: -1, folders: [], assignments: {} }),
    JSON.stringify({ version: 1, folders: [], assignments: { "chat-a": "missing" } }),
    '{"version":1,"folders":[],"assignments":{"__proto__":"folder"}}',
    JSON.stringify({ version: 1, folders: [{ id: "folder", name: "Name", createdAt: 1 }, { id: "folder", name: "Duplicate", createdAt: 2 }], assignments: {} }),
  ])("blocks reads and writes to a corrupt record without overwriting it", async (text) => {
    const path = join(dir, "chat-folders.json");
    writeFileSync(path, text);
    await expect(store.get()).rejects.toThrow("Saved chat folders are invalid");
    await expect(store.create("Do not replace")).rejects.toThrow("Saved chat folders are invalid");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(dir)).toEqual(["chat-folders.json"]);
  });

  it("does not treat other filesystem read failures as an empty store", async () => {
    mkdirSync(join(dir, "chat-folders.json"));
    await expect(store.get()).rejects.toMatchObject({ code: "EISDIR" });
    await expect(store.create("Must not replace the unreadable record")).rejects.toMatchObject({ code: "EISDIR" });
    expect(readdirSync(dir)).toEqual(["chat-folders.json"]);
  });

  it("validates names and destination IDs before changing a valid record", async () => {
    const original = await store.create("Keep");
    for (const name of ["", "  ", "a".repeat(101), "line\nbreak"]) {
      await expect(store.create(name)).rejects.toMatchObject({ code: "bad-request" });
    }
    for (const id of ["__proto__", "constructor", "prototype", "../outside"]) {
      await expect(store.move(id, original.folders[0]!.id)).rejects.toMatchObject({ code: "bad-request" });
    }
    await expect(store.move("chat-a", "missing")).rejects.toMatchObject({ code: "not-found" });
    await expect(store.rename("missing", "Name")).rejects.toMatchObject({ code: "not-found" });
    await expect(store.delete("missing")).rejects.toMatchObject({ code: "not-found" });
    expect(await store.get()).toEqual(original);
  });

  it("limits new folders without losing an existing full record", async () => {
    const full = { version: 1, revision: 0, folders: Array.from({ length: 200 }, (_, index) => ({ id: `folder-${index}`, name: `Folder ${index}`, createdAt: index })), assignments: {} };
    writeFileSync(join(dir, "chat-folders.json"), JSON.stringify(full));
    await expect(store.create("One too many")).rejects.toMatchObject({ code: "bad-request" });
    expect(await store.get()).toEqual(full);
    expect((await store.rename("folder-0", "Renaming still works")).folders[0]!.name).toBe("Renaming still works");
  });
});
