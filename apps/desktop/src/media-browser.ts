/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Media tab's view of the computer: places, one folder at a time, and what
// a clip is. Read-only by construction: the only things it can do to a folder
// are list it, stat what is in it and hand a file to ffprobe. The editor's
// footage lives in these folders, so nothing here writes, caches or deletes.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { MediaDetails, MediaEntry, MediaListing, MediaPlace, MediaProbe } from "./main-channels";

type DirEntry = { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
type StatInfo = { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number; blocks: number };
type RunResult = { stdout: string; stderr: string; failed: boolean };

export type MediaBrowserDeps = {
  readdir: (path: string) => Promise<DirEntry[]>;
  stat: (path: string) => Promise<StatInfo>;
  /** Runs a program; rejects with an AbortError when `signal` aborts. */
  run: (file: string, args: string[], signal: AbortSignal) => Promise<RunResult>;
  ffprobe: string | null;
  /** The user's own folders, by Finder's names for them. */
  folders: { movies: string; desktop: string; downloads: string; documents: string };
  volumesDir?: string;
  /** How many stats run at once while a folder is listed. */
  statConcurrency?: number;
  /** How many clips are probed at once, so a burst of selections can't flood a slow drive. */
  probeConcurrency?: number;
};

/**
 * A file the cloud has not downloaded: it has a size but no blocks on disk.
 * Reading it would start a download, so the browser must not.
 */
export function isCloudOnly(info: Pick<StatInfo, "isFile" | "size" | "blocks">): boolean {
  return info.isFile() && info.size > 0 && info.blocks === 0;
}

/** Finder hides these, and so does the browser. */
const isHidden = (name: string): boolean => name.startsWith(".") || name === "Icon\r";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/** `a/b` frame rates as ffprobe writes them; 0/0 and garbage are undefined. */
function frameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [num, den] = value.split("/").map(Number);
  const rate = den === undefined ? num : num / den;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : undefined;
}

const positive = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

/** What a clip is, from ffprobe's `-show_format -show_streams -of json`. Cover art is not a picture track. */
export function parseProbe(stdout: string): MediaDetails {
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<Record<string, unknown> & { disposition?: { attached_pic?: number } }>;
  };
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const details: MediaDetails = {};
  const duration = positive(data.format?.duration);
  if (duration !== undefined) details.duration = duration;
  if (data.format?.format_name) details.container = data.format.format_name;
  if (video) {
    if (typeof video.codec_name === "string") details.videoCodec = video.codec_name;
    const width = positive(video.width);
    const height = positive(video.height);
    if (width !== undefined && height !== undefined) Object.assign(details, { width, height });
    const rate = frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate);
    if (rate !== undefined) details.frameRate = rate;
  }
  if (audio) {
    if (typeof audio.codec_name === "string") details.audioCodec = audio.codec_name;
    const sampleRate = positive(audio.sample_rate);
    if (sampleRate !== undefined) details.sampleRate = sampleRate;
    const channels = positive(audio.channels);
    if (channels !== undefined) details.channels = channels;
  }
  return details;
}

