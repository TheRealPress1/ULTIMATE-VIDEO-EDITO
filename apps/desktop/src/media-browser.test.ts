import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCloudOnly, MediaBrowser, parseProbe, runProgram, type MediaBrowserDeps } from "./media-browser";

/** A one-second silent 8 kHz mono WAV: synthetic media, made here. */
function silentWav(seconds = 1, rate = 8000): Buffer {
  const samples = seconds * rate;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

function systemFfprobe(): string | null {
  try {
    return execFileSync("which", ["ffprobe"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Every name, size and mtime under `dir`: what a read-only browser must leave alone. */
async function snapshot(dir: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await stat(full);
      lines.push(`${full.slice(dir.length)} ${info.isDirectory() ? "dir" : info.size} ${info.mtimeMs}`);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return lines.sort();
}

const fileStat = (size: number, blocks: number) => ({ isFile: () => true, isDirectory: () => false, size, mtimeMs: 1, blocks });
const dirent = (name: string) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
const noRun: MediaBrowserDeps["run"] = () => Promise.reject(new Error("run should not be called"));

describe("media browser", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "media-browser-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const real = (overrides: Partial<MediaBrowserDeps> = {}): MediaBrowser => new MediaBrowser({
    readdir: (path) => readdir(path, { withFileTypes: true }),
    stat: (path) => stat(path),
    run: noRun,
    ffprobe: null,
    folders: { movies: join(root, "Movies"), desktop: join(root, "Desktop"), downloads: join(root, "Downloads"), documents: join(root, "Documents") },
    volumesDir: join(root, "Volumes"),
    ...overrides,
  });

  it("offers favorites that exist, then mounted volumes, with hidden ones left out", async () => {
    await mkdir(join(root, "Movies"));
    await mkdir(join(root, "Downloads"));
    await mkdir(join(root, "Volumes", "Shoot Drive"), { recursive: true });
    await mkdir(join(root, "Volumes", ".timemachine"));
    await mkdir(join(root, "Boot"));
    await symlink(join(root, "Boot"), join(root, "Volumes", "Startup"));

    const places = await real().places();
    expect(places).toEqual([
      { label: "Movies", path: join(root, "Movies"), group: "favorites" },
      { label: "Downloads", path: join(root, "Downloads"), group: "favorites" },
      { label: "Shoot Drive", path: join(root, "Volumes", "Shoot Drive"), group: "volumes" },
      { label: "Startup", path: join(root, "Volumes", "Startup"), group: "volumes" },
    ]);
  });

  it("lists one folder shallowly, skipping hidden files", async () => {
    await mkdir(join(root, "Day 1", "A001"), { recursive: true });
    await writeFile(join(root, "Day 1", "clip.wav"), silentWav());
    await writeFile(join(root, "Day 1", ".DS_Store"), "x");
    await writeFile(join(root, "Day 1", "A001", "deep.wav"), silentWav());

    const listing = await real().list(join(root, "Day 1"), "r");
    expect(listing.status).toBe("ok");
    expect(listing.entries.map((entry) => [entry.name, entry.kind]).sort()).toEqual([["A001", "directory"], ["clip.wav", "file"]]);
    expect(listing.entries.find((entry) => entry.name === "clip.wav")?.path).toBe(join(root, "Day 1", "clip.wav"));
  });

  it("says a folder macOS refused is denied, not empty", async () => {
    const browser = real({ readdir: () => Promise.reject(Object.assign(new Error("no"), { code: "EPERM" })) });
    expect(await browser.list("/Volumes/Card", "r")).toEqual({ status: "denied", path: "/Volumes/Card", entries: [] });
    const gone = real({ readdir: () => Promise.reject(Object.assign(new Error("no"), { code: "ENOENT" })) });
    expect((await gone.list("/nowhere", "r")).status).toBe("missing");
  });

  it("marks files the cloud has not downloaded", async () => {
    expect(isCloudOnly(fileStat(1000, 0))).toBe(true);
    expect(isCloudOnly(fileStat(1000, 8))).toBe(false);
    expect(isCloudOnly(fileStat(0, 0))).toBe(false);

    const browser = real({
      readdir: async () => [dirent("in-cloud.mov"), dirent("local.mov")],
      stat: async (path) => fileStat(1000, path.endsWith("in-cloud.mov") ? 0 : 8),
    });
    const listing = await browser.list("/x", "r");
    expect(listing.entries.find((entry) => entry.name === "in-cloud.mov")?.cloud).toBe(true);
    expect(listing.entries.find((entry) => entry.name === "local.mov")?.cloud).toBeUndefined();
  });

  it("never probes a cloud-only file", async () => {
    const run = vi.fn(noRun);
    const browser = real({ ffprobe: "/bin/ffprobe", run, stat: async () => fileStat(1000, 0) });
    expect(await browser.probe("/x/in-cloud.mov", "p")).toEqual({ status: "cloud" });
    expect(run).not.toHaveBeenCalled();
  });

  it("stops a listing when it is cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stats = vi.fn(async () => {
      await gate;
      return fileStat(10, 1);
    });
    const names = Array.from({ length: 10 }, (_, index) => dirent(`clip-${index}.mov`));
    const browser = real({ readdir: async () => names, stat: stats, statConcurrency: 2 });

    const pending = browser.list("/big", "folder");
    await vi.waitFor(() => expect(stats).toHaveBeenCalledTimes(2));
    browser.cancel("folder");
    release();
    expect(await pending).toEqual({ status: "cancelled", path: "/big", entries: [] });
    // The first batch was in flight; nothing after it started.
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it("kills a probe when it is cancelled, or replaced by one under the same name", async () => {
    const signals: AbortSignal[] = [];
    const run: MediaBrowserDeps["run"] = (_file, _args, signal) => new Promise((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const browser = real({ ffprobe: "/bin/ffprobe", run, stat: async () => fileStat(10, 1) });

    const first = browser.probe("/a.mov", "details");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = browser.probe("/b.mov", "details");
    expect(await first).toEqual({ status: "cancelled" });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    browser.cancel("details");
    expect(await second).toEqual({ status: "cancelled" });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("probes no more than its limit at once", async () => {
    let active = 0;
    let peak = 0;
    const run: MediaBrowserDeps["run"] = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { stdout: "{}", stderr: "", failed: false };
    };
    const browser = real({ ffprobe: "/bin/ffprobe", run, stat: async () => fileStat(10, 1), probeConcurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, index) => browser.probe(`/${index}.mov`, `p${index}`)));
    expect(peak).toBe(2);
  });

  it("reads codec, size, rate and duration from ffprobe, ignoring cover art", () => {
    const details = parseProbe(JSON.stringify({
      format: { duration: "12.512000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      streams: [
        { codec_type: "video", codec_name: "mjpeg", width: 300, height: 300, disposition: { attached_pic: 1 } },
        { codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, avg_frame_rate: "30000/1001" },
        { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
      ],
    }));
    expect(details).toEqual({
      duration: 12.512,
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      videoCodec: "hevc",
      width: 3840,
      height: 2160,
      frameRate: 29.97,
      audioCodec: "aac",
      sampleRate: 48000,
      channels: 2,
    });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "0/0", r_frame_rate: "25/1" }] })).frameRate).toBe(25);
  });

  it("leaves the folders it browses exactly as they were", async () => {
    const footage = join(root, "Footage");
    await mkdir(join(footage, "Card A"), { recursive: true });
    await writeFile(join(footage, "Card A", "tone.wav"), silentWav());
    await writeFile(join(footage, "notes.txt"), "slate 1");
    const before = await snapshot(footage);

    const ffprobe = systemFfprobe();
    const browser = real(ffprobe ? { ffprobe, run: runProgram } : {});
    await browser.places();
    await browser.list(footage, "a");
    await browser.list(join(footage, "Card A"), "b");
    const probe = await browser.probe(join(footage, "Card A", "tone.wav"), "c");
    if (ffprobe) expect(probe).toMatchObject({ status: "ok", details: { duration: 1, audioCodec: "pcm_s16le" } });

    expect(await snapshot(footage)).toEqual(before);
  });
});
