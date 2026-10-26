/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { withProjectLock } from "./project-write-transactions";
import { VISUAL_ENGINE, VISUAL_MAX_SECONDS } from "./visual-types";
import { validateVisualAnalysis } from "./visual-validation";
import type { VisualIndexRequest, VisualIndexResult, VisualAnalysis } from "./visual-types";
type VisualIndexPutRequest = VisualIndexRequest & { expectedFingerprint: string; analysis: VisualAnalysis };


const MAX_INDEX_BYTES = 64 * 1024 * 1024;

const MAX_ENTRIES = 500;

const HASH = /^[a-f0-9]{64}$/;
const URL = /^[a-z][a-z0-9+.-]*:/i;
const windowsAbsolute = (path: string): boolean => /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const changed = (): Error => new Error("This footage changed while it was being indexed. Index the current file again.");
const damaged = (): Error => new Error("The visual index is damaged or uses an unsupported format. It has not been changed. Keep .cutroom/visual-index.json before rebuilding the index.");
type RecordEntry = { engine: string; duration: number; indexedAt: string; analysis: VisualAnalysis };
type IndexRecord = { version: 1; entries: Record<string, RecordEntry> };
type IndexSnapshot = { record: IndexRecord; revision: string | null; bytes: number };
type SourceState = { path: string; signature: string };
type SourceFingerprint = SourceState & { fingerprint: string };

function abort(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function duration(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > VISUAL_MAX_SECONDS) {
    throw new Error("Visual indexing supports video up to two hours. Split longer recordings into shorter files first.");
  }
}
function localPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768 || value.includes("\0")) {
    throw new Error("Choose a valid local footage file.");
  }
  if (windowsAbsolute(value) && process.platform !== "win32") throw new Error("Relink this footage to a local file on this computer.");
  if (URL.test(value) && !windowsAbsolute(value)) throw new Error("Download linked footage to a local file before indexing it.");
}
async function requestPaths(request: VisualIndexRequest): Promise<{ root: string; source: string }> {
  if (!object(request)) throw new Error("Invalid visual index request.");
  duration(request.duration);
  if (request.sourceStart !== undefined && (typeof request.sourceStart !== 'number' || !Number.isFinite(request.sourceStart) || request.sourceStart < 0 || request.sourceStart > 86400)) throw new Error('Invalid video track origin.');
  localPath(request.dir);
  localPath(request.source);
  if (!isAbsolute(request.dir)) throw new Error("Open a local project before indexing footage.");
  const root = await realpath(request.dir);
  if (!(await stat(root)).isDirectory()) throw new Error("The footage project must be a directory.");
  const source = resolve(root, request.source);
  if (!isAbsolute(request.source) && source !== root && !source.startsWith(root + sep)) {
    throw new Error("Use an absolute local path for footage outside the project.");
  }
  return { root, source };
}
function signature(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
async function sourceState(source: string): Promise<SourceState> {
  const path = await realpath(source);
  const info = await stat(path, { bigint: true });
  if (!info.isFile()) throw new Error("Footage must be a local audio or video file.");
  return { path, signature: signature(info) };
}
async function assertSource(source: string, expected: SourceState, signal?: AbortSignal): Promise<void> {
  abort(signal);
  let current: SourceState;
  try { current = await sourceState(source); } catch (error) { if (missing(error)) throw changed(); throw error; }
  if (current.path !== expected.path || current.signature !== expected.signature) throw changed();
  abort(signal);
}

/** Hidden metadata is deliberately excluded by Collect Project and can be rebuilt from originals. */
async function indexPath(root: string, create = false): Promise<string | null> {
  const folder = join(root, ".cutroom");
  if (create) await mkdir(folder, { recursive: true });
  try {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The visual index folder must be a real project directory.");
  } catch (error) { if (missing(error) && !create) return null; throw error; }
  return join(folder, "visual-index.json");
}

async function indexRevision(root: string): Promise<string | null> {
  const path = await indexPath(root);
  if (!path) return null;
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_INDEX_BYTES)) throw damaged();
    return signature(info);
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function readIndex(root: string): Promise<IndexSnapshot> {
  const path = await indexPath(root);
  const empty = (): IndexSnapshot => ({ record: { version: 1, entries: {} }, revision: null, bytes: 0 });
  if (!path) return empty();
  let text: string;
  let revision: string | null;
  try {
    revision = await indexRevision(root);
    if (revision === null) return empty();
    text = await readFile(path, "utf8");
    if (await indexRevision(root) !== revision) throw new Error("The visual index changed while being read. Try indexing again.");
  } catch (error) { if (missing(error)) return empty(); throw error; }
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.version !== 1 || !object(value.entries) || Object.keys(value.entries).length > MAX_ENTRIES) throw damaged();
    const entries: Record<string, RecordEntry> = {};
    for (const [key, entry] of Object.entries(value.entries)) {
      if (!object(entry) || typeof entry.engine !== "string" || !/^[a-z0-9-]{1,80}$/.test(entry.engine) ||
        !key.startsWith(`${entry.engine}:`) || !HASH.test(key.slice(entry.engine.length + 1)) ||
        typeof entry.indexedAt !== "string" || !Number.isFinite(Date.parse(entry.indexedAt))) throw damaged();
      duration(entry.duration);
      // v1 stored nominal sampling slots, not observed presentation times.
      // Those entries are rebuildable, never evidence for the new clock contract.
      if (entry.engine !== VISUAL_ENGINE) continue;
      entries[key] = { engine: entry.engine, indexedAt: entry.indexedAt, duration: entry.duration, analysis: validateVisualAnalysis(entry.analysis, entry.duration) };
    }
    return { record: { version: 1, entries }, revision, bytes: Buffer.byteLength(text, "utf8") };
  } catch { throw damaged(); }
}

