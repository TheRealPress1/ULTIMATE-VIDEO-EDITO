/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EarshotInstaller, InstallCanceled, STEPS } from "./install";
import { EARSHOT, MODELS, STEP_PINS, TORCH, UV } from "./pins";
import { cacheBytes } from "./cache";
import { ChecksumError, folderBytes } from "./process";

import type { InstallerOptions } from "./install";
import type { PinnedFile } from "./pins";
import type { RunOptions, RunResult } from "./process";

type Call = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv };

/**
 * uv, Python, FFmpeg and earshot as far as the installer can tell: each
 * command answers as the real one does and leaves the files it would.
 */
class FakeTools {
  calls: Call[] = [];
  installed = new Map<string, string>();
  /** Makes the next command whose args include this fail, once. */
  failOn: { match: string; stderr: string } | null = null;
  hold: Promise<void> | null = null;
  /** Holds the commands whose line includes `match` until `until` settles. */
  holdOn: { match: string; until: Promise<void> } | null = null;

  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  run = async (command: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
    this.calls.push({ command, args, env: options.env });
    const line = [command, ...args].join(" ");
    if (this.hold) await this.hold;
    if (this.holdOn && line.includes(this.holdOn.match)) await this.holdOn.until;
    options.signal?.throwIfAborted();
    const ok = (stdout = ""): RunResult => ({ code: 0, signal: null, stdout, stderr: "" });
    if (this.failOn && line.includes(this.failOn.match)) {
      const { stderr } = this.failOn;
      this.failOn = null;
      return { code: 2, signal: null, stdout: "", stderr };
    }
    const root = this.root;
    if (command.endsWith("/bin/uv")) {
      if (args[0] === "--version") return ok(`uv ${UV.version} (316c827e0 2026-11-03 aarch64-apple-darwin)\n`);
      if (args[0] === "python" && args[1] === "install") {
        await mkdir(join(root, "python", "cpython-3.12.16-macos-aarch64-none", "bin"), { recursive: true });
        await writeFile(join(root, "python", "cpython-3.12.16-macos-aarch64-none", "bin", "python3.12"), "#!python");
        return ok();
      }
      if (args[0] === "venv") {
        await mkdir(join(root, "venv", "bin"), { recursive: true });
        await writeFile(join(root, "venv", "bin", "python"), "#!python");
        return ok();
      }
      if (args[0] === "pip" && args[1] === "install") {
        await mkdir(join(root, "cache", "wheels"), { recursive: true });
        await writeFile(join(root, "cache", "wheels", `w${this.calls.length}`), "x".repeat(4096));
        if (args.some((arg) => arg.startsWith("torch @ file://"))) this.installed.set("torch", TORCH.version);
        if (args.some((arg) => arg.startsWith("earshot[mcp] @ file://"))) {
          this.installed.set("earshot", EARSHOT.version);
          this.installed.set("mcp", "2.3.0");
          this.installed.set("transformers", "5.20.2");
        }
        await mkdir(join(root, "venv", "lib"), { recursive: true });
        await writeFile(join(root, "venv", "lib", "site.py"), "x".repeat(8192));
        return ok();
      }
      if (args[0] === "pip" && args[1] === "list") {
        return ok(JSON.stringify([...this.installed].map(([name, version]) => ({ name, version }))));
      }
    }
    if (command.endsWith("/venv/bin/python")) {
      if (args[0] === "-I") return ok("3.12.16\n");
      if (args.join(" ") === "-m earshot doctor --fetch --json") {
        // As huggingface_hub fills a cache_dir: the snapshot's files are links into blobs/.
        for (const model of MODELS) {
          const repo = join(root, "home", "hf", `models--${model.id.replace(/\//g, "--")}`);
          const file = join(repo, "snapshots", model.revision, model.weights);
          await mkdir(join(repo, "blobs"), { recursive: true });
          await writeFile(join(repo, "blobs", "9f86d081884c7d65"), "weights");
          await mkdir(dirname(file), { recursive: true });
          await symlink(join("..", "..", "blobs", "9f86d081884c7d65"), file);
        }
        return ok(JSON.stringify({ fetched: Object.fromEntries(MODELS.map((m) => [m.id, "downloaded abc1234"])), models_cached: Object.fromEntries(MODELS.map((m) => [m.id, true])), problems: [] }));
      }
      if (args.join(" ") === "-m earshot doctor --load --json") {
        // Loading CLAP starts its embedding cache, which belongs to the caches rather than the install.
        await mkdir(join(root, "home", "emb", "clap"), { recursive: true });
        await writeFile(join(root, "home", "emb", "clap", "text.npz"), "x".repeat(64 * 1024));
        return ok(JSON.stringify({ clap_load_s: 3.1, ast_load_s: 1.2, problems: [] }));
      }
    }
    if (command.endsWith("/ffmpeg/ffmpeg") || command.endsWith("/ffmpeg/ffprobe")) {
      return ok(`${command.split("/").pop()} version 9.0.2-https://www.martin-riedl.de Copyright (c) 2000-2026 the FFmpeg developers\n`);
    }
    return { code: 127, signal: null, stdout: "", stderr: `unexpected command: ${line}` };
  };

