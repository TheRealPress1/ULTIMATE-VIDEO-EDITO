/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Checkpoints cover composition source, never footage or the asset library.
// They live outside the project so agent cleanup cannot accidentally erase them.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EditReview, SourceChange } from "../protocol";
import { comparableSource } from "./source-comparison";

type SourceFile = { data: string; mode: number };
type Snapshot = Record<string, SourceFile>;
export type Checkpoint = {
  id: string;
  projectId: string;
  cwd: string;
  prompt: string;
  createdAt: number;
  before: Snapshot;
  after: Snapshot | null;
  undone: boolean;
  recovered?: boolean;
};
const SOURCE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css", ".yaml", ".yml", ".srt", ".vtt"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "assets", "media", "footage", "exports", "dist", "build", "coverage", "cache"]);
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_STORED_BYTES = 60 * 1024 * 1024;
type RestoreJournal = {
  version: 1;
  projectId: string;
  checkpointId: string;
  cwd: string;
  direction: "undo" | "redo";
  files: Record<string, { before?: SourceFile; after?: SourceFile }>;
};
const same = (a?: SourceFile, b?: SourceFile): boolean => a?.data === b?.data && a?.mode === b?.mode;
const equivalent = (path: string, a?: SourceFile, b?: SourceFile): boolean => same(a, b) || !!a && !!b && a.mode === b.mode &&
  comparableSource(path, Buffer.from(a.data, "base64").toString("utf8")) === comparableSource(path, Buffer.from(b.data, "base64").toString("utf8"));
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

function sourcePath(path: string): boolean {
  const parts = path.split("/");
  return !isAbsolute(path) && !/^[a-z]:/i.test(path) && !path.includes("\0") && !path.includes("\\") && parts.every((part) => part && part !== ".." && !part.startsWith(".")) &&
    !parts.slice(0, -1).some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase())) &&
    path !== "assets.yml" && SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function snapshot(cwd: string): Promise<Snapshot> {
  const files: Snapshot = {};
  let total = 0;
  let directories = 0;
  async function visit(folder: string, prefix = ""): Promise<void> {
    if (++directories > 2000 || prefix.split("/").length > 32) throw new Error("This project exceeds the checkpoint folder limit (2,000 folders / 32 levels). Move unrelated files out of the project.");
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
        await visit(join(folder, entry.name), path);
      } else if (sourcePath(path)) {
        const file = join(cwd, path);
        const stat = await lstat(file);
        if (stat.isSymbolicLink()) throw new Error(`Cannot checkpoint linked source file: ${path}`);
        if (!stat.isFile()) continue;
        total += stat.size;
        if (stat.size > MAX_FILE_BYTES || total > MAX_BYTES || Object.keys(files).length >= MAX_FILES) {
          throw new Error("This project's source exceeds the checkpoint limit (500 files / 20 MB). Media is excluded.");
        }
        const data = await readFile(file);
        // Do not accept files that grew past the limit while being read.
        if (data.length !== stat.size) throw new Error(`Source changed while creating a checkpoint: ${path}. Try again.`);
        files[path] = { data: data.toString("base64"), mode: stat.mode & 0o777 };
      }
    }
  }
  await visit(cwd);
  return files;
}

function changed(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => !equivalent(path, before[path], after[path])).sort();
}

