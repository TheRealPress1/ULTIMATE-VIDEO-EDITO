/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ChatFolder, ChatFoldersState } from "../protocol";

const MAX_FOLDERS = 200;
const MAX_NAME_LENGTH = 100;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);

export class ChatFolderError extends Error {
  readonly code: "bad-request" | "not-found";

  constructor(code: "bad-request" | "not-found", message: string) {
    super(message);
    this.name = "ChatFolderError";
    this.code = code;
  }
}

/**
 * Sidebar organization only: assignments never change a chat's project or
 * working directory. One atomic record keeps folder changes and assignments
 * together. Deleted chats retain their assignment so restoring one restores
 * its place, unless the folder itself was subsequently removed.
 */
export class ChatFolderStore {
  private readonly dataDir: string;
  private readonly path: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.path = join(dataDir, "chat-folders.json");
  }

  get(): Promise<ChatFoldersState> {
    return this.serialize(() => this.read());
  }

  create(name: string, chatId?: string): Promise<ChatFoldersState> {
    return this.change((state) => {
      const normalized = folderName(name);
      if (chatId !== undefined) requireId(chatId, "chat");
      if (state.folders.length >= MAX_FOLDERS) {
        throw new ChatFolderError("bad-request", `You can create up to ${MAX_FOLDERS} chat folders.`);
      }
      const folder: ChatFolder = { id: randomUUID(), name: normalized, createdAt: Date.now() };
      state.folders.push(folder);
      if (chatId !== undefined) state.assignments[chatId] = folder.id;
      return true;
    });
  }

  rename(folderId: string, name: string): Promise<ChatFoldersState> {
    return this.change((state) => {
      const folder = requireFolder(state, folderId);
      const normalized = folderName(name);
      if (folder.name === normalized) return false;
      folder.name = normalized;
      return true;
    });
  }

  delete(folderId: string): Promise<ChatFoldersState> {
    return this.change((state) => {
      requireFolder(state, folderId);
      state.folders = state.folders.filter((folder) => folder.id !== folderId);
      for (const [chatId, assigned] of Object.entries(state.assignments)) {
        if (assigned === folderId) delete state.assignments[chatId];
      }
      return true;
    });
  }

  move(chatId: string, folderId: string | null): Promise<ChatFoldersState> {
    return this.change((state) => {
      requireId(chatId, "chat");
      if (folderId !== null) requireFolder(state, folderId);
      if (folderId === null) {
        if (!Object.hasOwn(state.assignments, chatId)) return false;
        delete state.assignments[chatId];
      } else {
        if (state.assignments[chatId] === folderId) return false;
        state.assignments[chatId] = folderId;
      }
      return true;
    });
  }

  private change(update: (state: ChatFoldersState) => boolean): Promise<ChatFoldersState> {
    return this.serialize(async () => {
      // Read again for each operation. Failed writes cannot leak an in-memory
      // change, and an invalid existing record must never be replaced by empty.
      const state = await this.read();
      if (update(state)) {
        if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Chat folder revision limit reached");
        state.revision += 1;
        await this.write(state);
      }
      return state;
    });
  }

  private async read(): Promise<ChatFoldersState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, folders: [], assignments: {} };
      throw error;
    }
    try {
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Folder record is too large");
      return validateState(JSON.parse(text));
    } catch (cause) {
      throw new Error("Saved chat folders are invalid. The existing record has been kept unchanged.", { cause });
    }
  }

  private async write(state: ChatFoldersState): Promise<void> {
    const text = JSON.stringify(state) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw new ChatFolderError("bad-request", "Chat folder storage is full. Remove unused folder assignments before adding more.");
    }
    await mkdir(this.dataDir, { recursive: true });
    const temporary = join(this.dataDir, `chat-folders.json.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      for (const path of [this.dataDir, dirname(this.dataDir)]) await syncDirectory(path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.pending.then(task);
    // A failure is returned to its caller but cannot poison later operations.
    this.pending = next.then(() => {}, () => {});
    return next;
  }
}

function folderName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ChatFolderError("bad-request", `Enter a folder name between 1 and ${MAX_NAME_LENGTH} characters.`);
  }
  return value.trim();
}

function requireId(value: unknown, kind: "chat" | "folder"): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value) || RESERVED_IDS.has(value)) {
    throw new ChatFolderError("bad-request", `Choose a valid ${kind}.`);
  }
}

function requireFolder(state: ChatFoldersState, id: unknown): ChatFolder {
  requireId(id, "folder");
  const folder = state.folders.find((entry) => entry.id === id);
  if (!folder) throw new ChatFolderError("not-found", "That chat folder no longer exists.");
  return folder;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateState(value: unknown): ChatFoldersState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.folders) || value.folders.length > MAX_FOLDERS || !isRecord(value.assignments)) {
    throw new Error("Invalid folder record");
  }
  const revision = value.revision === undefined ? 0 : value.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error("Invalid folder revision");
  const seen = new Set<string>();
  const folders: ChatFolder[] = value.folders.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error("Invalid folder");
    requireId(entry.id, "folder");
    if (seen.has(entry.id) || !Number.isSafeInteger(entry.createdAt) || (entry.createdAt as number) < 0) {
      throw new Error("Invalid folder identity or date");
    }
    const name = folderName(entry.name);
    if (name !== entry.name) throw new Error("Invalid folder name");
    seen.add(entry.id);
    return { id: entry.id, name, createdAt: entry.createdAt as number };
  });
  const assignments: Record<string, string> = {};
  for (const [chatId, folderId] of Object.entries(value.assignments)) {
    requireId(chatId, "chat");
    requireId(folderId, "folder");
    if (!seen.has(folderId)) throw new Error("Assignment points to a missing folder");
    assignments[chatId] = folderId;
  }
  return { version: 1, revision: revision as number, folders, assignments };
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
