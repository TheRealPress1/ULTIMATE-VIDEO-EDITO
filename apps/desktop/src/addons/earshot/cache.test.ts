/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_FOLDERS, CACHE_LIMIT_BYTES, EarshotCache, RENDER_TEMP_PREFIX, SHEET_TEMP_PREFIX, cacheBytes } from "./cache";

let base: string;
let home: string;
let temp: string;
/** The test's "now": every file's times are set against it. */
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MIN = 60 * 1000;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "earshot-cache-")));
  home = join(base, "addons", "earshot", "home");
  temp = join(base, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(temp, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(base, { recursive: true, force: true });
});

/** A cache entry of `kb` KB under home/, written `writtenAgo` before NOW and last read `readAgo` before it (never, when omitted). */
async function entry(path: string, kb: number, writtenAgo: number, readAgo?: number): Promise<string> {
  const file = join(home, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(kb * 1024, 1));
  const written = NOW - writtenAgo;
  // Never read since it was written: access time just before the write, as a sweep leaves it.
  const read = readAgo === undefined ? written - 1000 : NOW - readAgo;
  await utimes(file, read / 1000, written / 1000);
  return file;
}

const cache = (options: Partial<ConstructorParameters<typeof EarshotCache>[0]> = {}) =>
  new EarshotCache({ home, tempRoot: temp, now: () => NOW, log: () => {}, isAlive: () => false, ...options });

const exists = (path: string) => stat(path).then(() => true, () => false);

/** On-disk bytes of a file, as the sweep counts them. */
const disk = async (path: string) => { const info = await stat(path); return info.blocks * 512 || info.size; };

