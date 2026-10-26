import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep, dirname } from 'node:path';
import type { AnalysisCachePut, AnalysisCacheRequest, AnalysisCacheResult } from './analysis-cache-types';
const signature = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_CACHE = 512 * 1024 * 1024;
const validChunk = (s: string) => /^[a-z\d_-]{1,80}$/i.test(s) && !['__proto__','constructor','prototype'].includes(s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Full streamed SHA with stat-bound reuse; no multi-gigabyte arrayBuffer. */
export class SourceFingerprintCache {
  private readonly cached = new Map<string, { signature: string; hash: string }>();
  async fingerprint(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const canonical = await realpath(path), before = await stat(canonical, { bigint: true });
    if (!before.isFile() || before.size <= 0n) throw new Error('An analysis source is unavailable. Relink it first.');
    const stamp = signature(before), existing = this.cached.get(canonical);
    if (existing?.signature === stamp) return existing.hash;
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const hash = createHash('sha256');
    try {
      if (signature(await handle.stat({ bigint: true })) !== stamp) throw new Error('An analysis source changed while reading it.');
      const bytes = Buffer.allocUnsafe(4 * 1024 * 1024);
      while (true) { signal?.throwIfAborted(); const part = await handle.read(bytes); if (!part.bytesRead) break; hash.update(bytes.subarray(0, part.bytesRead)); }
      if (signature(await handle.stat({ bigint: true })) !== stamp) throw new Error('An analysis source changed while reading it.');
    } finally { await handle.close(); }
    if (await realpath(path) !== canonical || signature(await stat(canonical, { bigint: true })) !== stamp) throw new Error('An analysis source changed while reading it.');
    signal?.throwIfAborted(); const result = hash.digest('hex');
    this.cached.set(canonical, { signature: stamp, hash: result });
    if (this.cached.size > 2048) this.cached.delete(this.cached.keys().next().value!);
    return result;
  }
}

/** Atomic, bounded persisted analysis chunks. Changing files/settings creates a new cache identity. */
export class LocalAnalysisCache {
  private readonly hashes = new SourceFingerprintCache();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly directory?: string;
  constructor(options: { directory?: string } = {}) { this.directory = options.directory; }
  private validate(r: AnalysisCacheRequest) {
    if (!r || typeof r.dir !== 'string' || !isAbsolute(r.dir) || r.dir.includes('\0') || typeof r.key !== 'string' || !r.key || r.key.length > 8192 ||
      !Array.isArray(r.sources) || r.sources.length > 2000 || r.sources.some(s => typeof s !== 'string' || !s || s.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(s))) throw new Error('Invalid local analysis cache request.');
  }
  private async identity(r: AnalysisCacheRequest, signal?: AbortSignal) {
    this.validate(r); signal?.throwIfAborted();
    const root = await realpath(r.dir); if (!(await stat(root)).isDirectory()) throw new Error('Open a project before analyzing.');
    const hashes: string[] = [];
    for (const source of [...new Set(r.sources)].sort()) {
      const path = resolve(root, source);
      if (!isAbsolute(source) && !path.startsWith(root + sep)) throw new Error('Invalid relative analysis source.');
      hashes.push(`${source}:${await this.hashes.fingerprint(path, signal)}`);
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([1, root, r.key, hashes])).digest('hex');
    return { root, fingerprint, folder: this.directory ? resolve(this.directory) : join(root, '.cutroom', 'analysis') };
  }
  private async folder(path: string): Promise<void> {
    // Refuse existing symlink parents before mkdir can write through them.
    let ancestor = path;
    while (true) {
      try { if (await realpath(ancestor) !== ancestor) throw new Error('The analysis cache has a symbolic-link parent.'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('The analysis cache directory is not a local directory.');
  }
  private async load(folder: string, fingerprint: string): Promise<Record<string, unknown>> {
    try {
      const path = join(folder, `${fingerprint}.json`), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) return {};
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!object(parsed) || parsed.version !== 1 || parsed.fingerprint !== fingerprint || !object(parsed.chunks) || Object.keys(parsed.chunks).length > 256) return {};
      return Object.fromEntries(Object.entries(parsed.chunks).filter(([key]) => validChunk(key)));
    } catch { return {}; }
  }
  private async prune(folder: string, keep: string): Promise<void> {
    const files: { path: string; size: number; time: number }[] = [];
    for (const name of await readdir(folder)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(folder, name), info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && !info.isSymbolicLink()) files.push({ path, size: info.size, time: info.mtimeMs });
    }
    let bytes = files.reduce((n, item) => n + item.size, 0), count = files.length;
    for (const item of files.sort((a,b) => a.time-b.time)) {
      if (bytes <= MAX_CACHE && count <= 512) break;
      if (item.path === keep || this.writes.has(item.path)) continue;
      await unlink(item.path).catch(() => {}); bytes -= item.size; count--;
    }
  }
  async get(r: AnalysisCacheRequest, signal?: AbortSignal): Promise<AnalysisCacheResult> {
    const { folder, fingerprint } = await this.identity(r, signal);
    const chunks = await this.load(folder, fingerprint); signal?.throwIfAborted();
    return { fingerprint, chunks };
  }
  async put(r: AnalysisCachePut, signal?: AbortSignal): Promise<void> {
    if (!HASH.test(r?.fingerprint) || typeof r.chunk !== 'string' || !validChunk(r.chunk)) throw new Error('Invalid analysis checkpoint.');
    const serialized = JSON.stringify(r.value);
    if (!serialized || Buffer.byteLength(serialized) > MAX_CHUNK) throw new Error('The analysis checkpoint is too large.');
    const { folder, fingerprint } = await this.identity(r, signal);
    if (fingerprint !== r.fingerprint) throw new Error('The media changed while analyzing. Start analysis again.');
    const key = join(folder, `${fingerprint}.json`), prior = this.writes.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
      signal?.throwIfAborted(); await this.folder(folder);
      const chunks = await this.load(folder, fingerprint); chunks[r.chunk] = JSON.parse(serialized);
      const body = JSON.stringify({ version: 1, fingerprint, chunks });
      if (Object.keys(chunks).length > 256 || Buffer.byteLength(body) > MAX_FILE) throw new Error('The analysis checkpoint limit was reached.');
      const temporary = join(folder, `.analysis-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
        signal?.throwIfAborted();
        if ((await this.identity(r, signal)).fingerprint !== fingerprint) throw new Error('The media changed while analyzing. Start analysis again.');
        await rename(temporary, key);
        await this.prune(folder, key);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.writes.set(key, next);
    try { await next; } finally { if (this.writes.get(key) === next) this.writes.delete(key); }
  }
}
