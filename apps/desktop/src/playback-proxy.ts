import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, statfs, unlink, utimes } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PLAYBACK_PROXY_CACHE_BYTES, PLAYBACK_PROXY_ENGINE, PLAYBACK_PROXY_MAX_SECONDS } from './playback-proxy-types';
import type { NativePlaybackProxyResult, PlaybackProxyDescriptor, PlaybackProxyJob, PlaybackProxyProgress, PlaybackProxyRequest, PlaybackProxyResult } from './playback-proxy-types';

export interface LocalPlaybackProxyOptions {
  runtimePath: string;
  cacheDir: string;
  maxCacheBytes?: number;
  reserveBytes?: number;
  runTimeoutMs?: number;
  killGraceMs?: number;
}
type SourceState = { path: string; signature: string; fingerprint: string };
type CacheRecord = { version: 1; engine: string; descriptor: PlaybackProxyDescriptor; proxySignature: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const signature = (info: BigIntStats): string => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const changed = () => new Error('This source changed while preparing smoother playback. The original remains available.');

function validate(request: PlaybackProxyRequest): void {
  if (!request || typeof request.dir !== 'string' || !isAbsolute(request.dir) || request.dir.includes('\0') ||
      typeof request.source !== 'string' || !request.source.trim() || request.source.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(request.source) ||
      !finite(request.duration) || request.duration <= 0 || request.duration > PLAYBACK_PROXY_MAX_SECONDS ||
      !finite(request.sourceStart) || request.sourceStart < 0 || request.sourceStart > 86400 ||
      ![request.width, request.height].every(value => Number.isInteger(value) && value >= 2 && value <= 32768) ||
      !finite(request.frameRate) || request.frameRate <= 0 || request.frameRate > 240) throw new Error('Choose valid local video for smoother playback.');
}
function keyFor(request: PlaybackProxyRequest, fingerprint: string): string {
  return createHash('sha256').update(JSON.stringify([PLAYBACK_PROXY_ENGINE, fingerprint, request.sourceStart, request.duration, request.width, request.height])).digest('hex');
}
function validateNative(value: unknown, request: PlaybackProxyRequest): NativePlaybackProxyResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid local playback metadata.');
  const r = value as NativePlaybackProxyResult;
  if (!finite(r.sourceStart) || Math.abs(r.sourceStart - request.sourceStart) > 0.001 || !finite(r.proxyStart) || Math.abs(r.proxyStart) > 0.001 ||
      !finite(r.duration) || r.duration <= 0 || Math.abs(r.duration - request.duration) > Math.max(0.05, 1 / request.frameRate) ||
      ![r.width, r.height].every(v => Number.isInteger(v) && v >= 2 && v <= 1280 && v % 2 === 0) || Math.min(r.width, r.height) > 720 ||
      ![r.sourceWidth, r.sourceHeight].every(v => Number.isInteger(v) && v >= 2 && v <= 32768) ||
      Math.abs(r.sourceWidth - request.width) > 2 || Math.abs(r.sourceHeight - request.height) > 2 ||
      !finite(r.frameRate) || r.frameRate <= 0 || r.frameRate > 240 || !Number.isInteger(r.frames) || r.frames < 1) throw new Error('Playback metadata did not match the original video.');
  return r;
}

/** Serial, local, rebuildable playback cache. Original media is only ever opened read-only. */
export class LocalPlaybackProxyService {
  private readonly fingerprints = new Map<string, SourceState>();
  private readonly pins = new Map<string, Set<string>>();
  private readonly leases = new Map<string, number>();
  private readonly jobs = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private initialized?: Promise<string>;
  private activePath?: string;
  private readonly options: LocalPlaybackProxyOptions;
  constructor(options: LocalPlaybackProxyOptions) { this.options = options; }

