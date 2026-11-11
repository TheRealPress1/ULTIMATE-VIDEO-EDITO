/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One folder per chat under the data dir: `meta.json` (the summary plus
// the cwd and the resume cursor, written whole through a temp file) and
// `events.jsonl` (append-only; no deltas). There is no index: listing
// reads every meta, which is cheap at hundreds of chats and can never go
// out of sync.

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { emptyTranscript, reduce } from "../reduce";

import type { ChatEvent, ChatSummary } from "../protocol";
import type { Transcript } from "../reduce";
import type { ResumeCursor } from "./harness";

export type ChatMeta = ChatSummary & {
  cwd: string;
  resume: ResumeCursor | null;
  /** A fingerprint of the instructions the chat's agent was last told, so a later app can tell it what changed. */
  instructionsHash?: string;
};
type PendingEvent = { bytes: Buffer; written?: { offset: number; ino: number; dev: number } };

export class ChatStore {
  readonly dataDir: string;
  private readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();
  /** Failed appends stay in order until a later append or metadata save retries them. */
  private readonly pendingEvents = new Map<string, PendingEvent[]>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.root = join(dataDir, "chats");
  }

  private dir(chatId: string): string {
    return join(this.root, chatId);
  }

  /** Every chat's meta, whatever its project; unreadable ones are skipped. */
  async list(): Promise<ChatMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const metas = await Promise.all(entries.map((id) => this.readMeta(id)));
    return metas.filter((meta): meta is ChatMeta => meta !== null);
  }

  async readMeta(chatId: string): Promise<ChatMeta | null> {
    try {
      const raw = await readFile(join(this.dir(chatId), "meta.json"), "utf8");
      const meta = JSON.parse(raw) as ChatMeta;
      return meta && typeof meta.id === "string" ? meta : null;
    } catch {
      return null;
    }
  }

  /** Durable replacement: sync the complete file, rename, then sync its directories. */
  writeMeta(meta: ChatMeta): Promise<void> {
    return this.serialize(meta.id, async () => {
      const dir = this.dir(meta.id);
      await mkdir(dir, { recursive: true });
      await this.flushEvents(meta.id);
      const tmp = join(dir, `meta.json.${randomUUID()}.tmp`);
      try {
        const file = await open(tmp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(meta), "utf8"); await file.sync(); }
        finally { await file.close(); }
        await rename(tmp, join(dir, "meta.json"));
        // Include parent entries so a newly created chat survives a crash too.
        for (const path of [dir, this.root, dirname(this.root)]) await syncDirectory(path);
      } finally { await rm(tmp, { force: true }); }
    });
  }

  append(chatId: string, event: ChatEvent): Promise<void> {
    return this.serialize(chatId, async () => {
      const pending = this.pendingEvents.get(chatId) ?? [];
      pending.push({ bytes: Buffer.from(JSON.stringify(event) + "\n", "utf8") });
      this.pendingEvents.set(chatId, pending);
      await this.flushEvents(chatId);
    });
  }

  private async flushEvents(chatId: string): Promise<void> {
    const pending = this.pendingEvents.get(chatId);
    if (!pending?.length) return;
    await mkdir(this.dir(chatId), { recursive: true });
    const file = await open(join(this.dir(chatId), "events.jsonl"), "a+");
    try {
      while (pending.length) {
        const entry = pending[0]!;
        let stat = await file.stat();
        if (!entry.written) {
          // Preserve a crash's torn fragment, but never join a new event to it.
          if (stat.size > 0) {
            const last = Buffer.alloc(1);
            await file.read(last, 0, 1, stat.size - 1);
            if (last[0] !== 10) await file.appendFile("\n");
          }
          stat = await file.stat();
          entry.written = { offset: stat.size, ino: stat.ino, dev: stat.dev };
        }
        const { offset, ino, dev } = entry.written;
        if (stat.ino !== ino || stat.dev !== dev || stat.size < offset) {
          throw new Error("Chat history changed while a save was pending; keep the app open to preserve the unsaved history");
        }
        const count = Math.min(stat.size - offset, entry.bytes.length);
        if (count) {
          const written = Buffer.alloc(count);
          const { bytesRead } = await file.read(written, 0, count, offset);
          if (bytesRead !== count || !written.equals(entry.bytes.subarray(0, count))) {
            throw new Error("Chat history changed while a save was pending; keep the app open to preserve the unsaved history");
          }
        }
        // A write or fsync can fail after some or all bytes landed. Verify
        // exactly what is already ours, then append only the missing suffix.
        if (count < entry.bytes.length) await file.appendFile(entry.bytes.subarray(count));
        await file.sync();
        pending.shift();
      }
      this.pendingEvents.delete(chatId);
    } finally {
      await file.close();
    }
  }

  /** The transcript, folded from the log. A trailing line a crash cut short is skipped. */
  async readTranscript(chatId: string): Promise<Transcript> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir(chatId), "events.jsonl"), "utf8");
    } catch {
      return emptyTranscript();
    }
    let state = emptyTranscript();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: ChatEvent;
      try {
        event = JSON.parse(line) as ChatEvent;
      } catch {
        continue;
      }
      state = reduce(state, event);
    }
    return state;
  }

  remove(chatId: string): Promise<void> {
    return this.serialize(chatId, async () => {
      await rm(this.dir(chatId), { recursive: true, force: true });
      this.pendingEvents.delete(chatId);
    });
  }

  /** Writes to one chat happen in order, so an append never overtakes the meta it belongs with. */
  private serialize(chatId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.writes.set(chatId, next);
    next.finally(() => {
      if (this.writes.get(chatId) === next) this.writes.delete(chatId);
    }).catch(() => {});
    return next;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
