import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VisualIndexStore } from './visual-index-store';
import { LocalVisualIndexService } from './visual-index';
import type { VisualAnalysis } from './visual-types';

let dir: string;
let source: string;
const analysis: VisualAnalysis = { sourceStart: 0, duration: 10, width: 1920, height: 1080, sampleInterval: 5,
  samples: [0, 5].map((time) => ({ time, mediaTime: time, labels: [{ text: 'bicycle', confidence: 0.8 }], text: [{ text: 'OPEN', confidence: 0.9 }], people: 1 })) };
const request = () => ({ dir, source, duration: 10 });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'uve-visual-index-')); source = join(dir, 'source.mp4'); await writeFile(source, 'original source bytes'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function seed(store = new VisualIndexStore()) {
  const current = await store.get(request());
  return store.put({ ...request(), expectedFingerprint: current.fingerprint, analysis });
}
describe('persistent local visual index', () => {
  it('persists evidence by full fingerprint across restart, rename and copied originals', async () => {
    const saved = await seed();
    await rename(source, join(dir, 'renamed.mp4'));
    source = join(dir, 'renamed.mp4');
    expect(await new VisualIndexStore().get(request())).toEqual(saved);
    await copyFile(source, join(dir, 'copy.mp4'));
    source = join(dir, 'copy.mp4');
    expect(await new VisualIndexStore().get(request())).toEqual(saved);
    expect(await readFile(source, 'utf8')).toBe('original source bytes');
  });
  it('invalidates edited source bytes and rejects saving analysis against an old hash', async () => {
    const saved = await seed();
    await writeFile(source, 'changed media');
    const store = new VisualIndexStore();
    expect((await store.get(request())).analysis).toBeNull();
    await expect(store.put({ ...request(), expectedFingerprint: saved.fingerprint, analysis })).rejects.toThrow('changed');
  });
  it('invalidates legacy nominal timestamps while keeping the cache file until a new scan commits', async () => {
    const current = await new VisualIndexStore().get(request());
    const legacy = { ...analysis, sourceStart: undefined, samples: analysis.samples.map(({ mediaTime: _mediaTime, ...sample }) => sample) };
    const record = { version: 1, entries: { [`apple-vision-labels-ocr-v1:${current.fingerprint}`]: {
      engine: 'apple-vision-labels-ocr-v1', duration: 10, indexedAt: '2026-10-25T00:00:00Z', analysis: legacy,
    } } };
    await mkdir(join(dir, '.cutroom'));
    const path = join(dir, '.cutroom/visual-index.json'); const original = JSON.stringify(record);
    await writeFile(path, original);
    expect((await new VisualIndexStore().get(request())).analysis).toBeNull();
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await seed()).analysis).toEqual(analysis);
  });
  it('rejects malformed persisted sample timing without overwriting the original index', async () => {
    await seed();
    const path = join(dir, '.cutroom/visual-index.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    (Object.values(data.entries)[0] as { analysis: VisualAnalysis }).analysis.samples[1]!.time = 6;
    const damaged = JSON.stringify(data);
    await writeFile(path, damaged);
    await expect(new VisualIndexStore().get(request())).rejects.toThrow('damaged');
    expect(await readFile(path, 'utf8')).toBe(damaged);
  });
  it('rejects symlink metadata directories and traversal without following writes', async () => {
    await mkdir(join(dir, 'elsewhere'));
    await symlink(join(dir, 'elsewhere'), join(dir, '.cutroom'));
    await expect(new VisualIndexStore().get(request())).rejects.toThrow('real project directory');
    await expect(new VisualIndexStore().get({ ...request(), source: '../outside.mp4' })).rejects.toThrow('absolute local path');
  });
  it('does not write an index after cancellation', async () => {
    const store = new VisualIndexStore();
    const current = await store.get(request());
    const controller = new AbortController(); controller.abort();
    await expect(store.put({ ...request(), expectedFingerprint: current.fingerprint, analysis }, controller.signal)).rejects.toThrow();
    expect((await store.get(request())).analysis).toBeNull();
  });
  it('serializes concurrent source additions without losing either index entry', async () => {
    const store = new VisualIndexStore();
    const other = join(dir, 'other.mp4'); await writeFile(other, 'other original bytes');
    const first = await store.get(request());
    const second = await store.get({ ...request(), source: other });
    await Promise.all([
      store.put({ ...request(), expectedFingerprint: first.fingerprint, analysis }),
      store.put({ ...request(), source: other, expectedFingerprint: second.fingerprint, analysis }),
    ]);
    expect((await new VisualIndexStore().get(request())).analysis).toEqual(analysis);
    expect((await new VisualIndexStore().get({ ...request(), source: other })).analysis).toEqual(analysis);
  });
  it.runIf(process.platform === 'darwin')('indexes through the native process and reuses persisted evidence without rerunning it', async () => {
    const runtimePath = join(dir, 'helper.cjs');
    const events = [{ type: 'header', ...analysis, samples: undefined, total: 2 },
      ...analysis.samples.map((sample) => ({ type: 'sample', ...sample })), { type: 'done', completed: 2 }];
    await writeFile(runtimePath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n') + '\n')});`);
    await chmod(runtimePath, 0o700);
    const service = new LocalVisualIndexService({ runtimePath });
    try {
      const result = await service.index({ ...request(), id: randomUUID() });
      expect(result.analysis).toEqual(analysis);
      await rm(runtimePath);
      expect(await service.index({ ...request(), id: randomUUID() })).toEqual(result);
    } finally { service.dispose(); }
  });
});
