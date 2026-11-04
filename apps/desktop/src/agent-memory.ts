/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What agents remember about the user between chats: two short lists in the
// app's data (`agent-memory/memory.json`), which only the `memory` tool and
// Settings write. Agents cannot reach the file any other way: their file
// tools and shells may not write outside the project. Every write is checked
// whole (safety, budget, revision) before anything lands, the version it
// replaces is kept in `history/`, and a file that cannot be read is never
// overwritten.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DapiError,
  MEMORY_BATCH_MAX,
  MEMORY_ENTRY_ID,
  MEMORY_ENTRY_MAX,
  MEMORY_HISTORY_MAX,
  MEMORY_LIMITS,
  MEMORY_TARGETS,
  MemoryDocumentSchema,
  scanMemoryText,
} from "@diffusionstudio/dapi";

import type { MemoryDocument, MemoryEntry, MemoryTarget, ToolArgs, ToolOutput } from "@diffusionstudio/dapi";
import type { AgentMemoryApply, AgentMemoryHistoryItem, AgentMemorySnapshot, AgentMemoryUsage } from "./agent-memory-types";

type Origin = MemoryEntry["origin"];
type MemoryEntryOut = NonNullable<ToolOutput<"memory">["profile"]>[number];
type Change = { action: "add" | "replace" | "remove"; target: MemoryTarget; text?: string; match?: string };
type Lists = Pick<MemoryDocument, MemoryTarget>;
type Outcome =
  | { ok: true; lists: Lists; changed: boolean; notes: string[]; replaced?: string; removed: string[] }
  | { ok: false; message: string };

export const EMPTY_MEMORY: MemoryDocument = Object.freeze({ version: 1, enabled: true, revision: 0, profile: [], setup: [], updatedAt: null }) as MemoryDocument;

const UNREADABLE = "Cutroom's saved agent memory (agent-memory/memory.json in the app's data) could not be read, so it has not been changed. Move that file aside to start over.";
const HISTORY_FILE = /^(\d{6,})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

const count = (n: number) => n.toLocaleString("en-US");

/** Orders history file names by the time in them, then by revision. */
function byReplacedAt(a: string, b: string): number {
  const [, revisionA, timeA] = HISTORY_FILE.exec(a)!;
  const [, revisionB, timeB] = HISTORY_FILE.exec(b)!;
  return timeA! < timeB! ? -1 : timeA! > timeB! ? 1 : Number(revisionA) - Number(revisionB);
}

export function memoryUsage(lists: Lists): Record<MemoryTarget, AgentMemoryUsage> {
  const usage = (target: MemoryTarget): AgentMemoryUsage => ({
    chars: lists[target].reduce((sum, entry) => sum + entry.text.length, 0),
    limit: MEMORY_LIMITS[target].chars,
    entries: lists[target].length,
    maxEntries: MEMORY_LIMITS[target].entries,
  });
  return { profile: usage("profile"), setup: usage("setup") };
}

/** The entry text to store, or why it may not be saved. */
function cleanText(text: string | undefined): { ok: true; text: string } | { ok: false; message: string } {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: false, message: "An entry needs some text." };
  if (trimmed.length > MEMORY_ENTRY_MAX) return { ok: false, message: `An entry holds at most ${MEMORY_ENTRY_MAX} characters; split it or shorten it.` };
  const scan = scanMemoryText(trimmed);
  return scan.ok ? { ok: true, text: scan.text } : { ok: false, message: scan.message };
}

const sameText = (a: string, b: string) => a.normalize("NFC").trim().toLowerCase() === b.normalize("NFC").trim().toLowerCase();

/** The safety category an entry fails today, or null when agents may see it. */
const withheldAs = (entry: MemoryEntry) => {
  const scan = scanMemoryText(entry.text);
  return scan.ok ? null : scan.category;
};

/** Entries as an agent gets them: a withheld one keeps its id and loses its text. */
function forAgents(list: readonly MemoryEntry[]): MemoryEntryOut[] {
  return list.map((entry) => {
    const withheld = withheldAs(entry);
    if (!withheld) return { ...entry };
    const { text: _text, ...rest } = entry;
    return { ...rest, withheld };
  });
}

/**
 * Which entry `match` names: an id, or a part of the text found in exactly
 * one entry. Withheld entries answer to their id only, so a guessed
 * fragment can't reveal what they say.
 */
