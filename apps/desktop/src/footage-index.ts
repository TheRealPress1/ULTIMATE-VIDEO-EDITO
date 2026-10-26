/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { withProjectLock } from "./project-write-transactions";
import { SPEECH_MAX_SECONDS } from "./speech-types";
import type { FootageIndexPutRequest, FootageIndexRequest, FootageIndexResult, FootageTranscript, FootageChunkRequest, FootageChunkPutRequest, FootageChunksResult } from "./footage-types";

import { speechChunks, SPEECH_CHUNK_ENGINE, SPEECH_CHUNK_SECONDS, SPEECH_CHUNK_OVERLAP } from "./speech-chunks";

export const FOOTAGE_TRANSCRIPT_ENGINE = "whisper-base-source-v2";
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_SECTION_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_SECTION_CACHE_FILES = 128;
const TIMESTAMP_TOLERANCE = 0.25;
const HASH = /^[a-f0-9]{64}$/;
const URL = /^[a-z][a-z0-9+.-]*:/i;
const windowsAbsolute = (path: string): boolean => /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const changed = (): Error => new Error("This footage changed while it was being indexed. Index the current file again.");
const damaged = (): Error => new Error("The footage index is damaged or uses an unsupported format. It has not been changed. Keep .cutroom/footage-index.json before rebuilding the index.");
type RecordEntry = { engine: string; duration: number; indexedAt: string; transcript: FootageTranscript };
type IndexRecord = { version: 1; entries: Record<string, RecordEntry> };
type IndexSnapshot = { record: IndexRecord; revision: string | null; bytes: number };
type SourceState = { path: string; signature: string };
type SourceFingerprint = SourceState & { fingerprint: string };

function abort(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function duration(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > SPEECH_MAX_SECONDS) {
    throw new Error("Footage indexing supports local recordings up to two hours.");
  }
}
function localPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768 || value.includes("\0")) {
    throw new Error("Choose a valid local footage file.");
  }
  if (windowsAbsolute(value) && process.platform !== "win32") throw new Error("Relink this footage to a local file on this computer.");
  if (URL.test(value) && !windowsAbsolute(value)) throw new Error("Download linked footage to a local file before indexing it.");
}
async function requestPaths(request: FootageIndexRequest): Promise<{ root: string; source: string }> {
  if (!object(request)) throw new Error("Invalid footage index request.");
  duration(request.duration);
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

/** Copy only the bounded transcript schema; never persist extra renderer payloads. */
function transcript(value: unknown, seconds: number): FootageTranscript {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Invalid or oversized footage transcript.");
  let words = 0;
  let characters = 0;
  let previousStart = -1;
  const copy = value.map((segment: unknown) => {
    if (!object(segment) || typeof segment.text !== "string" || segment.text.length > 32_768 || !Array.isArray(segment.words)) {
      throw new Error("Invalid footage transcript segment.");
    }
    words += segment.words.length;
    characters += segment.text.length;
    if (words > 100_000 || characters > MAX_TRANSCRIPT_BYTES / 2) throw new Error("The footage transcript is too large.");
    if (segment.text.trim() && !segment.words.length) throw new Error("Spoken footage transcript segments need word timestamps.");
    let clipped = false;
    const copiedWords = segment.words.map((word: unknown) => {
      if (!object(word) || typeof word.text !== "string" || !word.text.trim() || word.text.length > 2_048 ||
        typeof word.start !== "number" || !Number.isFinite(word.start) || word.start < 0 ||
        typeof word.end !== "number" || !Number.isFinite(word.end) || word.end <= word.start ||
        word.end > seconds + TIMESTAMP_TOLERANCE || word.start < previousStart) {
        throw new Error("Footage transcript words must have ordered, valid timestamps within the original recording.");
      }
      previousStart = word.start;
      characters += word.text.length;
      if (characters > MAX_TRANSCRIPT_BYTES / 2) throw new Error("The footage transcript is too large.");
      const end = Math.min(word.end, seconds);
      if (end !== word.end || word.start >= seconds) clipped = true;
      return end > word.start ? { text: word.text, start: word.start, end } : null;
    }).filter((word) => word !== null);
    return { text: clipped ? copiedWords.map((word) => word.text.trim()).join(" ") : segment.text, words: copiedWords };
  }).filter((segment) => segment.words.length > 0);
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_TRANSCRIPT_BYTES) throw new Error("The footage transcript is too large.");
  return copy;
}

/** Hidden metadata is deliberately excluded by Collect Project and can be rebuilt from originals. */
async function indexPath(root: string, create = false): Promise<string | null> {
  const folder = join(root, ".cutroom");
  if (create) await mkdir(folder, { recursive: true });
  try {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The footage index folder must be a real project directory.");
  } catch (error) { if (missing(error) && !create) return null; throw error; }
  return join(folder, "footage-index.json");
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
    if (await indexRevision(root) !== revision) throw new Error("The footage index changed while being read. Try indexing again.");
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
      entries[key] = { engine: entry.engine, indexedAt: entry.indexedAt, duration: entry.duration, transcript: transcript(entry.transcript, entry.duration) };
    }
    return { record: { version: 1, entries }, revision, bytes: Buffer.byteLength(text, "utf8") };
  } catch { throw damaged(); }
}