/** Runs at most `limit` tasks at a time, in the order they ask. */
function limiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export class MediaBrowser {
  private readonly reads = new Map<string, AbortController>();
  private readonly probeSlot: ReturnType<typeof limiter>;
  private readonly deps: MediaBrowserDeps;

  constructor(deps: MediaBrowserDeps) {
    this.deps = deps;
    this.probeSlot = limiter(deps.probeConcurrency ?? 2);
  }

  /** Favorites that exist, then every mounted volume. */
  async places(): Promise<MediaPlace[]> {
    const { folders } = this.deps;
    const favorites: Array<[string, string]> = [
      ["Movies", folders.movies],
      ["Desktop", folders.desktop],
      ["Downloads", folders.downloads],
      ["Documents", folders.documents],
    ];
    const places: MediaPlace[] = [];
    for (const [label, path] of favorites) {
      if (await this.isDirectory(path)) places.push({ label, path, group: "favorites" });
    }
    const volumesDir = this.deps.volumesDir ?? "/Volumes";
    let volumes: DirEntry[] = [];
    try {
      volumes = await this.deps.readdir(volumesDir);
    } catch {
      // No volumes folder (not macOS): favorites alone.
    }
    for (const volume of volumes) {
      if (isHidden(volume.name)) continue;
      const path = join(volumesDir, volume.name);
      // The startup disk is a link to `/`; it is a place like any other.
      if (volume.isDirectory() || (volume.isSymbolicLink() && await this.isDirectory(path))) {
        places.push({ label: volume.name, path, group: "volumes" });
      }
    }
    return places;
  }

  /**
   * One folder's entries, shallow. Stats run a few at a time, so a folder of
   * thousands on a slow drive doesn't flood it, and stop when `request` is cancelled.
   */
  async list(path: string, request: string): Promise<MediaListing> {
    const signal = this.begin(request);
    try {
      let names: DirEntry[];
      try {
        names = await this.deps.readdir(path);
      } catch (error) {
        const code = errorCode(error);
        const status = code === "EPERM" || code === "EACCES" ? "denied" : "missing";
        return { status, path, entries: [] };
      }
      const visible = names.filter((entry) => !isHidden(entry.name));
      const entries: MediaEntry[] = [];
      const batch = this.deps.statConcurrency ?? 32;
      for (let start = 0; start < visible.length; start += batch) {
        if (signal.aborted) return { status: "cancelled", path, entries: [] };
        const stats = await Promise.all(visible.slice(start, start + batch).map((entry) => this.entry(path, entry)));
        for (const entry of stats) if (entry) entries.push(entry);
      }
      if (signal.aborted) return { status: "cancelled", path, entries: [] };
      return { status: "ok", path, entries };
    } finally {
      this.end(request, signal);
    }
  }

  /** What a clip is. Never touches a cloud-only file, which reading would download. */
  async probe(path: string, request: string): Promise<MediaProbe> {
    const signal = this.begin(request);
    try {
      const ffprobe = this.deps.ffprobe;
      if (!ffprobe) return { status: "unavailable" };
      try {
        if (isCloudOnly(await this.deps.stat(path))) return { status: "cloud" };
      } catch (error) {
        return { status: "failed", error: errorCode(error) === "ENOENT" ? "The file is gone." : "The file can't be read." };
      }
      return await this.probeSlot(async (): Promise<MediaProbe> => {
        if (signal.aborted) return { status: "cancelled" };
        try {
          const { stdout, stderr, failed } = await this.deps.run(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], signal);
          if (failed) return { status: "failed", error: stderr.trim().split("\n").pop() || "ffprobe could not read the file" };
          return { status: "ok", details: parseProbe(stdout) };
        } catch (error) {
          if (isAbort(error) || signal.aborted) return { status: "cancelled" };
          return { status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      });
    } finally {
      this.end(request, signal);
    }
  }

  /** Stops a list or probe still running under `request`. */
  cancel(request: string): void {
    this.reads.get(request)?.abort();
  }

  private begin(request: string): AbortSignal {
    // A new read under the same name replaces the old one, which stops.
    this.reads.get(request)?.abort();
    const controller = new AbortController();
    this.reads.set(request, controller);
    return controller.signal;
  }

  private end(request: string, signal: AbortSignal): void {
    if (this.reads.get(request)?.signal === signal) this.reads.delete(request);
  }

  private async entry(dir: string, entry: DirEntry): Promise<MediaEntry | null> {
    if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) return null;
    const path = join(dir, entry.name);
    try {
      const info = await this.deps.stat(path);
      if (!info.isFile() && !info.isDirectory()) return null;
      return {
        name: entry.name,
        path,
        kind: info.isDirectory() ? "directory" : "file",
        size: info.size,
        mtime: info.mtimeMs,
        ...(isCloudOnly(info) ? { cloud: true } : {}),
      };
    } catch {
      // A broken link, or a file gone since the folder was read.
      return null;
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await this.deps.stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}

/** Runs a program to completion; aborting the signal kills it. */
export function runProgram(file: string, args: string[], signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { signal, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && error.name === "AbortError") return reject(error);
      resolve({ stdout: String(stdout), stderr: String(stderr), failed: !!error });
    });
  });
}

/** The browser with the real file system and ffprobe. */
export function createMediaBrowser(options: Pick<MediaBrowserDeps, "ffprobe" | "folders">): MediaBrowser {
  return new MediaBrowser({
    readdir: (path) => readdir(path, { withFileTypes: true }),
    stat: (path) => stat(path),
    run: runProgram,
    ...options,
  });
}