async function writeIndex(root: string, record: IndexRecord, beforeCommit: () => Promise<void>): Promise<void> {
  const content = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_INDEX_BYTES) throw new Error("The visual index is full. Split this library into smaller projects.");
  const path = (await indexPath(root, true))!;
  const temp = join(root, ".cutroom", `.dstmp-visual-index-${randomUUID()}`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await beforeCommit();
    await indexPath(root); // Do not follow a replaced metadata directory.
    await rename(temp, path);
    if (process.platform !== "win32") {
      const directory = await open(join(root, ".cutroom"), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temp).catch(() => {}); }
}

/** The only media access is a streamed read. Visual index commits rehash their original source. */
export class VisualIndexStore {
  private readonly fingerprints = new Map<string, SourceFingerprint>();
  private readonly records = new Map<string, IndexSnapshot>();

  private async read(root: string): Promise<IndexSnapshot> {
    const revision = await indexRevision(root);
    const cached = this.records.get(root);
    if (cached?.revision === revision) return cached;
    this.records.delete(root);
    const snapshot = await readIndex(root);
    this.records.set(root, snapshot);
    let bytes = [...this.records.values()].reduce((sum, record) => sum + record.bytes, 0);
    while (this.records.size > 8 || bytes > MAX_INDEX_BYTES) {
      const first = this.records.keys().next().value!;
      bytes -= this.records.get(first)!.bytes;
      this.records.delete(first);
    }
    return snapshot;
  }

  private async fingerprint(source: string, signal?: AbortSignal, force = false): Promise<SourceFingerprint> {
    abort(signal);
    const before = await sourceState(source);
    const cached = this.fingerprints.get(before.path);
    if (!force && cached?.signature === before.signature) {
      await assertSource(source, before, signal);
      return cached;
    }
    const hash = createHash("sha256");
    const handle = await open(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (signature(await handle.stat({ bigint: true })) !== before.signature) throw changed();
      const stream = createReadStream(before.path, { fd: handle.fd, autoClose: false, highWaterMark: 1024 * 1024, signal });
      for await (const chunk of stream) { abort(signal); hash.update(chunk as Buffer); }
      if (signature(await handle.stat({ bigint: true })) !== before.signature) throw changed();
      await assertSource(source, before, signal);
      const result = { ...before, fingerprint: hash.digest("hex") };
      this.fingerprints.delete(before.path);
      this.fingerprints.set(before.path, result);
      if (this.fingerprints.size > 256) this.fingerprints.delete(this.fingerprints.keys().next().value!);
      return result;
    } finally { await handle.close(); }
  }

  async get(request: VisualIndexRequest, signal?: AbortSignal): Promise<VisualIndexResult> {
    abort(signal);
    const { root, source } = await requestPaths(request);
    const current = await this.fingerprint(source, signal);
    const { record } = await this.read(root);
    await assertSource(source, current, signal);
    const entry = record.entries[`${VISUAL_ENGINE}:${current.fingerprint}`];
    const matches = entry && Math.abs(entry.analysis.duration - request.duration) <= 0.001 && Math.abs(entry.analysis.sourceStart - (request.sourceStart ?? 0)) <= 0.000001;
    return { fingerprint: current.fingerprint, engine: VISUAL_ENGINE,
      indexedAt: matches ? entry.indexedAt : null,
      analysis: matches ? validateVisualAnalysis(entry.analysis, request.duration, request.sourceStart ?? 0) : null };
  }

  async put(request: VisualIndexPutRequest, signal?: AbortSignal): Promise<VisualIndexResult> {
    abort(signal);
    const { root, source } = await requestPaths(request);
    if (typeof request.expectedFingerprint !== "string" || !HASH.test(request.expectedFingerprint)) throw new Error("Check the current footage fingerprint before saving its visual evidence.");
    const copy = validateVisualAnalysis(request.analysis, request.duration, request.sourceStart ?? 0);
    const current = await this.fingerprint(source, signal, true);
    if (current.fingerprint !== request.expectedFingerprint) throw changed();
    return withProjectLock(root, async () => {
      abort(signal);
      const snapshot = await this.read(root);
      // Do not expose an uncommitted entry through the parsed-index read cache.
      const record: IndexRecord = { version: 1, entries: { ...snapshot.record.entries } };
      const revision = snapshot.revision;
      const key = `${VISUAL_ENGINE}:${current.fingerprint}`;
      if (!record.entries[key] && Object.keys(record.entries).length >= MAX_ENTRIES) throw new Error("The visual index is full. Split this library into smaller projects.");
      const indexedAt = new Date().toISOString();
      record.entries[key] = { engine: VISUAL_ENGINE, duration: request.duration, indexedAt, analysis: copy };
      await writeIndex(root, record, async () => {
        await assertSource(source, current, signal);
        if (await indexRevision(root) !== revision) throw new Error("The visual index changed during saving. Its newer contents were preserved; try indexing again.");
        abort(signal);
      });
      this.records.delete(root);
      return { fingerprint: current.fingerprint, engine: VISUAL_ENGINE, indexedAt, analysis: copy };
    });
  }
}