async function writeIndex(root: string, record: IndexRecord, beforeCommit: () => Promise<void>): Promise<void> {
  const content = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_INDEX_BYTES) throw new Error("The footage index is full. Split this library into smaller projects.");
  const path = (await indexPath(root, true))!;
  const temp = join(root, ".cutroom", `.dstmp-footage-index-${randomUUID()}`);
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

type ChunkRecord = { version: 1; engine: string; fingerprint: string; duration: number; language: string; chunks: Record<number, FootageTranscript> };
function chunkLanguage(request: FootageChunkRequest): string {
  const language = request.language ?? 'auto';
  if (typeof language !== 'string' || !/^(?:auto|[a-z]{2,3})$/.test(language)) throw new Error('Choose a supported transcription language.');
  return language;
}
async function chunkPath(root: string, request: FootageChunkRequest, create = false): Promise<string | null> {
  if (!await indexPath(root, create)) return null;
  const folder = join(root, '.cutroom', 'footage-chunks');
  if (create) await mkdir(folder, { recursive: true, mode: 0o700 });
  try { const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The speech chunk cache must be a real project directory.'); }
  catch (error) { if (missing(error) && !create) return null; throw error; }
  const key = createHash('sha256').update(JSON.stringify([SPEECH_CHUNK_ENGINE, request.expectedFingerprint, request.duration, chunkLanguage(request), SPEECH_CHUNK_SECONDS, SPEECH_CHUNK_OVERLAP])).digest('hex');
  return join(folder, `${key}.json`);
}
function emptyChunks(request: FootageChunkRequest): ChunkRecord {
  return { version: 1, engine: SPEECH_CHUNK_ENGINE, fingerprint: request.expectedFingerprint, duration: request.duration, language: chunkLanguage(request), chunks: {} };
}
function checkedChunk(value: unknown, request: FootageChunkRequest, index: number): FootageTranscript {
  const window = speechChunks(request.duration)[index];
  if (!window) throw new Error('Invalid speech section index.');
  const copied = transcript(value, request.duration);
  for (const segment of copied) for (const word of segment.words) if (word.start < window.start - TIMESTAMP_TOLERANCE || word.end > window.end + TIMESTAMP_TOLERANCE) throw new Error('Speech section words fall outside their source window.');
  return copied;
}
async function readChunks(root: string, request: FootageChunkRequest): Promise<ChunkRecord> {
  const path = await chunkPath(root, request); if (!path) return emptyChunks(request);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TRANSCRIPT_BYTES * 2) throw new Error('The speech section cache is not a valid local file.');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value) || value.version !== 1 || value.engine !== SPEECH_CHUNK_ENGINE || value.fingerprint !== request.expectedFingerprint || value.duration !== request.duration || value.language !== chunkLanguage(request) || !object(value.chunks)) return emptyChunks(request);
    const record = emptyChunks(request), total = speechChunks(request.duration).length;
    if (Object.keys(value.chunks).length > total) return record;
    for (const [key, valueChunk] of Object.entries(value.chunks)) {
      const index = Number(key); if (!Number.isInteger(index) || index < 0 || index >= total || String(index) !== key) return emptyChunks(request);
      record.chunks[index] = checkedChunk(valueChunk, request, index);
    }
    return record;
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return emptyChunks(request);
    throw error;
  }
}
const chunkResult = (record: ChunkRecord): FootageChunksResult => ({ fingerprint: record.fingerprint, engine: record.engine,
  chunkSeconds: SPEECH_CHUNK_SECONDS, overlapSeconds: SPEECH_CHUNK_OVERLAP, completed: Object.keys(record.chunks).length,
  total: speechChunks(record.duration).length, chunks: record.chunks });
/** Evict only our derived cache files, never project assets or the current resumable recording. */
async function pruneChunks(root: string, keep: string): Promise<void> {
  const folder = join(root, '.cutroom', 'footage-chunks');
  const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink()) return;
  const files: { path: string; bytes: number; modified: number }[] = [];
  for (const name of await readdir(folder)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(folder, name), info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink()) files.push({ path, bytes: info.size, modified: info.mtimeMs });
  }
  let bytes = files.reduce((total, file) => total + file.bytes, 0), count = files.length;
  for (const file of files.sort((a, b) => a.modified - b.modified)) {
    if (count <= MAX_SECTION_CACHE_FILES && bytes <= MAX_SECTION_CACHE_BYTES) break;
    if (file.path === keep) continue;
    await unlink(file.path); bytes -= file.bytes; count--;
  }
}
async function writeChunks(root: string, request: FootageChunkRequest, record: ChunkRecord, beforeCommit: () => Promise<void>): Promise<void> {
  const path = (await chunkPath(root, request, true))!, temp = `${path}.${randomUUID()}.part`, content = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(content) > MAX_TRANSCRIPT_BYTES * 2) throw new Error('The speech section cache is full.');
  try {
    const file = await open(temp, 'wx', 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await beforeCommit(); await chunkPath(root, request); await rename(temp, path);
    await pruneChunks(root, path).catch(() => {});
  } finally { await unlink(temp).catch(() => {}); }
}

