/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// earshot's caches, kept under a size limit. earshot keeps a decoded copy of
// every file it listens to in home/decoded/ (float32 at 48 kHz: about 23 MB
// per stereo minute, plus a mono copy when an action wants one) and its
// embeddings and results in home/emb/, and never removes any of them. Cutroom
// keeps them all under `CACHE_LIMIT_BYTES` (500 MB unless the service is told
// otherwise): a sweep that finds more removes the least recently used decoded
// copies until what is left is under 80% of the limit, so the calls that
// follow don't each start one, and embeddings only when that isn't enough
// (a decoded copy is the big one, and FFmpeg makes it again in moments; an
// embedding costs a model pass). A sweep runs when the worker starts and
// every two minutes while it runs. Removing an entry is always safe: earshot
// reads each one as "use it if it is there and loads, work it out again
// otherwise". The models (home/hf) and the compiled-code and font caches are
// never touched.
//
// When an entry was last used: macOS moves a file's access time on a read
// only while that time is no later than the file's modification time. So a
// sweep moves the modification time of an entry read since the last sweep up
// to when it was read, and sets its access time a second before that, which
// lets the next read move it again; entries are ranked by modification time.
// Where access times aren't kept at all, that is the order they were written
// in. earshot never looks at its cache files' own times, only at those of
// the media they come from.
//
// The same sweep clears Cutroom's own temporary folders for the sound tools
// (a sheet's picture, a render's take) that a quit or a crash left behind.

import { realpathSync } from "node:fs";
import { lstat, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderBytes } from "./process";

/** What earshot's caches may hold before a sweep trims them: 500 MB, as the Finder counts. */
export const CACHE_LIMIT_BYTES = 500 * 1000 * 1000;

/** The folders of EARSHOT_HOME that earshot fills as it works and rebuilds on demand, the cheapest to rebuild first. */
export const CACHE_FOLDERS = ["decoded", "sheets", "kits", "emb"] as const;

/** Folders a sweep empties only once the others can't bring the caches under their limit. */
const KEPT_LONGER = new Set<string>(["emb"]);

/** How often a sweep runs while the worker does. */
export const SWEEP_EVERY_MS = 2 * 60 * 1000;

/** A sweep that has to trim leaves this share of the limit. */
const LOW_WATER = 0.8;

/** How long a measured size answers for status before it is measured again (Settings asks every few seconds). */
const SIZE_FRESH_MS = 15 * 1000;

/** A half-written entry of a process that is still running is left for this long. */
const PARTIAL_STALE_MS = 60 * 60 * 1000;

/** earshot's entries being written: `<entry>.<pid>.tmp`, `<entry>.<pid>.tmp.npy`, renamed into place when whole. */
const PARTIAL = /\.(\d+)\.tmp(?:\.[A-Za-z0-9]+)?$/;

/** A render's temporary folder: its take on the way into the project, gone when the render ends. */
export const RENDER_TEMP_PREFIX = "cutroom-sfx-";
/** A sheet's temporary folder: its picture, whose path the agent was given along with the picture itself. */
export const SHEET_TEMP_PREFIX = "cutroom-sound-sheet-";

/** Cutroom's temporary folders for the sound tools, and how long each may be left. */
export const TEMP_FOLDERS: ReadonlyArray<{ prefix: string; maxAgeMs: number }> = [
  { prefix: RENDER_TEMP_PREFIX, maxAgeMs: 60 * 60 * 1000 },
  { prefix: SHEET_TEMP_PREFIX, maxAgeMs: 24 * 60 * 60 * 1000 },
];

export type CacheSweep = {
  /** What the caches hold after the sweep. */
  bytes: number;
  /** Entries removed, and what they held. */
  removed: number;
  removedBytes: number;
};

export type CacheOptions = {
  /** EARSHOT_HOME. */
  home: string;
  limitBytes?: number;
  everyMs?: number;
  /** Where the sound tools make their temporary folders (default: the system's, links resolved). */
  tempRoot?: string;
  /** A temporary folder still in use (a render waiting for its turn), which a sweep leaves. */
  inUse?: (path: string) => boolean;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
};

type Entry = { path: string; bytes: number; usedMs: number; tier: number };

/** Whether a process runs under `pid` (one of another user's counts). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function systemTemp(): string {
  try { return realpathSync.native(tmpdir()); } catch { return tmpdir(); }
}

/** What a file takes on disk, as `du` counts it. */
function diskBytes(info: { blocks: number; size: number }): number {
  return Number.isFinite(info.blocks) && info.blocks > 0 ? info.blocks * 512 : info.size;
}

/** What earshot's caches under `home` hold now. */
export async function cacheBytes(home: string): Promise<number> {
  let total = 0;
  for (const folder of CACHE_FOLDERS) total += await folderBytes(join(home, folder));
  return total;
}

export class EarshotCache {
  readonly home: string;
  readonly limitBytes: number;
  private readonly everyMs: number;
  private readonly tempRoot: string;
  private readonly inUse: (path: string) => boolean;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly log: (line: string) => void;