function change(path: string, before?: SourceFile, after?: SourceFile): SourceChange {
  const a = before ? Buffer.from(before.data, "base64").toString("utf8") : "";
  const b = after ? Buffer.from(after.data, "base64").toString("utf8") : "";
  const left = a.split("\n");
  const right = b.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++;
  const oldText = left.slice(Math.max(0, start - 2), left.length - end + 2).join("\n");
  const newText = right.slice(Math.max(0, start - 2), right.length - end + 2).join("\n");
  return {
    path,
    kind: !before ? "added" : !after ? "removed" : "modified",
    before: oldText.slice(0, 4000),
    after: newText.slice(0, 4000),
    truncated: oldText.length > 4000 || newText.length > 4000,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateSource(value: unknown): asserts value is SourceFile {
  if (!record(value) || typeof value.data !== "string" || !Number.isInteger(value.mode) ||
    (value.mode as number) < 0 || (value.mode as number) > 0o777 ||
    value.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
    Buffer.from(value.data, "base64").length > MAX_FILE_BYTES ||
    Buffer.from(value.data, "base64").toString("base64") !== value.data) {
    throw new Error("The saved agent checkpoint contains invalid source data. Its recovery files were preserved.");
  }
}

function validateSnapshot(value: unknown): asserts value is Snapshot {
  if (!record(value) || Object.keys(value).length > MAX_FILES) throw new Error("The saved agent checkpoint has an invalid source snapshot. Its recovery files were preserved.");
  let total = 0;
  for (const [path, source] of Object.entries(value)) {
    if (!sourcePath(path)) throw new Error("The checkpoint contains an invalid source path.");
    validateSource(source);
    total += Buffer.from(source.data, "base64").length;
    if (total > MAX_BYTES) throw new Error("The saved agent checkpoint exceeds the source limit. Its recovery files were preserved.");
  }
}

function validateCheckpoint(value: unknown, projectId: string): asserts value is Checkpoint {
  if (!record(value) || value.projectId !== projectId || typeof value.id !== "string" || !value.id ||
    typeof value.cwd !== "string" || !isAbsolute(value.cwd) || typeof value.prompt !== "string" ||
    typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || typeof value.undone !== "boolean" ||
    (value.recovered !== undefined && typeof value.recovered !== "boolean")) {
    throw new Error("The saved agent checkpoint is damaged. Its recovery files were preserved.");
  }
  validateSnapshot(value.before);
  if (value.after !== null) validateSnapshot(value.after);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function atomicWrite(path: string, data: string | Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.cutroom-checkpoint-${randomUUID()}.tmp`);
  try {
    const file = await open(tmp, "wx", mode);
    try { await file.writeFile(data); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } finally { await rm(tmp, { force: true }); }
}

export class CheckpointStore {
  private readonly root: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(dataDir: string) { this.root = join(dataDir, "source-checkpoints"); }
  private path(projectId: string): string { return join(this.root, `${createHash("sha256").update(projectId).digest("hex")}.json`); }

  private async serialized<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(projectId, next);
    try { return await next; }
    finally { if (this.queues.get(projectId) === next) this.queues.delete(projectId); }
  }

  private async save(checkpoint: Checkpoint, pending = false): Promise<void> {
    validateCheckpoint(checkpoint, checkpoint.projectId);
    await atomicWrite(this.path(checkpoint.projectId) + (pending ? ".pending" : ""), JSON.stringify(checkpoint), 0o600);
  }

  private async readJson(path: string): Promise<unknown | undefined> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORED_BYTES) throw new Error("The saved agent recovery file is invalid. It was preserved.");
      const data = await readFile(path);
      if (data.length > MAX_STORED_BYTES) throw new Error("The saved agent recovery file exceeds the size limit. It was preserved.");
      return JSON.parse(data.toString("utf8"));
    } catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
  }

  private async read(projectId: string, pending = false): Promise<Checkpoint | null> {
    const checkpoint = await this.readJson(this.path(projectId) + (pending ? ".pending" : ""));
    if (checkpoint === undefined) return null;
    validateCheckpoint(checkpoint, projectId);
    if (!pending && checkpoint.after === null) throw new Error("The saved agent checkpoint is incomplete. Its recovery files were preserved.");
    return checkpoint;
  }

  private async remove(path: string): Promise<void> {
    await rm(path, { force: true });
    await syncDirectory(dirname(path));
  }

  /** Call before accepting turns after a restart. Never use this on an active turn. */
  async recover(projectId: string, cwd?: string): Promise<void> {
    await this.serialized(projectId, () => this.recoverPending(projectId, cwd));
  }

  private async recoverPending(projectId: string, cwd?: string): Promise<void> {
    await this.recoverRestore(projectId, cwd);
    const pending = await this.read(projectId, true);
    if (!pending) return;
    // A finish can commit successfully and crash before unlinking its pending
    // file. Do not replace the committed after-state with later manual edits.
    const committed = await this.read(projectId);
    if (committed?.id === pending.id) {
      await this.remove(this.path(projectId) + ".pending");
      return;
    }
    pending.cwd = await realpath(cwd ?? pending.cwd);
    pending.after = await snapshot(pending.cwd);
    pending.recovered = true;
    if (changed(pending.before, pending.after).length) await this.save(pending);
    await this.remove(this.path(projectId) + ".pending");
  }

  async begin(projectId: string, cwd: string, prompt: string): Promise<Checkpoint | null> {
    return this.serialized(projectId, async () => {
      await this.recoverPending(projectId, cwd);
      // Nonexistent folders are used by generic chat clients; an actual editor
      // project always exists. Never create a project folder as a side effect.
      try { cwd = await realpath(cwd); }
      catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
      const checkpoint: Checkpoint = { id: randomUUID(), projectId, cwd, prompt: prompt.slice(0, 300), createdAt: Date.now(), before: await snapshot(cwd), after: null, undone: false };
      await this.save(checkpoint, true);
      return checkpoint;
    });
  }

  async finish(checkpoint: Checkpoint): Promise<void> {
    await this.serialized(checkpoint.projectId, async () => {
      const pending = await this.read(checkpoint.projectId, true);
      if (!pending || pending.id !== checkpoint.id) throw new Error("This agent edit is no longer the pending checkpoint. Its review was left untouched.");
      // Give the renderer time to stamp newly generated JSX and flush view
      // state. Bounded even if playback or another editor keeps writing.
      await new Promise((resolve) => setTimeout(resolve, 400));
      let latest = await snapshot(checkpoint.cwd);
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const next = await snapshot(checkpoint.cwd);
        const stable = Object.keys(latest).length === Object.keys(next).length && Object.keys(latest).every((path) => same(latest[path], next[path]));
        latest = next;
        if (stable) break;
      }
      checkpoint.after = latest;
      // A read-only question should not erase the last useful Undo.
      if (changed(checkpoint.before, latest).length) await this.save(checkpoint);
      await this.remove(this.path(checkpoint.projectId) + ".pending");
    });
  }

  async review(projectId: string): Promise<EditReview | null> {
    const checkpoint = await this.read(projectId);
    if (!checkpoint?.after) return null;
    const paths = changed(checkpoint.before, checkpoint.after);
    if (!paths.length) return null;
    return {
      id: checkpoint.id,
      prompt: checkpoint.prompt,
      createdAt: checkpoint.createdAt,
      undone: checkpoint.undone,
      ...(checkpoint.recovered ? { recovered: true } : {}),
      changes: paths.map((path) => change(path, checkpoint.before[path], checkpoint.after![path])),
    };
  }

  /** Optimistic concurrency: a later manual edit always wins over Undo. */
  async restore(projectId: string, id: string, cwd: string, direction: "undo" | "redo"): Promise<EditReview | null> {
    return this.serialized(projectId, async () => {
      await this.recoverPending(projectId, cwd);
      const checkpoint = await this.read(projectId);
      if (!checkpoint?.after || checkpoint.id !== id) throw new Error("This edit is no longer the latest checkpoint. Refresh the review.");
      if (checkpoint.undone === (direction === "undo")) throw new Error(`This edit is already ${checkpoint.undone ? "undone" : "applied"}.`);
      cwd = await realpath(cwd);
      const expected = checkpoint.undone ? checkpoint.before : checkpoint.after;
      const target = checkpoint.undone ? checkpoint.after : checkpoint.before;
      const actual = await snapshot(cwd);
      if (changed(expected, actual).length) throw new Error("The composition has changed since this agent edit. Undo was left untouched to preserve your newer edits.");
      const paths = changed(expected, target);
      const files: RestoreJournal["files"] = {};
      for (const path of paths) {
        await this.checkParents(cwd, path);
        files[path] = { before: actual[path], after: target[path] };
      }
      const journal: RestoreJournal = { version: 1, projectId, checkpointId: id, cwd, direction, files };
      const journalPath = this.path(projectId) + ".restore";
      // This receipt reaches disk before the first source mutation. A restart
      // can complete rollback even when the process died between source files.
      await atomicWrite(journalPath, JSON.stringify(journal), 0o600);
      try {
        for (const path of paths) {
          await this.checkParents(cwd, path);
          if (!same(await this.readSource(cwd, path), actual[path])) throw new Error(`Source changed while restoring: ${path}. Your newer edit was preserved.`);
          await this.writeSource(cwd, path, target[path]);
        }
        checkpoint.undone = direction === "undo";
        checkpoint.cwd = cwd;
        await this.save(checkpoint);
      } catch (error) {
        // The journal remains if rollback encounters a newer external edit or
        // another I/O error. Never silently discard the recovery information.
        try { await this.recoverRestore(projectId, cwd); }
        catch (recoveryError) { throw new Error(`${(error as Error).message} Recovery is still pending: ${(recoveryError as Error).message}`); }
        throw error;
      }
      await this.remove(journalPath);
      return this.review(projectId);
    });
  }

  private async recoverRestore(projectId: string, movedCwd?: string): Promise<void> {
    const journalPath = this.path(projectId) + ".restore";
    const value = await this.readJson(journalPath);
    if (value === undefined) return;
    if (!record(value) || value.version !== 1 || value.projectId !== projectId || typeof value.cwd !== "string" ||
      !isAbsolute(value.cwd) || typeof value.checkpointId !== "string" ||
      (value.direction !== "undo" && value.direction !== "redo") || !record(value.files) || Object.keys(value.files).length > MAX_FILES * 2) {
      throw new Error("The agent restore journal is damaged. Its recovery files were preserved.");
    }
    const checkpoint = await this.read(projectId);
    if (!checkpoint?.after || checkpoint.id !== value.checkpointId) throw new Error("The agent restore journal does not match its checkpoint. Its recovery files were preserved.");
    const target = value.direction === "undo" ? checkpoint.before : checkpoint.after;
    const expected = value.direction === "undo" ? checkpoint.after : checkpoint.before;
    const paths = changed(expected, target);
    if (Object.keys(value.files).length !== paths.length) throw new Error("The agent restore journal has an invalid file list. Its recovery files were preserved.");
    for (const path of paths) {
      const entry = value.files[path];
      if (!sourcePath(path) || !record(entry)) throw new Error("The agent restore journal contains an invalid source path.");
      if (entry.before !== undefined) validateSource(entry.before);
      if (entry.after !== undefined) validateSource(entry.after);
      if (!equivalent(path, entry.before as SourceFile | undefined, expected[path]) || !same(entry.after as SourceFile | undefined, target[path])) {
        throw new Error("The agent restore journal contains unexpected source data. Its recovery files were preserved.");
      }
    }
    // A committed checkpoint is the transaction's completion marker. Later
    // edits must survive cleanup of a receipt left behind after that commit.
    if (checkpoint.undone === (value.direction === "undo")) {
      await this.remove(journalPath);
      return;
    }
    const journal = value as unknown as RestoreJournal;
    const cwd = await realpath(movedCwd ?? journal.cwd);
    for (const path of paths) {
      await this.checkParents(cwd, path);
      const current = await this.readSource(cwd, path);
      const entry = journal.files[path]!;
      if (!same(current, entry.before) && !same(current, entry.after)) {
        throw new Error(`Cannot finish recovering ${path}: it has a newer edit. Your source and the recovery journal were preserved.`);
      }
    }
    for (const path of paths) {
      await this.checkParents(cwd, path);
      const current = await this.readSource(cwd, path);
      const entry = journal.files[path]!;
      if (same(current, entry.before)) continue;
      if (!same(current, entry.after)) throw new Error(`Source changed while recovering ${path}. Your source and the recovery journal were preserved.`);
      await this.writeSource(cwd, path, entry.before);
    }
    await this.remove(journalPath);
  }

  private async checkParents(cwd: string, path: string): Promise<void> {
    if (!sourcePath(path)) throw new Error("The checkpoint contains an invalid source path.");
    let parent = dirname(join(cwd, path));
    while (parent !== cwd) {
      const rel = relative(cwd, parent);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("The checkpoint points outside this project.");
      try { if (!(await lstat(parent)).isDirectory()) throw new Error(`Cannot restore through a linked or non-directory folder: ${path}`); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      parent = dirname(parent);
    }
  }

  private async readSource(cwd: string, path: string): Promise<SourceFile | undefined> {
    try {
      const file = join(cwd, path);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error(`Cannot restore linked or invalid source file: ${path}`);
      return { data: (await readFile(file)).toString("base64"), mode: stat.mode & 0o777 };
    } catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
  }

  private async writeSource(cwd: string, path: string, source?: SourceFile): Promise<void> {
    const file = resolve(cwd, path);
    if (!source) { await this.remove(file); return; }
    await atomicWrite(file, Buffer.from(source.data, "base64"), source.mode);
  }
}