function resolveMatch(list: readonly MemoryEntry[], target: MemoryTarget, match: string | undefined): number | string {
  const wanted = (match ?? "").trim();
  if (!wanted) return `Say which ${target} entry to change: its id or a part of its text.`;
  if (MEMORY_ENTRY_ID.test(wanted)) {
    const index = list.findIndex((entry) => entry.id === wanted);
    return index >= 0 ? index : `No ${target} entry has the id ${wanted}.`;
  }
  const needle = wanted.normalize("NFC").toLowerCase();
  const hits = list.flatMap((entry, index) => (!withheldAs(entry) && entry.text.normalize("NFC").toLowerCase().includes(needle) ? [index] : []));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) return `No ${target} entry contains that text. Use an id from the entries returned.`;
  return `That text is in ${hits.length} ${target} entries (${hits.map((index) => list[index]!.id).join(", ")}). Pass one entry's id instead.`;
}

function newId(lists: Lists): string {
  const taken = new Set([...lists.profile, ...lists.setup].map((entry) => entry.id));
  for (let bytes = 2; ; bytes += 1) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = `m_${randomBytes(bytes).toString("hex")}`;
      if (!taken.has(id)) return id;
    }
  }
}

/**
 * Applies `changes` in order to a copy of the lists, all or none. Each text
 * is checked as it comes; the budget only once every change is in, so a
 * batch may free room before it uses it.
 */
export function applyMemoryChanges(doc: Lists, changes: readonly Change[], origin: Origin, now: string): Outcome {
  const lists: Lists = { profile: [...doc.profile], setup: [...doc.setup] };
  const notes: string[] = [];
  const removed: string[] = [];
  let replaced: string | undefined;
  let changed = false;
  for (const [index, change] of changes.entries()) {
    const fail = (message: string): Outcome => ({ ok: false, message: changes.length > 1 ? `Change ${index + 1}: ${message}` : message });
    const list = lists[change.target];
    if (change.action === "add") {
      const text = cleanText(change.text);
      if (!text.ok) return fail(text.message);
      const existing = list.find((entry) => sameText(entry.text, text.text));
      if (existing) { notes.push(`Already saved as ${existing.id}.`); continue; }
      const id = newId(lists);
      list.push({ id, text: text.text, updatedAt: now, origin });
      notes.push(`Added ${id} to ${change.target}.`);
      changed = true;
      continue;
    }
    const at = resolveMatch(list, change.target, change.match);
    if (typeof at === "string") return fail(at);
    const entry = list[at]!;
    if (change.action === "remove") {
      list.splice(at, 1);
      if (!withheldAs(entry)) removed.push(entry.text);
      notes.push(`Removed ${entry.id} from ${change.target}.`);
      changed = true;
      continue;
    }
    const text = cleanText(change.text);
    if (!text.ok) return fail(text.message);
    if (entry.text === text.text) { notes.push(`${entry.id} already says that.`); continue; }
    list[at] = { ...entry, text: text.text, updatedAt: now, origin };
    replaced = withheldAs(entry) ? undefined : entry.text;
    notes.push(`Replaced ${entry.id} in ${change.target}.`);
    changed = true;
  }
  const over = overBudget(lists);
  if (over) return { ok: false, message: over };
  return { ok: true, lists, changed, notes, replaced, removed };
}

/** Why the lists do not fit their budgets; null when they do. */
function overBudget(lists: Lists): string | null {
  const usage = memoryUsage(lists);
  for (const target of MEMORY_TARGETS) {
    const { chars, limit, entries, maxEntries } = usage[target];
    if (chars > limit) {
      return `The ${target} list would hold ${count(chars)} of its ${count(limit)} characters, so nothing was saved. Make room in the same call: an \`apply\` whose first operations merge or delete older entries and whose last adds this one.`;
    }
    if (entries > maxEntries) {
      return `The ${target} list would hold ${entries} entries, more than its ${maxEntries}, so nothing was saved. Fold related entries together in an \`apply\` that also makes this change.`;
    }
  }
  return null;
}

/** The tool's changes from its arguments, or why they are incomplete. */
function changesFrom(args: ToolArgs<"memory">): Change[] {
  const need = (condition: unknown, message: string) => { if (!condition) throw new DapiError("invalid-input", message); };
  if (args.action === "apply") {
    need(args.operations?.length, "apply needs `operations`: up to 12 changes, each with its action.");
    return args.operations!.map((operation, index) => {
      const target = operation.target ?? args.target;
      need(target, `Operation ${index + 1} needs a \`target\` (profile or setup), on it or on the call.`);
      need(operation.action === "remove" || operation.text, `Operation ${index + 1} (${operation.action}) needs \`text\`, the complete entry.`);
      need(operation.action === "add" || operation.match, `Operation ${index + 1} (${operation.action}) needs \`match\`: an entry id or a unique part of its text.`);
      return { action: operation.action, target: target!, text: operation.text, match: operation.match };
    });
  }
  need(args.target, `${args.action} needs a \`target\`: profile or setup.`);
  need(args.action === "remove" || args.text, `${args.action} needs \`text\`, the complete entry.`);
  need(args.action === "add" || args.match, `${args.action} needs \`match\`: an entry id or a unique part of its text.`);
  return [{ action: args.action as Change["action"], target: args.target!, text: args.text, match: args.match }];
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
    if (process.platform !== "win32") {
      const folder = await open(dirname(path), "r");
      try { await folder.sync(); } finally { await folder.close(); }
    }
  } finally { await unlink(temp).catch(() => {}); }
}