  extract = async (_archive: string, into: string, members: readonly string[]) => {
    for (const member of members) {
      await mkdir(dirname(join(into, member)), { recursive: true });
      await writeFile(join(into, member), `binary ${member}`);
    }
  };

  lines(): string[] {
    return this.calls.map((call) => [call.command.replace(this.root, "<root>"), ...call.args.map((arg) => arg.replace(this.root, "<root>"))].join(" "));
  }
}

let base: string;
let userData: string;
let root: string;
let tools: FakeTools;
let downloads: PinnedFile[];
let failDownload: ((file: PinnedFile) => Error | null) | null;

const download: NonNullable<InstallerOptions["download"]> = async (file, dest, signal, onBytes) => {
  signal.throwIfAborted();
  downloads.push(file);
  const error = failDownload?.(file);
  if (error) throw error;
  await writeFile(dest, "archive");
  onBytes(file.bytes);
};

/** Waits (a few seconds at most) for `condition`, rather than for a time the machine's load decides. */
async function until(condition: () => boolean): Promise<void> {
  for (let wait = 0; wait < 400 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

function installer(options: Partial<InstallerOptions> = {}): EarshotInstaller {
  return new EarshotInstaller({
    root, userData, arch: "arm64", platform: "darwin",
    run: tools.run, extract: tools.extract, download,
    freeBytes: async () => 100 * 1024 ** 3,
    log: () => {}, pollMs: 5,
    ...options,
  });
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "earshot-install-")));
  userData = join(base, "Application Support", "Blackout");
  root = join(userData, "addons", "earshot");
  await mkdir(userData, { recursive: true });
  tools = new FakeTools(root);
  downloads = [];
  failDownload = null;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("EarshotInstaller", () => {
  it("installs in five steps into the add-on's folder, every cache inside it, and reports ready", async () => {
    const install = installer();
    expect((await install.status()).state).toBe("not-installed");
    await install.ensureInstalled();

    const status = await install.status();
    expect(status.state).toBe("ready");
    expect(status.versions).toMatchObject({ earshot: "0.4.0", commit: EARSHOT.commit, uv: UV.version, python: "3.12.16", torch: TORCH.version, ffmpeg: "9.0.2" });
    expect(status.versions?.packages).toMatchObject({ earshot: "0.4.0", torch: TORCH.version, mcp: "2.3.0" });
    expect(status.sizeBytes).toBeGreaterThan(0);
    // The install alone: earshot's caches are counted as they are now, by the service.
    expect(status.sizeBytes).toBe((await folderBytes(root)) - (await cacheBytes(join(root, "home"))));
    expect(await cacheBytes(join(root, "home"))).toBeGreaterThan(0);
    expect(downloads.map((file) => file.url)).toEqual([
      UV.assets.arm64.url,
      EARSHOT.archive.url,
      TORCH.wheel.url,
      expect.stringContaining("/arm64/1789931890_9.0.2/ffmpeg.zip"),
      expect.stringContaining("/arm64/1789931890_9.0.2/ffprobe.zip"),
    ]);

    const lines = tools.lines();
    expect(lines).toContain(`<root>/bin/uv python install 3.12 --no-bin`);
    expect(lines).toContain(`<root>/bin/uv venv --clear --no-project --managed-python --python 3.12 <root>/venv`);
    // One install: torch is the wheel fetched and checked above, by its file URL, never a name an index answers for.
    const installs = lines.filter((line) => line.includes(" pip install "));
    expect(installs).toHaveLength(1);
    const earshotInstall = installs[0]!;
    const downloaded = `file://${root.replace(/ /g, "%20")}/downloads`;
    expect(earshotInstall).toContain(`--index-url https://pypi.org/simple --exclude-newer ${EARSHOT.released} --only-binary :all: --no-binary earshot torch @ ${downloaded}/torch-${TORCH.version}-cp312-cp312-macosx_11_0_arm64.whl`);
    expect(lines.some((line) => line.includes("pytorch.org") || line.includes("torch=="))).toBe(false);
    // The pinned archive, by a file URL (spaces percent-encoded), never git.
    expect(earshotInstall).toContain(`earshot[mcp] @ ${downloaded}/earshot-${EARSHOT.commit}.tar.gz`);
    expect(lines.some((line) => line.includes("git+"))).toBe(false);
    expect(lines).toContain(`<root>/venv/bin/python -m earshot doctor --fetch --json`);

    const uvEnv = tools.calls.find((call) => call.args[0] === "python")!.env;
    expect(uvEnv).toMatchObject({ UV_CACHE_DIR: join(root, "cache"), UV_PYTHON_INSTALL_DIR: join(root, "python"), UV_NO_CONFIG: "1", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    const doctorEnv = tools.calls.find((call) => call.args.includes("doctor"))!.env;
    expect(doctorEnv).toMatchObject({ EARSHOT_HOME: join(root, "home"), HF_HOME: join(root, "home", "hf-home"), PYTHONNOUSERSITE: "1" });
    expect(doctorEnv.PATH!.startsWith(join(root, "ffmpeg"))).toBe(true);
    expect(doctorEnv.EARSHOT_OFFLINE).toBeUndefined();
    // Then both models load once, offline, so the first tool call doesn't wait out the first-ever load.
    const warm = tools.calls.find((call) => call.args.includes("--load"))!;
    expect(warm.args).toEqual(["-m", "earshot", "doctor", "--load", "--json"]);
    expect(warm.env).toMatchObject({ EARSHOT_OFFLINE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });

    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(Object.keys(state.steps)).toEqual(STEPS.map((step) => step.id));
    for (const step of STEPS) expect(state.steps[step.id].pin).toBe(STEP_PINS[step.id]);
    // Caches and downloads go once the install is done.
    await expect(stat(join(root, "cache"))).rejects.toThrow();
    await expect(stat(join(root, "downloads"))).rejects.toThrow();
    expect((await stat(join(root, "bin", "uv"))).mode & 0o111).toBeTruthy();
  });

  it("skips what is done: ready starts nothing, a half-done install resumes at the step that stopped", async () => {
    tools.failOn = { match: "doctor --fetch", stderr: "Traceback\nOSError: [Errno 28] No space left on device" };
    const first = installer();
    await expect(first.ensureInstalled()).rejects.toThrow("Downloading the sound models failed: OSError: [Errno 28] No space left on device");
    const failed = await first.status();
    expect(failed).toMatchObject({ state: "failed", error: "Downloading the sound models failed: OSError: [Errno 28] No space left on device", step: { index: 5, count: 5, id: "models" } });

    // A fresh installer (an app restart) reads state.json and redoes only the models.
    tools.calls = [];
    downloads = [];
    const second = installer();
    expect((await second.status()).state).toBe("failed");
    await second.ensureInstalled();
    expect((await second.status()).state).toBe("ready");
    expect(downloads).toEqual([]);
    expect(tools.lines().filter((line) => / (install|venv) /.test(line))).toEqual([]);
    expect(tools.lines()).toContain("<root>/venv/bin/python -m earshot doctor --fetch --json");

    tools.calls = [];
    await second.ensureInstalled();
    expect(tools.calls).toEqual([]);
  });

  it("refuses a download whose checksum is wrong, leaves the step undone and retries on the next call", async () => {
    failDownload = (file) => (file.url.endsWith("ffprobe.zip") ? new ChecksumError("ffprobe.zip didn't match its pinned SHA-256 (got 0123456789ab…), so it wasn't used.") : null);
    const install = installer();
    await expect(install.ensureInstalled()).rejects.toThrow(/ffprobe.zip didn't match its pinned SHA-256/);
    const status = await install.status();
    expect(status).toMatchObject({ state: "failed", step: { id: "ffmpeg", index: 4 } });
    await expect(stat(join(root, "downloads"))).rejects.toThrow();
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.steps.ffmpeg).toBeUndefined();
    expect(state.steps.packages.pin).toBe(STEP_PINS.packages);

    failDownload = null;
    downloads = [];
    await install.ensureInstalled();
    expect((await install.status()).state).toBe("ready");
    expect(downloads.map((file) => file.url.split("/").pop())).toEqual(["ffmpeg.zip", "ffprobe.zip"]);
  });

  it("installs no torch the pinned digest didn't vouch for", async () => {
    expect(TORCH.wheel).toMatchObject({ url: expect.stringMatching(/^https:\/\/download\.pytorch\.org\/whl\/cpu\/torch-2\.11\.0-cp312-cp312-macosx_\d+_\d+_arm64\.whl$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    failDownload = (file) => (file === TORCH.wheel ? new ChecksumError("torch-2.11.0-cp312-cp312-macosx_11_0_arm64.whl didn't match its pinned SHA-256 (got 0123456789ab…), so it wasn't used.") : null);
    const install = installer();
    await expect(install.ensureInstalled()).rejects.toThrow(/arm64\.whl didn't match its pinned SHA-256/);
    expect(await install.status()).toMatchObject({ state: "failed", step: { id: "packages", index: 3 } });
    expect(tools.lines().some((line) => line.includes(" pip install "))).toBe(false);
    expect(tools.installed.has("torch")).toBe(false);
  });

  it("runs one install at a time: concurrent callers share it", async () => {
    let release!: () => void;
    tools.hold = new Promise<void>((resolve) => (release = resolve));
    const install = installer();
    const a = install.ensureInstalled();
    const b = install.ensureInstalled();
    expect(a).toBe(b);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await install.status()).state).toBe("installing");
    release();
    tools.hold = null;
    await Promise.all([a, b]);
    expect(tools.lines().filter((line) => line.endsWith("python install 3.12 --no-bin"))).toHaveLength(1);
  });

  it("reports the step and the bytes while installing", async () => {
    let release!: () => void;
    const install = installer();
    tools.hold = new Promise<void>((resolve) => (release = resolve));
    const running = install.ensureInstalled();
    // Held at `uv --version`, once the archive is in.
    await until(() => tools.calls.length > 0);
    const status = await install.status();
    expect(status.state).toBe("installing");
    expect(status.step).toMatchObject({ index: 1, count: 5, id: "uv" });
    expect(status.progress!.bytes).toBeGreaterThan(0);
    expect(status.progress!.totalBytes).toBe(STEPS.reduce((sum, step) => sum + step.expectBytes, 0));
    expect(install.describe(status)).toMatch(/^step 1\/5, \d+ of [\d,]+ MB$/);
    tools.hold = null;
    release();
    await running;
  });

  it("re-runs only the step whose pin moved", async () => {
    const install = installer();
    await install.ensureInstalled();
    const statePath = join(root, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.steps.ffmpeg.pin = "ffmpeg 8.0";
    await writeFile(statePath, JSON.stringify(state));
    tools.calls = [];
    downloads = [];
    const next = installer();
    // Outdated: not installed, with what it holds on disk, which Remove would free.
    const outdated = await next.status();
    expect(outdated).toMatchObject({ state: "not-installed", partial: true });
    expect(outdated.sizeBytes).toBeGreaterThan(0);
    await next.ensureInstalled();
    expect(downloads.map((file) => file.url.split("/").pop())).toEqual(["ffmpeg.zip", "ffprobe.zip"]);
    // The models, links into Hugging Face's blobs/, still check out: neither fetched nor loaded again.
    expect(tools.lines().filter((line) => line.includes("doctor"))).toEqual([]);
    expect((await next.status()).state).toBe("ready");
  });

  it("reports what a stopped install left on disk, and Remove frees it", async () => {
    let release!: () => void;
    tools.holdOn = { match: "pip install", until: new Promise<void>((resolve) => (release = resolve)) };
    const first = installer();
    const running = first.ensureInstalled();
    await until(() => tools.lines().some((line) => line.includes("pip install")));
    // Cutroom quits in step 3: no error is recorded.
    first.dispose();
    release();
    await expect(running).rejects.toBeInstanceOf(InstallCanceled);

    const next = installer();
    const status = await next.status();
    expect(status).toMatchObject({ root, state: "not-installed", partial: true });
    expect(status.sizeBytes).toBeGreaterThan(0);
    expect(status.error).toBeUndefined();
    await next.remove();
    await expect(stat(root)).rejects.toThrow();
    expect(await next.status()).toEqual({ root, state: "not-installed" });
  });

  it("needs Apple silicon and macOS, and says so without trying anything", async () => {
    const intel = installer({ arch: "x64" });
    // Before any install, so Settings offers no Install now for it.
    expect(await intel.status()).toEqual({ root, state: "failed", unsupported: true, error: expect.stringMatching(/^Audio intelligence needs a Mac with Apple silicon/) });
    await expect(intel.ensureInstalled()).rejects.toThrow(/needs a Mac with Apple silicon/);
    await expect(installer({ platform: "win32" }).ensureInstalled()).rejects.toThrow("Audio intelligence is available on macOS only.");
    expect(downloads).toEqual([]);
    expect(tools.calls).toEqual([]);
    // Nothing written either: there is nothing to resume.
    await expect(stat(root)).rejects.toThrow();
    expect(await intel.status()).toMatchObject({ state: "failed", unsupported: true });
  });

  it("checks for free disk space first", async () => {
    await expect(installer({ freeBytes: async () => 1024 ** 3 }).ensureInstalled()).rejects.toThrow(/needs about 4\.\d GB of free disk space to install; this Mac has 1\.0 GB free/);
    expect(downloads).toEqual([]);
  });

  it("removes exactly its folder, stopping an install first", async () => {
    let release!: () => void;
    tools.hold = new Promise<void>((resolve) => (release = resolve));
    const install = installer();
    const running = install.ensureInstalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    let stopped = false;
    const removal = install.remove(async () => { stopped = true; });
    expect((await install.status()).state).toBe("removing");
    release();
    await expect(running).rejects.toBeInstanceOf(InstallCanceled);
    await removal;
    expect(stopped).toBe(true);
    await expect(stat(root)).rejects.toThrow();
    expect((await stat(userData)).isDirectory()).toBe(true);
    expect((await install.status()).state).toBe("not-installed");
  });

  it("refuses to delete anything but <userData>/addons/earshot, or a link in its place", async () => {
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "keep.txt"), "mine");
    await expect(installer({ root: elsewhere }).remove()).rejects.toThrow(/isn't Blackout's audio intelligence folder/);
    expect(await readFile(join(elsewhere, "keep.txt"), "utf8")).toBe("mine");

    await mkdir(join(userData, "addons"), { recursive: true });
    await symlink(elsewhere, root);
    await expect(installer().remove()).rejects.toThrow(/isn't a plain folder/);
    expect(await readFile(join(elsewhere, "keep.txt"), "utf8")).toBe("mine");
  });
});