describe("EarshotCache.sweep", () => {
  it("leaves the caches alone while they are under the limit", async () => {
    const a = await entry("decoded/a.npy", 64, 30 * MIN);
    const b = await entry("emb/clap/m--bf16/a_1.npy", 4, 10 * MIN);
    const swept = await cache({ limitBytes: 1024 * 1024 }).sweep();
    expect(swept).toEqual({ bytes: (await disk(a)) + (await disk(b)), removed: 0, removedBytes: 0 });
    expect([await exists(a), await exists(b)]).toEqual([true, true]);
  });

  it("removes the least recently used entries until the caches are under 80% of the limit", async () => {
    const oldest = await entry("decoded/oldest.npy", 100, 50 * MIN);
    const older = await entry("decoded/older.npy", 100, 40 * MIN);
    const recent = await entry("decoded/recent.npy", 100, 20 * MIN);
    const newest = await entry("decoded/newest.npy", 100, 5 * MIN);
    const each = await disk(oldest);
    // Four entries against a limit of three and a half: down to 80% of it leaves two.
    const swept = await cache({ limitBytes: Math.round(each * 3.5) }).sweep();
    expect([await exists(oldest), await exists(older), await exists(recent), await exists(newest)]).toEqual([false, false, true, true]);
    expect(swept).toEqual({ bytes: 2 * each, removed: 2, removedBytes: 2 * each });
  });

  it("removes decoded copies before embeddings, which take a model pass to make again", async () => {
    const embedding = await entry("emb/semantics/m--bf16/t_1.npy", 100, 3 * 60 * MIN);
    const timeline = await entry("emb/timeline/old.json", 100, 2 * 60 * MIN);
    const decoded = await entry("decoded/recent.npy", 100, 1 * MIN);
    const each = await disk(embedding);
    // One has to go: the decoded copy, though it is the newest.
    await cache({ limitBytes: Math.round(each * 2.6) }).sweep();
    expect([await exists(embedding), await exists(timeline), await exists(decoded)]).toEqual([true, true, false]);
    // When decoded copies aren't enough, embeddings go too, least recently used first.
    await cache({ limitBytes: Math.round(each * 1.3) }).sweep();
    expect([await exists(embedding), await exists(timeline)]).toEqual([false, true]);
  });

  it("ranks an entry read since it was written by when it was read, and keeps that for later sweeps", async () => {
    // Written long ago but read a minute ago (earshot loaded it for this call): newer than one written ten minutes ago.
    const read = await entry("decoded/read.npy", 100, 60 * MIN, 1 * MIN);
    const unread = await entry("decoded/unread.npy", 100, 10 * MIN);
    const each = await disk(read);
    const sweeper = cache({ limitBytes: Math.round(each * 1.5) });
    await sweeper.sweep();
    expect([await exists(read), await exists(unread)]).toEqual([true, false]);
    // When it was read is now its modification time, with the access time just before it, so the next read shows again.
    const info = await stat(read);
    expect(Math.round(info.mtimeMs)).toBe(NOW - 1 * MIN);
    expect(Math.round(info.atimeMs)).toBe(NOW - 1 * MIN - 1000);
    // And a later sweep still ranks it by that read: an entry written after it was written, but before it was read, goes first.
    const between = await entry("decoded/between.npy", 100, 3 * MIN);
    const newest = await entry("decoded/newest.npy", 100, 30 * 1000);
    await cache({ limitBytes: Math.round(each * 2.6) }).sweep();
    expect([await exists(read), await exists(between), await exists(newest)]).toEqual([true, false, true]);
  });

  it.runIf(process.platform === "darwin")("relies on macOS moving a marked entry's access time when it is read", async () => {
    const file = await entry("decoded/marked.npy", 4, 10 * MIN);
    const before = (await stat(file)).atimeMs;
    await readFile(file);
    const after = await stat(file);
    expect(after.atimeMs).toBeGreaterThan(before);
    expect(after.atimeMs).toBeGreaterThan(after.mtimeMs);
  });

  it("removes half-written entries of a worker that is gone or long stuck, and counts those still being written", async () => {
    const live = process.pid;
    const dead = await entry(`decoded/a.npy.999999.tmp.npy`, 8, 1 * MIN);
    const writing = await entry(`decoded/b.npy.${live}.tmp.npy`, 8, 1 * MIN);
    const stuck = await entry(`emb/timeline/c.json.${live}.tmp`, 8, 2 * 60 * MIN);
    const swept = await cache({ isAlive: (pid) => pid === live }).sweep();
    expect([await exists(dead), await exists(writing), await exists(stuck)]).toEqual([false, true, false]);
    expect(swept).toMatchObject({ removed: 2, bytes: await disk(writing) });
  });

  it("never touches the models, earshot's other files, or what a link points to", async () => {
    const model = await entry("hf/models--laion--larger_clap_general/blobs/9f86", 200, 90 * MIN);
    const numba = await entry("numba/librosa_core.nbi", 200, 90 * MIN);
    const refsets = await entry("refsets.json", 200, 90 * MIN);
    const outside = join(base, "elsewhere.wav");
    await writeFile(outside, Buffer.alloc(200 * 1024));
    await mkdir(join(home, "decoded"), { recursive: true });
    await symlink(outside, join(home, "decoded", "link.npy"));
    await symlink(dirname(outside), join(home, "emb"));
    const swept = await cache({ limitBytes: 1 }).sweep();
    expect(swept.bytes).toBe(0);
    expect([await exists(model), await exists(numba), await exists(refsets), await exists(outside)]).toEqual([true, true, true, true]);
  });

  it("counts only the cache folders, and treats a missing home as empty", async () => {
    await entry("decoded/a.npy", 16, MIN);
    await entry("hf/blob", 64, MIN);
    expect([...CACHE_FOLDERS].sort()).toEqual(["decoded", "emb", "kits", "sheets"]);
    expect(await cacheBytes(home)).toBe(await disk(join(home, "decoded", "a.npy")));
    expect(await cacheBytes(join(base, "missing"))).toBe(0);
    expect(await cache({ home: join(base, "missing") }).sweep()).toEqual({ bytes: 0, removed: 0, removedBytes: 0 });
  });

  it("clears the sound tools' temporary folders a quit or crash left, but not one still in use", async () => {
    const folder = async (name: string, ago: number) => {
      const path = join(temp, name);
      await mkdir(path);
      await writeFile(join(path, "x"), "x");
      await utimes(path, (NOW - ago) / 1000, (NOW - ago) / 1000);
      return path;
    };
    const oldRender = await folder(`${RENDER_TEMP_PREFIX}old`, 2 * 60 * MIN);
    const waitingRender = await folder(`${RENDER_TEMP_PREFIX}waiting`, 3 * 60 * MIN);
    const newRender = await folder(`${RENDER_TEMP_PREFIX}new`, 5 * MIN);
    const oldSheet = await folder(`${SHEET_TEMP_PREFIX}old`, 25 * 60 * MIN);
    const daySheet = await folder(`${SHEET_TEMP_PREFIX}today`, 3 * 60 * MIN);
    const other = await folder("someone-elses", 10 * 24 * 60 * MIN);
    await cache({ inUse: (path) => path === waitingRender }).sweep();
    expect(await readdir(temp).then((names) => names.sort())).toEqual([newRender, waitingRender, daySheet, other].map((path) => path.slice(temp.length + 1)).sort());
    expect([await exists(oldRender), await exists(oldSheet)]).toEqual([false, false]);
  });

  it("runs one sweep at a time: a second caller shares the one running", async () => {
    await entry("decoded/a.npy", 4, MIN);
    const sweeper = cache();
    const [first, second] = [sweeper.sweep(), sweeper.sweep()];
    expect(first).toBe(second);
    await first;
  });
});

describe("EarshotCache.size", () => {
  it("answers with the last sweep's figure while it is fresh, then measures again", async () => {
    let now = NOW;
    const sweeper = cache({ now: () => now });
    await entry("decoded/a.npy", 16, MIN);
    const first = await sweeper.size();
    expect(first).toBe(await cacheBytes(home));
    await entry("decoded/b.npy", 16, MIN);
    expect(await sweeper.size()).toBe(first);
    now += 16 * 1000;
    expect(await sweeper.size()).toBe(await cacheBytes(home));
    expect(CACHE_LIMIT_BYTES).toBe(500_000_000);
  });
});

describe("EarshotCache.keepTidy", () => {
  it("sweeps at once, then on its timer until the worker has stopped, and starts again with the next one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sweeper = cache({ everyMs: 1000 });
    const sweep = vi.spyOn(sweeper, "sweep");
    let running = true;
    sweeper.keepTidy(() => running);
    sweeper.keepTidy(() => running);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sweep).toHaveBeenCalledTimes(3);
    running = false;
    // One last sweep once the worker has stopped, then none.
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(4);
    expect(sweeper.tidying).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(4);
    running = true;
    sweeper.keepTidy(() => running);
    expect(sweep).toHaveBeenCalledTimes(5);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(5);
  });
});