export type AgentMemoryStoreOptions = {
  /** For tests. */
  now?: () => Date;
};

export class AgentMemoryStore {
  readonly file: string;
  private readonly historyDir: string;
  private readonly now: () => Date;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(file: string, options: AgentMemoryStoreOptions = {}) {
    this.file = file;
    this.historyDir = join(dirname(file), "history");
    this.now = options.now ?? (() => new Date());
  }

  /** The saved document; an empty one before the first save. Throws rather than guess when the file is damaged. */
  async read(): Promise<MemoryDocument> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_MEMORY, profile: [], setup: [] };
      throw new Error(UNREADABLE, { cause: error });
    }
    try {
      return MemoryDocumentSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new Error(UNREADABLE, { cause: error });
    }
  }

  /** The `memory` tool. */
  async tool(args: ToolArgs<"memory">): Promise<ToolOutput<"memory">> {
    if (args.action === "view") {
      const doc = await this.read();
      const usage = memoryUsage(doc);
      if (!doc.enabled) return { ok: true, enabled: false, revision: doc.revision, message: "Memory is paused in Cutroom's Settings: agents neither read nor save it until the user turns it back on.", usage, appliesFrom: "next-session" };
      const total = doc.profile.length + doc.setup.length;
      const message = total
        ? `${doc.profile.length} profile and ${doc.setup.length} setup ${total === 1 ? "entry" : "entries"} at revision ${doc.revision}.`
        : "Nothing is saved yet.";
      const held = [...doc.profile, ...doc.setup].filter((entry) => withheldAs(entry)).length;
      const note = !held ? "" : held === 1
        ? " One fails Cutroom's safety check, so its text is left out (`withheld`); the user can review it in Settings, and you can remove it by id when asked."
        : ` ${held} fail Cutroom's safety check, so their text is left out (\`withheld\`); the user can review them in Settings, and you can remove them by id when asked.`;
      return { ok: true, enabled: true, revision: doc.revision, message: message + note, profile: forAgents(doc.profile), setup: forAgents(doc.setup), usage, appliesFrom: "next-session" };
    }
    const changes = changesFrom(args);
    if (changes.length > MEMORY_BATCH_MAX) throw new DapiError("invalid-input", `apply takes at most ${MEMORY_BATCH_MAX} changes.`);
    return this.serialize(async () => {
      const doc = await this.read();
      const refuse = (message: string): ToolOutput<"memory"> => ({
        ok: false, enabled: doc.enabled, revision: doc.revision, message, usage: memoryUsage(doc), appliesFrom: "next-session",
        ...(doc.enabled ? { profile: forAgents(doc.profile), setup: forAgents(doc.setup) } : {}),
      });
      if (!doc.enabled) return refuse("Memory is paused in Cutroom's Settings, so nothing was saved. The user can turn it back on under What agents remember.");
      if (args.expectedRevision !== undefined && args.expectedRevision !== doc.revision) {
        return refuse(`Memory changed since revision ${args.expectedRevision}; it is now at revision ${doc.revision}. Nothing was saved: review the entries returned and retry.`);
      }
      const outcome = applyMemoryChanges(doc, changes, "agent", this.now().toISOString());
      if (!outcome.ok) return refuse(outcome.message);
      const saved = outcome.changed ? await this.commit(doc, { ...doc, ...outcome.lists }) : doc;
      return {
        ok: true, enabled: true, revision: saved.revision,
        message: `${outcome.notes.join(" ")}${outcome.changed ? " New sessions will see it." : ""}`.trim(),
        usage: memoryUsage(saved), appliesFrom: "next-session",
        ...(outcome.replaced !== undefined ? { replaced: outcome.replaced } : {}),
        ...(outcome.removed.length ? { removed: outcome.removed } : {}),
      };
    });
  }

  /** Settings' view: every entry, the ones a session would not be shown flagged, and the kept versions. */
  async snapshot(): Promise<AgentMemorySnapshot> {
    const doc = await this.read();
    const view = (entry: MemoryEntry) => {
      const withheld = withheldAs(entry);
      return withheld ? { ...entry, withheld } : { ...entry };
    };
    return {
      available: true, enabled: doc.enabled, revision: doc.revision, updatedAt: doc.updatedAt,
      profile: doc.profile.map(view), setup: doc.setup.map(view), usage: memoryUsage(doc),
      entryMax: MEMORY_ENTRY_MAX, history: await this.history(),
    };
  }

  /** What Settings changes: entries, the pause switch, or a whole earlier version. */
  apply(request: AgentMemoryApply): Promise<AgentMemorySnapshot> {
    return this.serialize(async () => {
      const doc = await this.read();
      if (request.expectedRevision !== doc.revision) {
        throw new DapiError("busy", "Memory changed while you were editing it (an agent may have saved something). Review the latest entries and try again.");
      }
      if (request.kind === "edit") {
        const outcome = applyMemoryChanges(doc, request.operations, "settings", this.now().toISOString());
        if (!outcome.ok) throw new DapiError("invalid-input", outcome.message);
        if (outcome.changed) await this.commit(doc, { ...doc, ...outcome.lists });
      } else if (request.kind === "enabled") {
        if (doc.enabled !== request.enabled) await this.commit(doc, { ...doc, enabled: request.enabled });
      } else {
        const earlier = await this.readHistory(request.historyId);
        const over = overBudget(earlier);
        if (over) throw new DapiError("invalid-input", "That version no longer fits memory's budget, so it was not restored.");
        await this.commit(doc, { ...doc, profile: earlier.profile, setup: earlier.setup });
      }
      return this.snapshot();
    });
  }

  /** The kept versions, newest first. */
  async history(): Promise<AgentMemoryHistoryItem[]> {
    const names = await this.historyNames();
    const items = await Promise.all(names.reverse().map(async (name) => {
      const match = HISTORY_FILE.exec(name)!;
      const savedAt = match[2]!.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
      try {
        const doc = MemoryDocumentSchema.parse(JSON.parse(await readFile(join(this.historyDir, name), "utf8")));
        return { id: name.slice(0, -".json".length), revision: doc.revision, savedAt, entries: doc.profile.length + doc.setup.length };
      } catch {
        return null;
      }
    }));
    return items.filter((item): item is AgentMemoryHistoryItem => item !== null);
  }

  private async readHistory(id: string): Promise<MemoryDocument> {
    if (!HISTORY_FILE.test(`${id}.json`)) throw new DapiError("not-found", "That earlier version is not kept any more.");
    try {
      return MemoryDocumentSchema.parse(JSON.parse(await readFile(join(this.historyDir, `${id}.json`), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DapiError("not-found", "That earlier version is not kept any more.");
      throw new Error("That earlier version could not be read, so nothing was restored.", { cause: error });
    }
  }

  /**
   * The kept versions' file names, oldest first by when they were replaced.
   * Not by revision: a memory file moved aside starts again at revision 0,
   * and its new versions must not sort (and be pruned) before the old ones.
   */
  private async historyNames(): Promise<string[]> {
    try {
      return (await readdir(this.historyDir)).filter((name) => HISTORY_FILE.test(name)).sort(byReplacedAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Keeps the version being replaced, writes the next one whole, then trims the kept versions to the newest 50. */
  private async commit(current: MemoryDocument, next: MemoryDocument): Promise<MemoryDocument> {
    const at = this.now();
    const saved: MemoryDocument = {
      version: 1, enabled: next.enabled, revision: current.revision + 1,
      profile: next.profile, setup: next.setup, updatedAt: at.toISOString(),
    };
    let kept: string | null = null;
    if (current.revision > 0) {
      kept = `${String(current.revision).padStart(6, "0")}-${at.toISOString().replace(/[:.]/g, "-")}.json`;
      await writePrivate(join(this.historyDir, kept), JSON.stringify(current, null, 2) + "\n");
    }
    await writePrivate(this.file, JSON.stringify(saved, null, 2) + "\n");
    // The version just kept is never the one pruned, even if the clock has gone back.
    const names = await this.historyNames();
    const extra = Math.max(0, names.length - MEMORY_HISTORY_MAX);
    await Promise.all(names.filter((name) => name !== kept).slice(0, extra).map((name) => unlink(join(this.historyDir, name)).catch(() => {})));
    return saved;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.then(work);
    this.pending = run.catch(() => {});
    return run;
  }
}

/** Settings' answer when memory is off for the whole app session. */
export function unavailableMemorySnapshot(): AgentMemorySnapshot {
  return {
    available: false, enabled: false, revision: 0, updatedAt: null, profile: [], setup: [],
    usage: memoryUsage({ profile: [], setup: [] }), entryMax: MEMORY_ENTRY_MAX, history: [],
  };
}

const stores = new Map<string, AgentMemoryStore>();

/** One store per file, so the tool and Settings share one queue of writes. */
export function agentMemoryStore(file: string): AgentMemoryStore {
  let store = stores.get(file);
  if (!store) stores.set(file, (store = new AgentMemoryStore(file)));
  return store;
}

/** Whether memory is turned off for this app session (CUTROOM_MEMORY=0). */
export function memoryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CUTROOM_MEMORY === "0";
}