  private sweeping: Promise<CacheSweep> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private measured: { at: number; bytes: Promise<number> } | null = null;

  constructor(options: CacheOptions) {
    this.home = options.home;
    this.limitBytes = options.limitBytes ?? CACHE_LIMIT_BYTES;
    this.everyMs = options.everyMs ?? SWEEP_EVERY_MS;
    this.tempRoot = options.tempRoot ?? systemTemp();
    this.inUse = options.inUse ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.isAlive = options.isAlive ?? processAlive;
    this.log = options.log ?? ((line) => console.info(`[earshot] ${line}`));
  }

  /** Whether sweeps are running on their timer. */
  get tidying(): boolean {
    return this.timer !== null;
  }

  /**
   * Sweeps now, then every `everyMs` until a sweep finds `active` false (the
   * worker has stopped), which is the last. Calling it again while it runs
   * changes nothing.
   */
  keepTidy(active: () => boolean): void {
    if (this.timer) return;
    void this.sweepQuietly();
    this.timer = setInterval(() => {
      void this.sweepQuietly();
      if (!active()) this.stop();
    }, this.everyMs);
    this.timer.unref?.();
  }

  /** No more sweeps on the timer (Remove, quitting). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The add-on's folder is gone (Remove): nothing measured before stands. */
  forget(): void {
    this.measured = null;
  }

  /** What the caches hold, for Settings: the last sweep's figure while it is fresh, measured otherwise. */
  size(): Promise<number> {
    const now = this.now();
    if (!this.measured || now - this.measured.at > SIZE_FRESH_MS) {
      this.measured = { at: now, bytes: cacheBytes(this.home).catch(() => 0) };
    }
    return this.measured.bytes;
  }

  private async sweepQuietly(): Promise<void> {
    try {
      const swept = await this.sweep();
      if (swept.removed) this.log(`cache: removed ${swept.removed} entries (${Math.round(swept.removedBytes / 1e6)} MB), ${Math.round(swept.bytes / 1e6)} MB left`);
    } catch (error) {
      this.log(`cache sweep failed: ${(error as Error).message}`);
    }
  }

  /** One sweep (or the one already running). */
  sweep(): Promise<CacheSweep> {
    this.sweeping ??= this.run().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async run(): Promise<CacheSweep> {
    const now = this.now();
    await this.clearTemp(now);
    const entries: Entry[] = [];
    let busy = 0;
    let removed = 0;
    let removedBytes = 0;
    const visit = async (path: string, tier: number): Promise<void> => {
      const info = await lstat(path).catch(() => null);
      if (!info) return;
      if (info.isDirectory()) {
        for (const name of await readdir(path).catch(() => [] as string[])) await visit(join(path, name), tier);
        return;
      }
      // Links and anything else that isn't a plain file are neither counted nor followed.
      if (!info.isFile()) return;
      const bytes = diskBytes(info);
      const partial = PARTIAL.exec(path);
      if (partial) {
        // Left by a worker that was ended mid-write (a canceled call), or still being written.
        if (!this.isAlive(Number(partial[1])) || now - info.mtimeMs > PARTIAL_STALE_MS) {
          if (await rm(path, { force: true }).then(() => true, () => false)) { removed++; removedBytes += bytes; }
        } else {
          busy += bytes;
        }
        return;
      }
      let usedMs = info.mtimeMs;
      // Read since the last sweep (or not marked yet): its modification time becomes when it was last used, and its access time goes just before that, so the next read shows.
      if (info.atimeMs >= info.mtimeMs - 1) {
        usedMs = Math.max(info.atimeMs, info.mtimeMs);
        await utimes(path, (usedMs - 1000) / 1000, usedMs / 1000).catch(() => {});
      }
      entries.push({ path, bytes, usedMs, tier });
    };
    for (const folder of CACHE_FOLDERS) await visit(join(this.home, folder), KEPT_LONGER.has(folder) ? 1 : 0);

    let total = busy + entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (total > this.limitBytes) {
      const target = this.limitBytes * LOW_WATER;
      entries.sort((a, b) => a.tier - b.tier || a.usedMs - b.usedMs);
      for (const entry of entries) {
        if (total <= target) break;
        if (!(await rm(entry.path, { force: true }).then(() => true, () => false))) continue;
        total -= entry.bytes;
        removed++;
        removedBytes += entry.bytes;
      }
    }
    this.measured = { at: this.now(), bytes: Promise.resolve(total) };
    return { bytes: total, removed, removedBytes };
  }

  /** The sound tools' temporary folders older than they may be, unless still in use. */
  private async clearTemp(now: number): Promise<void> {
    const names = await readdir(this.tempRoot).catch(() => [] as string[]);
    for (const name of names) {
      const rule = TEMP_FOLDERS.find((candidate) => name.startsWith(candidate.prefix));
      if (!rule) continue;
      const path = join(this.tempRoot, name);
      if (this.inUse(path)) continue;
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory() || now - info.mtimeMs < rule.maxAgeMs) continue;
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}