  pin(owner: string, path: string): void {
    const folder = resolve(this.options.cacheDir);
    if (typeof owner !== 'string' || !owner || typeof path !== 'string' || !path.startsWith(folder + sep) || !HASH.test(path.slice(folder.length + 1, -4)) || !path.endsWith('.mp4')) return;
    const paths = this.pins.get(owner) ?? new Set<string>(); paths.add(path); this.pins.set(owner, paths);
  }
  release(owner: string): void { this.pins.delete(owner); }
  private lease(path: string): () => void {
    this.leases.set(path, (this.leases.get(path) ?? 0) + 1);
    // Main's awaiting IPC handler pins a ready result in its promise microtask.
    // Keep it protected through that handoff, including other queued jobs.
    return () => { setImmediate(() => {
      const remaining = (this.leases.get(path) ?? 1) - 1;
      if (remaining) this.leases.set(path, remaining); else this.leases.delete(path);
    }); };
  }
  cancel(id: string): void { this.jobs.get(id)?.abort(new Error('Playback optimization cancelled.')); }
  dispose(): void { this.disposed = true; for (const id of this.jobs.keys()) this.cancel(id); this.pins.clear(); }

  private async directory(): Promise<string> {
    this.initialized ??= (async () => {
      const folder = resolve(this.options.cacheDir);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw new Error('The playback cache must be a real local directory.');
      // The single app cache owner has no jobs yet. Remove only interrupted
      // internal staging files; never traverse or remove arbitrary entries.
      for (const name of await readdir(folder)) if (/^\.proxy-[0-9a-f-]{36}\.(?:mp4|json)$/.test(name)) await unlink(join(folder, name)).catch(() => {});
      return folder;
    })();
    return this.initialized;
  }
  private async source(request: PlaybackProxyRequest, signal?: AbortSignal, force = false): Promise<SourceState> {
    validate(request); signal?.throwIfAborted();
    const root = await realpath(request.dir);
    if (!(await stat(root)).isDirectory()) throw new Error('Open a local project first.');
    const requested = resolve(root, request.source);
    if (!isAbsolute(request.source) && !requested.startsWith(root + sep)) throw new Error('Use an absolute path for imported footage outside the project.');
    const path = await realpath(requested), before = await stat(path, { bigint: true });
    if (!before.isFile() || before.size <= 0n) throw new Error('The original video is unavailable.');
    const stamp = signature(before), cached = this.fingerprints.get(path);
    if (!force && cached?.signature === stamp) return cached;
    const hash = createHash('sha256'), handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (signature(await handle.stat({ bigint: true })) !== stamp) throw changed();
      const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
      while (true) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
      if (signature(await handle.stat({ bigint: true })) !== stamp) throw changed();
    } finally { await handle.close(); }
    if (await realpath(requested) !== path || signature(await stat(path, { bigint: true })) !== stamp) throw changed();
    signal?.throwIfAborted();
    const state = { path, signature: stamp, fingerprint: hash.digest('hex') };
    this.fingerprints.set(path, state);
    if (this.fingerprints.size > 256) this.fingerprints.delete(this.fingerprints.keys().next().value!);
    return state;
  }
  private async cached(request: PlaybackProxyRequest, source: SourceState): Promise<PlaybackProxyResult> {
    const folder = await this.directory(), key = keyFor(request, source.fingerprint), path = join(folder, `${key}.mp4`);
    const fallback: PlaybackProxyResult = { status: 'missing', fingerprint: source.fingerprint, sourceSignature: source.signature };
    try {
      const metadata = join(folder, `${key}.json`), metaInfo = await lstat(metadata);
      if (!metaInfo.isFile() || metaInfo.isSymbolicLink() || metaInfo.size > 16_384) return fallback;
      const record = JSON.parse(await readFile(metadata, 'utf8')) as CacheRecord;
      const d = record.descriptor;
      if (record.version !== 1 || record.engine !== PLAYBACK_PROXY_ENGINE || !d || d.path !== path || d.fingerprint !== source.fingerprint || !HASH.test(d.fingerprint) || !Number.isFinite(Date.parse(d.createdAt))) return fallback;
      validateNative({ ...d, frames: 1 }, request);
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0n || signature(info) !== record.proxySignature) return fallback;
      // LRU touches metadata only; the video signature remains stable for open decoders.
      await utimes(metadata, new Date(), new Date()).catch(() => {});
      return { ...fallback, status: 'ready', proxy: { ...d, sourceSignature: source.signature } };
    } catch (error) { if (missing(error) || error instanceof SyntaxError) return fallback; return fallback; }
  }
  async get(request: PlaybackProxyRequest): Promise<PlaybackProxyResult> {
    if (this.disposed) throw new Error('Playback optimization has closed.');
    const source = await this.source(request);
    const release = this.lease(join(await this.directory(), `${keyFor(request, source.fingerprint)}.mp4`));
    try {
      const cached = await this.cached(request, source);
      if (signature(await stat(source.path, { bigint: true })) !== source.signature || await realpath(resolve(request.dir, request.source)) !== source.path) throw changed();
      return cached;
    } finally { release(); }
  }
  prepare(request: PlaybackProxyJob, progress?: (value: PlaybackProxyProgress) => void): Promise<PlaybackProxyResult> {
    if (this.disposed) return Promise.reject(new Error('Playback optimization has closed.'));
    if (!request || !UUID.test(request.id) || this.jobs.has(request.id)) return Promise.reject(new Error('Invalid or duplicate playback optimization job.'));
    try { validate(request); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(); this.jobs.set(request.id, controller);
    const report = (phase: PlaybackProxyProgress['phase'], completed = 0, total = request.duration) => { try { progress?.({ id: request.id, phase, completed, total }); } catch { /* renderer went away */ } };
    report('queued');
    const result = this.queue.catch(() => {}).then(async () => {
      const signal = controller.signal; signal.throwIfAborted(); report('fingerprinting');
      const source = await this.source(request, signal), cached = await this.cached(request, source);
      signal.throwIfAborted();
      if (signature(await stat(source.path, { bigint: true })) !== source.signature || await realpath(resolve(request.dir, request.source)) !== source.path) throw changed();
      if (cached.proxy) { this.lease(cached.proxy.path)(); return cached; }
      if (process.platform !== 'darwin' || !await access(this.options.runtimePath, constants.X_OK).then(() => true, () => false)) throw new Error('Local playback optimization is unavailable; continue with the original video.');
      const folder = await this.directory(), key = keyFor(request, source.fingerprint), path = join(folder, `${key}.mp4`);
      const temp = join(folder, `.proxy-${randomUUID()}.mp4`), metadata = join(folder, `${key}.json`), metaTemp = join(folder, `.proxy-${randomUUID()}.json`);
      // Allow overhead above the encoder's target rate. Very long recordings
      // can exceed the quota; they simply retain original playback.
      const estimatedBytes = Math.ceil(request.duration * 2_500_000 / 8 * 1.4) + 16 * 1024 * 1024;
      await this.makeRoom(estimatedBytes, path); signal.throwIfAborted(); this.activePath = path;
      try {
        const native = validateNative(await this.run(request, source.path, temp, signal, (done, total) => report('encoding', done, total)), request);
        signal.throwIfAborted(); report('verifying');
        const after = await this.source(request, signal, true);
        if (after.path !== source.path || after.signature !== source.signature || after.fingerprint !== source.fingerprint) throw changed();
        const tempInfo = await lstat(temp);
        if (!tempInfo.isFile() || tempInfo.isSymbolicLink() || tempInfo.size <= 0) throw new Error('The playback copy was not written completely.');
        await this.makeRoom(tempInfo.size, path, temp);
        const handle = await open(temp, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        signal.throwIfAborted(); await rename(temp, path);
        const descriptor: PlaybackProxyDescriptor = {
          path, fingerprint: source.fingerprint, sourceSignature: source.signature,
          sourceStart: native.sourceStart, proxyStart: native.proxyStart, duration: native.duration,
          width: native.width, height: native.height, frameRate: native.frameRate,
          sourceWidth: native.sourceWidth, sourceHeight: native.sourceHeight, createdAt: new Date().toISOString(),
        };
        const record: CacheRecord = { version: 1, engine: PLAYBACK_PROXY_ENGINE, descriptor, proxySignature: signature(await stat(path, { bigint: true })) };
        const meta = await open(metaTemp, 'wx', 0o600);
        try { await meta.writeFile(JSON.stringify(record) + '\n'); await meta.sync(); } finally { await meta.close(); }
        signal.throwIfAborted(); await rename(metaTemp, metadata);
        const directory = await open(folder, 'r'); try { await directory.sync(); } finally { await directory.close(); }
        report('verifying', request.duration);
        this.lease(path)();
        return { status: 'ready' as const, fingerprint: source.fingerprint, sourceSignature: source.signature, proxy: descriptor };
      } finally { this.activePath = undefined; await unlink(temp).catch(() => {}); await unlink(metaTemp).catch(() => {}); }
    }).finally(() => { this.jobs.delete(request.id); });
    this.queue = result;
    return result;
  }

  private async makeRoom(required: number, protectedPath: string, currentTemp?: string): Promise<void> {
    const folder = await this.directory(), maximum = this.options.maxCacheBytes ?? PLAYBACK_PROXY_CACHE_BYTES;
    const reserve = this.options.reserveBytes ?? 2 * 1024 * 1024 * 1024;
    if (required > maximum) throw new Error('This playback copy would exceed the local cache limit. Continue using the original.');
    const entries: { path: string; bytes: number; used: number }[] = [];
    let total = 0;
    for (const name of await readdir(folder)) {
      if (!/^[a-f0-9]{64}\.mp4$/.test(name)) continue;
      const path = join(folder, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      total += info.size;
      const used = await stat(path.slice(0, -4) + '.json').then(s => s.mtimeMs, () => info.mtimeMs);
      entries.push({ path, bytes: info.size, used });
    }
    const previousSize = entries.find(entry => entry.path === protectedPath)?.bytes ?? 0;
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      const free = await statfs(folder); const available = Number(free.bavail) * Number(free.bsize);
      const additional = currentTemp ? 0 : required;
      if (total - previousSize + required <= maximum && available - additional >= reserve) return;
      // Pins may arrive while filesystem stats above are pending (another
      // renderer just opened a cached derivative). Consult the live owners.
      if (entry.path === protectedPath || entry.path === this.activePath || this.leases.has(entry.path) || [...this.pins.values()].some(paths => paths.has(entry.path))) continue;
      await unlink(entry.path); await unlink(entry.path.slice(0, -4) + '.json').catch(() => {}); total -= entry.bytes;
    }
    const free = await statfs(folder); const available = Number(free.bavail) * Number(free.bsize);
    if (total - previousSize + required > maximum || available - (currentTemp ? 0 : required) < reserve) throw new Error('Not enough free cache space for smoother playback. The original video remains available.');
  }

  private run(request: PlaybackProxyJob, source: string, output: string, signal: AbortSignal, progress: (completed: number, total: number) => void): Promise<NativePlaybackProxyResult> {
    return new Promise((resolveRun, reject) => {
      signal.throwIfAborted();
      const child = spawn(this.options.runtimePath, [source, output, String(request.sourceStart), String(request.duration)], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let buffer = '', stderr = '', bytes = 0, result: NativePlaybackProxyResult | undefined, failure: Error | undefined;
      let killed: ReturnType<typeof setTimeout> | undefined;
      const decoder = new StringDecoder('utf8');
      const stop = (error: Error) => { if (failure) return; failure = error; child.kill('SIGTERM'); killed = setTimeout(() => child.kill('SIGKILL'), this.options.killGraceMs ?? 1000); };
      const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('Playback optimization cancelled.'));
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      const timeout = setTimeout(() => stop(new Error('Playback optimization took too long. Continue using the original.')), this.options.runTimeoutMs ?? Math.max(5 * 60_000, request.duration * 4000));
      child.stdout.on('data', (data: Buffer) => {
        if (failure) return; bytes += data.length;
        if (bytes > 8 * 1024 * 1024) { stop(new Error('Invalid playback worker output.')); return; }
        buffer += decoder.write(data);
        try {
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
            const value = JSON.parse(line);
            if (result) throw new Error('Playback worker continued after completion.');
            if (value.type === 'progress' && finite(value.completed) && finite(value.total) && value.completed >= 0 && value.completed <= value.total && Math.abs(value.total - request.duration) <= Math.max(0.05, 1 / request.frameRate)) progress(value.completed, value.total);
            else if (value.type === 'done') result = validateNative(value, request);
            else throw new Error('Invalid playback worker output.');
          }
        } catch (error) { stop(error instanceof Error ? error : new Error('Invalid playback worker output.')); }
      });
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-8192); });
      child.on('error', error => { failure ??= error; });
      child.on('close', code => {
        clearTimeout(timeout); clearTimeout(killed); signal.removeEventListener('abort', abort);
        if (failure || code !== 0 || !result || buffer.trim()) reject(failure ?? new Error(stderr.trim() || 'Playback optimization did not complete.'));
        else resolveRun(result);
      });
    });
  }
}
