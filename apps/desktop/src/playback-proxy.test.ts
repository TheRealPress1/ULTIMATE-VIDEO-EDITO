import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalPlaybackProxyService } from './playback-proxy';
import type { PlaybackProxyJob, PlaybackProxyRequest } from './playback-proxy-types';

const folders: string[] = [];
const services: LocalPlaybackProxyService[] = [];
afterEach(async () => { for (const service of services.splice(0)) service.dispose(); for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(options: { maxCacheBytes?: number; reserveBytes?: number } = {}) {
  const raw = await mkdtemp(join(tmpdir(), 'uve-proxy-test-'));
  // The production cache intentionally requires a canonical directory.
  const dir = await import('node:fs/promises').then(fs => fs.realpath(raw)); folders.push(dir);
  const runtimePath = join(dir, 'worker.mjs');
  await writeFile(runtimePath, `#!${process.execPath}\nimport fs from 'node:fs';
const [source, output, start, duration] = process.argv.slice(2); const data=JSON.parse(fs.readFileSync(source,'utf8'));
fs.appendFileSync(source+'.runs','run\\n');
console.log(JSON.stringify({type:'progress',completed:0,total:Number(duration)}));
setTimeout(()=>{
 if(data.mutate)fs.appendFileSync(source,' ');
 fs.writeFileSync(output,Buffer.alloc(data.bytes??2048,23));
 console.log(JSON.stringify({type:'done',sourceStart:Number(start)+(data.badClock?1:0),proxyStart:0,duration:Number(duration),width:1280,height:720,sourceWidth:1920,sourceHeight:1080,frameRate:30,frames:3}));
},data.delay??0);\n`);
  await chmod(runtimePath, 0o700);
  const service = new LocalPlaybackProxyService({ runtimePath, cacheDir: join(dir, 'cache'), reserveBytes: 0, runTimeoutMs: 5000, ...options }); services.push(service);
  const source = join(dir, 'source.mp4'); await writeFile(source, '{}');
  const request: PlaybackProxyRequest = { dir, source, sourceStart: 2, duration: 0.1, width: 1920, height: 1080, frameRate: 30 };
  const job = (extra: Partial<PlaybackProxyRequest> = {}): PlaybackProxyJob => ({ ...request, ...extra, id: randomUUID() });
  return { service, source, dir, request, job };
}

describe.skipIf(process.platform !== 'darwin')('local playback proxy cache', () => {
  it('reuses fingerprint-bound derivatives after restart without rewriting source media', async () => {
    const f = await fixture(); const before = await readFile(f.source);
    expect((await f.service.get(f.request)).status).toBe('missing');
    const result = await f.service.prepare(f.job());
    expect(result.status).toBe('ready'); expect(result.proxy).toMatchObject({ sourceStart: 2, proxyStart: 0, width: 1280, height: 720 });
    expect(await readFile(f.source)).toEqual(before);
    const restarted = new LocalPlaybackProxyService({ runtimePath: '/missing', cacheDir: join(f.dir, 'cache'), reserveBytes: 0 }); services.push(restarted);
    expect((await restarted.get(f.request)).proxy?.path).toBe(result.proxy?.path);
    await restarted.prepare(f.job());
    expect(await readFile(f.source + '.runs', 'utf8')).toBe('run\n');
  });
  it('invalidates a replaced source and never relabels its old proxy as current', async () => {
    const f = await fixture(); const first = await f.service.prepare(f.job());
    await writeFile(f.source, '{"changed":true}');
    const stale = await f.service.get(f.request); expect(stale.status).toBe('missing'); expect(stale.fingerprint).not.toBe(first.fingerprint);
    const second = await f.service.prepare(f.job()); expect(second.proxy?.path).not.toBe(first.proxy?.path);
  });
  it('rejects modifications during encoding and removes partial files', async () => {
    const f = await fixture(); await writeFile(f.source, '{"mutate":true}');
    await expect(f.service.prepare(f.job())).rejects.toThrow('source changed');
    expect(await readdir(join(f.dir, 'cache'))).toEqual([]);
  });
  it('rejects incorrect native timing instead of exposing a drifting preview', async () => {
    const f = await fixture(); await writeFile(f.source, '{"badClock":true}');
    await expect(f.service.prepare(f.job())).rejects.toThrow('metadata did not match');
    expect((await f.service.get(f.request)).status).toBe('missing');
  });
  it('cancels active and queued jobs, then permits a new request', async () => {
    const f = await fixture(); await writeFile(f.source, '{"delay":1000}');
    const first = f.job(), second = f.job();
    const running = f.service.prepare(first, progress => { if (progress.phase === 'encoding') f.service.cancel(first.id); });
    const queued = f.service.prepare(second); f.service.cancel(second.id);
    const outcomes = await Promise.allSettled([running, queued]); expect(outcomes.every(value => value.status === 'rejected')).toBe(true);
    await writeFile(f.source, '{}'); expect((await f.service.prepare(f.job())).status).toBe('ready');
    expect((await readdir(join(f.dir, 'cache'))).some(name => name.startsWith('.proxy-'))).toBe(false);
  });
  it('does not return a proxy that was corrupted or replaced with a symlink', async () => {
    const f = await fixture(); const result = await f.service.prepare(f.job()); const path = result.proxy!.path;
    await writeFile(path, 'corrupt'); expect((await f.service.get(f.request)).status).toBe('missing');
    await rm(path); await symlink(f.source, path); expect((await f.service.get(f.request)).status).toBe('missing');
  });
  it('declines optimization when the configured free-space reserve cannot be kept', async () => {
    const f = await fixture({ reserveBytes: Number.MAX_SAFE_INTEGER });
    await expect(f.service.prepare(f.job())).rejects.toThrow('Not enough free cache space');
    await expect(stat(f.source + '.runs')).rejects.toThrow();
  });
  it('evicts old derivatives without removing pinned playback files', async () => {
    const f = await fixture({ maxCacheBytes: 50 * 1024 * 1024 });
    await writeFile(f.source, JSON.stringify({ bytes: 20 * 1024 * 1024, variant: 1 }));
    const first = await f.service.prepare(f.job()); f.service.pin('window:project', first.proxy!.path);
    await writeFile(f.source, JSON.stringify({ bytes: 20 * 1024 * 1024, variant: 2 }));
    const second = await f.service.prepare(f.job());
    await writeFile(f.source, JSON.stringify({ bytes: 20 * 1024 * 1024, variant: 3 }));
    const third = await f.service.prepare(f.job());
    expect((await stat(first.proxy!.path)).isFile()).toBe(true); expect((await stat(third.proxy!.path)).isFile()).toBe(true);
    await expect(stat(second.proxy!.path)).rejects.toThrow();
    f.service.release('window:project');
  });
  it('keeps a completed result alive while IPC pins it and another queued job needs space', async () => {
    const f = await fixture({ maxCacheBytes: 35 * 1024 * 1024 });
    await writeFile(f.source, JSON.stringify({ bytes: 20 * 1024 * 1024, variant: 1 }));
    const other = join(f.dir, 'second.mp4'); await writeFile(other, JSON.stringify({ bytes: 20 * 1024 * 1024, variant: 2 }));
    const first = f.service.prepare(f.job()).then(result => { f.service.pin('window:session', result.proxy!.path); return result; });
    const second = f.service.prepare(f.job({ source: other }));
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0]!.status).toBe('fulfilled'); expect(outcomes[1]!.status).toBe('rejected');
    expect((await stat((await first).proxy!.path)).isFile()).toBe(true);
  });
  it('refuses escaping relative sources, URLs, duplicate jobs and symlink cache roots', async () => {
    const f = await fixture();
    await expect(f.service.get({ ...f.request, source: '../outside.mp4' })).rejects.toThrow('absolute path');
    await expect(f.service.get({ ...f.request, source: 'https://example.com/source.mp4' })).rejects.toThrow('valid local video');
    const job = f.job(); const first = f.service.prepare(job); await expect(f.service.prepare(job)).rejects.toThrow('duplicate'); await first;
    const linked = join(f.dir, 'linked'); await symlink(join(f.dir, 'cache'), linked);
    const other = new LocalPlaybackProxyService({ runtimePath: '/missing', cacheDir: linked }); services.push(other);
    await expect(other.get(f.request)).rejects.toThrow('real local directory');
  });
});