/** The only media access is a streamed read. Transcription commits rehash their original source. */
export class FootageIndexStore {
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

  async get(request: FootageIndexRequest, signal?: AbortSignal): Promise<FootageIndexResult> {
    abort(signal);
    const { root, source } = await requestPaths(request);
    const current = await this.fingerprint(source, signal);
    const { record } = await this.read(root);
    await assertSource(source, current, signal);
    const candidate = record.entries[`${FOOTAGE_TRANSCRIPT_ENGINE}:${current.fingerprint}`];
    const entry = candidate?.duration === request.duration ? candidate : undefined;
    const partial = entry ? undefined : chunkResult(await readChunks(root, { ...request, expectedFingerprint: current.fingerprint }));
    await assertSource(source, current, signal);
    return { fingerprint: current.fingerprint, engine: FOOTAGE_TRANSCRIPT_ENGINE,
      indexedAt: entry?.indexedAt ?? null,
      transcript: entry ? transcript(entry.transcript, request.duration) : null,
      ...(partial?.completed ? { partial: { completed: partial.completed, total: partial.total } } : {}) };
  }

  async getChunks(request: FootageChunkRequest, signal?: AbortSignal): Promise<FootageChunksResult> {
    abort(signal);
    const { root, source } = await requestPaths(request);
    if (!HASH.test(request.expectedFingerprint)) throw new Error('Check the current footage fingerprint before resuming speech analysis.');
    chunkLanguage(request);
    const current = await this.fingerprint(source, signal);
    if (current.fingerprint !== request.expectedFingerprint) throw changed();
    const record = await readChunks(root, request); await assertSource(source, current, signal);
    return chunkResult(record);
  }
  async putChunk(request: FootageChunkPutRequest, signal?: AbortSignal): Promise<FootageChunksResult> {
    abort(signal);
    const { root, source } = await requestPaths(request);
    if (!HASH.test(request.expectedFingerprint)) throw new Error('Check the current footage fingerprint before saving speech analysis.');
    if (!Number.isInteger(request.index) || request.index < 0) throw new Error('Invalid speech section index.');
    const copy = checkedChunk(request.transcript, request, request.index);
    const current = await this.fingerprint(source, signal);
    if (current.fingerprint !== request.expectedFingerprint) throw changed();
    return withProjectLock(root, async () => {
      const record = await readChunks(root, request);
      record.chunks[request.index] = copy;
      await writeChunks(root, request, record, () => assertSource(source, current, signal));
      return chunkResult(record);
    });
  }

  async put(request: FootageIndexPutRequest, signal?: AbortSignal): Promise<FootageIndexResult> {
    abort(signal);
    const { root, source } = await requestPaths(request);
    if (typeof request.expectedFingerprint !== "string" || !HASH.test(request.expectedFingerprint)) throw new Error("Check the current footage fingerprint before saving its transcript.");
    const copy = transcript(request.transcript, request.duration);
    const current = await this.fingerprint(source, signal, true);
    if (current.fingerprint !== request.expectedFingerprint) throw changed();
    return withProjectLock(root, async () => {
      abort(signal);
      const snapshot = await this.read(root);
      // Do not expose an uncommitted entry through the parsed-index read cache.
      const record: IndexRecord = { version: 1, entries: { ...snapshot.record.entries } };
      const revision = snapshot.revision;
      const key = `${FOOTAGE_TRANSCRIPT_ENGINE}:${current.fingerprint}`;
      if (!record.entries[key] && Object.keys(record.entries).length >= MAX_ENTRIES) throw new Error("The footage index is full. Split this library into smaller projects.");
      const indexedAt = new Date().toISOString();
      record.entries[key] = { engine: FOOTAGE_TRANSCRIPT_ENGINE, duration: request.duration, indexedAt, transcript: copy };
      await writeIndex(root, record, async () => {
        await assertSource(source, current, signal);
        if (await indexRevision(root) !== revision) throw new Error("The footage index changed during saving. Its newer contents were preserved; try indexing again.");
        abort(signal);
      });
      this.records.delete(root);
      return { fingerprint: current.fingerprint, engine: FOOTAGE_TRANSCRIPT_ENGINE, indexedAt, transcript: copy };
    });
  }
}

const footageIndex = new FootageIndexStore();
export const loadFootageTranscript = (request: FootageIndexRequest, signal?: AbortSignal): Promise<FootageIndexResult> => footageIndex.get(request, signal);
export const saveFootageTranscript = (request: FootageIndexPutRequest, signal?: AbortSignal): Promise<FootageIndexResult> => footageIndex.put(request, signal);

export const loadFootageChunks = (request: FootageChunkRequest, signal?: AbortSignal): Promise<FootageChunksResult> => footageIndex.getChunks(request, signal);
export const saveFootageChunk = (request: FootageChunkPutRequest, signal?: AbortSignal): Promise<FootageChunksResult> => footageIndex.putChunk(request, signal);
