/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Installs the audio intelligence add-on (earshot) into one folder of the
// app's own data, `<userData>/addons/earshot/`, in five resumable steps:
//
//   1. uv          bin/uv, from the pinned release, checksum verified
//   2. python      python/ (uv-managed CPython 3.12) and venv/
//   3. packages    torch (the CPU index's wheel, checksum verified) and
//                  earshot[mcp] from its pinned source archive, everything
//                  else as of earshot's release
//   4. ffmpeg      ffmpeg/ffmpeg + ffmpeg/ffprobe, checksum verified
//   5. models      home/ (EARSHOT_HOME): `earshot doctor --fetch`
//
// Each step records the pin it finished with in state.json (written
// atomically), so running the install again skips what is done and still
// checks out, and a Cutroom update that moves one pin re-runs just that
// step. One install runs at a time; nothing it does asks anyone anything.
// Everything lives under the root, caches included, so Remove gives all of
// the space back.

import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "../../atomic";
import { cacheBytes } from "./cache";
import { EARSHOT, FFMPEG, FFMPEG_FILES, MODELS, PYPI_INDEX, PYTHON, STEP_PINS, TORCH, UV } from "./pins";
import { clip, fetchVerified, folderBytes, lastLine, spawnRunner, tarExtract } from "./process";

import type { EarshotArch, PinnedFile } from "./pins";
import type { Extract, Fetch, Runner } from "./process";
import type { EarshotStatus, EarshotStepId, EarshotVersions } from "./types";

const MB = 1024 * 1024;
const GB = 1024 * MB;

type StepInfo = {
  id: EarshotStepId;
  label: string;
  /** What the step's progress counter reaches when it is done (bytes fetched or written), an estimate for the status line. */
  expectBytes: number;
  /** Disk the step needs while it runs, for the free-space check. */
  diskBytes: number;
};

/**
 * The five steps, in order. The byte figures follow the live install on an
 * M2 Pro (2026-11-03: 47 s on a fast line; 2,155 MiB on disk before the
 * warm-up compiles Python's bytecode, 2,252 MiB after: venv 943 MiB, models
 * 1,074 MiB, FFmpeg 126 MiB, Python 71 MiB, uv 27 MiB), rounded.
 */
export const STEPS: readonly StepInfo[] = [
  { id: "uv", label: "Installing uv", expectBytes: 14 * MB, diskBytes: 80 * MB },
  { id: "python", label: "Installing Python 3.12", expectBytes: 71 * MB, diskBytes: 250 * MB },
  // 860 MiB of uv's cache, plus the torch wheel fetched ahead of it.
  { id: "packages", label: "Installing earshot and PyTorch", expectBytes: 940 * MB, diskBytes: 2 * GB },
  { id: "ffmpeg", label: "Installing FFmpeg", expectBytes: 57 * MB, diskBytes: 300 * MB },
  { id: "models", label: "Downloading the sound models", expectBytes: 1075 * MB, diskBytes: 1.3 * GB },
];

const TOTAL_BYTES = STEPS.reduce((sum, step) => sum + step.expectBytes, 0);

/** How often a step without a byte counter of its own measures the folder it fills. */
const POLL_MS = 2000;
/** A model download that adds nothing for this long has stalled. */
const STALL_MS = 4 * 60 * 1000;
/** Commands that should be quick: version checks, metadata. */
const QUICK_MS = 2 * 60 * 1000;
/** uv installing Python, or a few hundred MB of wheels. */
const SLOW_MS = 40 * 60 * 1000;

export type StateFile = {
  version: 1;
  /** The steps done, with the pin each was done with. */
  steps: Partial<Record<EarshotStepId, { pin: string; at: string }>>;
  versions?: EarshotVersions;
  sizeBytes?: number;
  /** The last failure, one line, and the step it happened in. */
  error?: string;
  failedStep?: EarshotStepId;
  installedAt?: string;
  updatedAt?: string;
};

export type InstallerOptions = {
  /** `<userData>/addons/earshot`. */
  root: string;
  /** The app's data folder: Remove deletes `root` only when it is exactly `<userData>/addons/earshot`. */
  userData: string;
  arch?: string;
  platform?: NodeJS.Platform;
  fetch?: Fetch;
  /** Fetches one pinned file to `dest`, verified (default: `fetchVerified` over `fetch`). */
  download?: (file: PinnedFile, dest: string, signal: AbortSignal, onBytes: (bytes: number) => void) => Promise<void>;
  run?: Runner;
  extract?: Extract;
  /** Free bytes on the volume holding `path`. */
  freeBytes?: (path: string) => Promise<number>;
  now?: () => Date;
  /** Told about every step as it starts and ends, for the app log. */
  log?: (line: string) => void;
  userAgent?: string;
  pollMs?: number;
  stallMs?: number;
};

type Running = { promise: Promise<void>; controller: AbortController };

export class InstallCanceled extends Error {}

/** The environment every add-on command starts from: nothing of the user's shell (no PYTHONPATH, no pip or uv settings), proxies kept. */
export function baseEnv(home = homedir()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmpdir(), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export class EarshotInstaller {
  readonly root: string;
  private readonly userData: string;
  private readonly arch: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetchFile: (file: PinnedFile, dest: string, signal: AbortSignal, onBytes: (bytes: number) => void) => Promise<void>;
  private readonly run: Runner;
  private readonly extract: Extract;
  private readonly freeBytes: (path: string) => Promise<number>;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly pollMs: number;
  private readonly stallMs: number;

  private state: StateFile | null = null;
  private running: Running | null = null;
  private removing: Promise<void> | null = null;
  /** The step running, and its byte counter. */
  private current: { index: number; id: EarshotStepId; bytes: number } | null = null;
  /** The folder's size while nothing changes it (see `onDisk`). */
  private measured: Promise<number> | null = null;

  constructor(options: InstallerOptions) {
    this.root = resolve(options.root);
    this.userData = resolve(options.userData);
    this.arch = options.arch ?? process.arch;
    this.platform = options.platform ?? process.platform;
    const fetch: Fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const userAgent = options.userAgent ?? "Cutroom";
    this.fetchFile = options.download ?? ((file, dest, signal, onBytes) => fetchVerified(fetch, file, dest, signal, onBytes, userAgent));
    this.run = options.run ?? spawnRunner;
    this.extract = options.extract ?? tarExtract(this.run);
    this.freeBytes = options.freeBytes ?? (async (path) => {
      const info = await statfs(path);
      return Number(info.bavail) * Number(info.bsize);
    });
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => console.info(`[earshot] ${line}`));
    this.pollMs = options.pollMs ?? POLL_MS;
    this.stallMs = options.stallMs ?? STALL_MS;
  }

  // ---------------------------------------------------------------------------
  // Layout

  get uv(): string { return join(this.root, "bin", "uv"); }
  get python(): string { return join(this.root, "venv", "bin", "python"); }
  get home(): string { return join(this.root, "home"); }
  get ffmpegDir(): string { return join(this.root, "ffmpeg"); }
  private get statePath(): string { return join(this.root, "state.json"); }
  private get downloads(): string { return join(this.root, "downloads"); }
  private get cache(): string { return join(this.root, "cache"); }

  /** What earshot runs with besides the offline flags: FFmpeg first on PATH, every cache inside the root. */
  earshotEnv(): NodeJS.ProcessEnv {
    return {
      ...baseEnv(),
      PATH: `${this.ffmpegDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      EARSHOT_HOME: this.home,
      HF_HOME: join(this.home, "hf-home"),
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_PROGRESS_BARS: "1",
      HF_XET_CHUNK_CACHE_SIZE_BYTES: "0",
      MPLCONFIGDIR: join(this.home, "matplotlib"),
      NUMBA_CACHE_DIR: join(this.home, "numba"),
      MPLBACKEND: "Agg",
      PYTHONNOUSERSITE: "1",
      PYTHONIOENCODING: "utf-8",
      VIRTUAL_ENV: join(this.root, "venv"),
    };
  }

  private uvEnv(): NodeJS.ProcessEnv {
    return {
      ...baseEnv(),
      UV_CACHE_DIR: this.cache,
      UV_PYTHON_INSTALL_DIR: join(this.root, "python"),
      UV_PYTHON_BIN_DIR: join(this.root, "python", "bin"),
      UV_TOOL_DIR: join(this.cache, "tools"),
      UV_NO_CONFIG: "1",
      UV_NO_PROGRESS: "1",
      NO_COLOR: "1",
    };
  }

  // ---------------------------------------------------------------------------
  // State

  private async load(): Promise<StateFile> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<StateFile>;
      this.state = { version: 1, ...parsed, steps: parsed.steps && typeof parsed.steps === "object" ? parsed.steps : {} };
    } catch {
      this.state = { version: 1, steps: {} };
    }
    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) return;
    this.state.updatedAt = this.now().toISOString();
    await mkdir(this.root, { recursive: true });
    await writeFileAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  /** Whether every step is done with today's pins and the files a call needs are all there; no process is started. */
  async isReady(): Promise<boolean> {
    if (this.removing || this.running) return false;
    const state = await this.load();
    if (!STEPS.every((step) => state.steps[step.id]?.pin === STEP_PINS[step.id])) return false;
    const files = [this.uv, this.python, join(this.ffmpegDir, "ffmpeg"), join(this.ffmpegDir, "ffprobe"), ...this.modelFiles()];
    for (const file of files) if (!(await stat(file).then((info) => info.isFile(), () => false))) return false;
    return true;
  }

  private modelFiles(): string[] {
    return MODELS.map((model) => join(this.home, "hf", `models--${model.id.replace(/\//g, "--")}`, "snapshots", model.revision, model.weights));
  }

  async status(): Promise<EarshotStatus> {
    const state = await this.load();
    const base = { root: this.root, ...(state.versions ? { versions: state.versions } : {}), ...(state.sizeBytes ? { sizeBytes: state.sizeBytes } : {}), ...(state.installedAt ? { installedAt: state.installedAt } : {}) };
    if (this.removing) return { ...base, state: "removing" };
    if (this.running) {
      const current = this.current;
      return {
        ...base,
        state: "installing",
        ...(current ? { step: this.stepOf(current.index), progress: this.progress() } : {}),
      };
    }
    // Not ready: whatever is on disk now (a stopped install, an outdated one) is what Remove would free.
    const unsupported = this.unsupported();
    if (unsupported) {
      const bytes = await this.onDisk();
      return { root: this.root, state: "failed", error: unsupported, unsupported: true, ...(bytes ? { sizeBytes: bytes } : {}) };
    }
    if (await this.isReady()) return { ...base, state: "ready" };
    const bytes = await this.onDisk();
    const left = { root: this.root, ...(bytes ? { sizeBytes: bytes } : {}) };
    if (state.error) {
      const index = STEPS.findIndex((step) => step.id === state.failedStep);
      return { ...left, state: "failed", error: state.error, ...(index >= 0 ? { step: this.stepOf(index + 1) } : {}) };
    }
    return bytes ? { ...left, state: "not-installed", partial: true } : { root: this.root, state: "not-installed" };
  }

  /** What the folder holds, measured once until an install or Remove changes it (Settings asks every few seconds). */
  private onDisk(): Promise<number> {
    this.measured ??= folderBytes(this.root).catch(() => 0);
    return this.measured;
  }

  private stepOf(index: number): NonNullable<EarshotStatus["step"]> {
    const step = STEPS[index - 1]!;
    return { index, count: STEPS.length, id: step.id, label: step.label };
  }

  private progress(): NonNullable<EarshotStatus["progress"]> {
    const current = this.current;
    if (!current) return { bytes: 0, totalBytes: TOTAL_BYTES };
    const done = STEPS.slice(0, current.index - 1).reduce((sum, step) => sum + step.expectBytes, 0);
    const step = STEPS[current.index - 1]!;
    return { bytes: Math.round(done + Math.min(current.bytes, step.expectBytes * 0.98)), totalBytes: TOTAL_BYTES };
  }

  // ---------------------------------------------------------------------------
  // Install

  /**
   * Installs, or finishes an install, or joins the one running; settles when
   * it is ready or failed (the failure's reason is in the status, and the
   * promise rejects with it). Runs to its end even when the caller stops
   * waiting: only Remove and quitting stop it.
   */
  ensureInstalled(): Promise<void> {
    if (this.removing) return this.removing.then(() => this.ensureInstalled());
    if (this.running) return this.running.promise;
    const controller = new AbortController();
    const promise = (async () => {
      if (await this.isReady()) return;
      await this.install(controller.signal);
    })();
    const running: Running = { promise, controller };
    this.running = running;
    this.measured = null;
    const settled = () => {
      this.measured = null;
      if (this.running === running) this.running = null;
    };
    void promise.then(settled, settled);
    return promise;
  }

  /** Whether an install is running right now. */
  get installing(): boolean {
    return this.running !== null;
  }

  private async install(signal: AbortSignal): Promise<void> {
    // Nothing to retry and nothing to record: this Mac can't run it (status says so too).
    const unsupported = this.unsupported();
    if (unsupported) throw new Error(unsupported);
    const state = await this.load();
    const started = performance.now();
    try {
      await mkdir(this.root, { recursive: true });
      await this.checkSpace(state);
      delete state.error;
      delete state.failedStep;
      for (const [offset, step] of STEPS.entries()) {
        signal.throwIfAborted();
        this.current = { index: offset + 1, id: step.id, bytes: 0 };
        if (state.steps[step.id]?.pin === STEP_PINS[step.id] && (await this.verify(step.id, signal).catch(() => false))) continue;
        delete state.steps[step.id];
        await this.save();
        const at = performance.now();
        this.log(`step ${offset + 1}/${STEPS.length}: ${step.label}`);
        await this.perform(step.id, signal);
        state.steps[step.id] = { pin: STEP_PINS[step.id], at: this.now().toISOString() };
        await this.save();
        this.log(`step ${offset + 1}/${STEPS.length} done in ${Math.round((performance.now() - at) / 1000)} s`);
      }
      this.current = null;
      await rm(this.downloads, { recursive: true, force: true });
      await rm(this.cache, { recursive: true, force: true });
      // The install alone: earshot's caches change with use, and status adds what they hold now.
      state.sizeBytes = Math.max(0, (await folderBytes(this.root)) - (await cacheBytes(this.home)));
      state.installedAt ??= this.now().toISOString();
      await this.save();
      this.log(`ready in ${Math.round((performance.now() - started) / 1000)} s, ${Math.round(state.sizeBytes / MB)} MB`);
    } catch (error) {
      const failed = this.current?.id;
      this.current = null;
      await rm(this.downloads, { recursive: true, force: true }).catch(() => {});
      if (signal.aborted) throw new InstallCanceled("The audio intelligence install was stopped.");
      const reason = clip((error as Error).message || String(error));
      state.error = reason;
      if (failed) state.failedStep = failed;
      await this.save().catch(() => {});
      this.log(`install failed${failed ? ` at ${failed}` : ""}: ${reason}`);
      throw new Error(reason, { cause: error });
    }
  }

  /** Why this Mac can't run the add-on at all, or null when it can. */
  private unsupported(): string | null {
    if (this.platform !== "darwin") return "Audio intelligence is available on macOS only.";
    if (this.arch !== "arm64") return "Audio intelligence needs a Mac with Apple silicon: PyTorch, which earshot's sound models run on, has no current build for Intel Macs.";
    return null;
  }

  private archKey(): EarshotArch {
    return this.arch === "x64" ? "x64" : "arm64";
  }

  private async checkSpace(state: StateFile): Promise<void> {
    const needed = STEPS.filter((step) => state.steps[step.id]?.pin !== STEP_PINS[step.id]).reduce((sum, step) => sum + step.diskBytes, 0);
    if (!needed) return;
    const free = await this.freeBytes(this.root).catch(() => Number.POSITIVE_INFINITY);
    if (free < needed + 512 * MB) {
      throw new Error(`Audio intelligence needs about ${(needed / GB + 0.5).toFixed(1)} GB of free disk space to install; this Mac has ${(free / GB).toFixed(1)} GB free.`);
    }
  }

  private perform(step: EarshotStepId, signal: AbortSignal): Promise<void> {
    switch (step) {
      case "uv": return this.installUv(signal);
      case "python": return this.installPython(signal);
      case "packages": return this.installPackages(signal);
      case "ffmpeg": return this.installFfmpeg(signal);
      case "models": return this.fetchModels(signal);
    }
  }

  /** Whether a step recorded as done still checks out on disk. */
  private async verify(step: EarshotStepId, signal: AbortSignal): Promise<boolean> {
    switch (step) {
      case "uv": return (await this.uvVersion(signal)) === UV.version;
      case "python": return (await this.pythonVersion(signal)).startsWith(`${PYTHON}.`);
      case "packages": {
        const versions = await this.distributions(signal);
        return versions.earshot === EARSHOT.version && versions.torch === TORCH.version && !!versions.mcp;
      }
      case "ffmpeg": return (await this.ffmpegVersion(signal)) === FFMPEG.version;
      case "models": {
        // Followed like `isReady` does: Hugging Face's snapshot files are links into its blobs/.
        for (const file of this.modelFiles()) if (!(await stat(file).then((info) => info.isFile(), () => false))) return false;
        return true;
      }
    }
  }

  private async command(command: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number, what: string): Promise<string> {
    const result = await this.run(command, args, { env, cwd: this.root, signal, timeoutMs });
    signal.throwIfAborted();
    if (result.code !== 0) throw new Error(`${what} failed: ${lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code ?? result.signal}`}`);
    return result.stdout;
  }

  /** `bytes` of the current step, also from a folder it fills (after `from` bytes fetched first), measured every `pollMs`. */
  private track(folder: string, signal: AbortSignal, stall?: () => void, from = 0): () => void {
    let last = -1;
    let lastChange = Date.now();
    let busy = false;
    const timer = setInterval(() => {
      if (busy || signal.aborted) return;
      busy = true;
      void folderBytes(folder).then((bytes) => {
        if (this.current) this.current.bytes = from + bytes;
        if (bytes !== last) { last = bytes; lastChange = Date.now(); }
        else if (stall && Date.now() - lastChange > this.stallMs) stall();
      }).finally(() => { busy = false; });
    }, this.pollMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async download(file: PinnedFile, name: string, signal: AbortSignal, offset = 0): Promise<string> {
    await mkdir(this.downloads, { recursive: true });
    const dest = join(this.downloads, name);
    await this.fetchFile(file, dest, signal, (bytes) => {
      if (this.current) this.current.bytes = offset + bytes;
    });
    return dest;
  }

  // 1. uv

  private async uvVersion(signal: AbortSignal): Promise<string> {
    const out = await this.command(this.uv, ["--version"], this.uvEnv(), signal, QUICK_MS, "uv");
    return /^uv (\S+)/.exec(out.trim())?.[1] ?? "";
  }

  private async installUv(signal: AbortSignal): Promise<void> {
    const arch = this.archKey();
    await rm(this.downloads, { recursive: true, force: true });
    const archive = await this.download(UV.assets[arch], "uv.tar.gz", signal);
    const unpacked = join(this.downloads, "uv");
    await mkdir(unpacked, { recursive: true });
    await this.extract(archive, unpacked, [UV.member[arch]]);
    await mkdir(dirname(this.uv), { recursive: true });
    await rename(join(unpacked, ...UV.member[arch].split("/")), this.uv);
    await chmod(this.uv, 0o755);
    await rm(this.downloads, { recursive: true, force: true });
    const version = await this.uvVersion(signal);
    if (version !== UV.version) throw new Error(`uv reported version ${version || "nothing"}, not ${UV.version}.`);
  }

  // 2. Python

  private async pythonVersion(signal: AbortSignal): Promise<string> {
    const out = await this.command(this.python, ["-I", "-c", "import platform; print(platform.python_version())"], this.earshotEnv(), signal, QUICK_MS, "Python");
    return out.trim();
  }

  private async installPython(signal: AbortSignal): Promise<void> {
    const env = this.uvEnv();
    const stop = this.track(join(this.root, "python"), signal);
    try {
      await this.command(this.uv, ["python", "install", PYTHON, "--no-bin"], env, signal, SLOW_MS, "Installing Python");
      await this.command(this.uv, ["venv", "--clear", "--no-project", "--managed-python", "--python", PYTHON, join(this.root, "venv")], env, signal, QUICK_MS, "Creating the Python environment");
    } finally {
      stop();
    }
    const version = await this.pythonVersion(signal);
    if (!version.startsWith(`${PYTHON}.`)) throw new Error(`The Python environment runs ${version || "nothing"}, not ${PYTHON}.`);
  }

  // 3. Packages

  /** Every distribution in the environment and its version, lowercased names, by Python's own metadata (no imports). */
  private async distributions(signal: AbortSignal): Promise<Record<string, string>> {
    const out = await this.command(this.uv, ["pip", "list", "--python", this.python, "--format", "json"], this.uvEnv(), signal, QUICK_MS, "Listing the Python packages");
    const rows = JSON.parse(out) as Array<{ name: string; version: string }>;
    return Object.fromEntries(rows.map((row) => [row.name.toLowerCase(), row.version]));
  }

  private async installPackages(signal: AbortSignal): Promise<void> {
    const env = this.uvEnv();
    await rm(this.downloads, { recursive: true, force: true });
    const archive = await this.download(EARSHOT.archive, `earshot-${EARSHOT.commit}.tar.gz`, signal);
    // Under the name the index gives it: uv reads a wheel's tags from its file name.
    const wheel = await this.download(TORCH.wheel, basename(new URL(TORCH.wheel.url).pathname), signal, EARSHOT.archive.bytes);
    const stop = this.track(this.cache, signal, undefined, EARSHOT.archive.bytes + TORCH.wheel.bytes);
    try {
      // Nothing compiles: wheels only, except earshot itself (pure Python).
      // torch is the verified copy, by its file URL, so no index can stand in
      // for it; its dependencies come from PyPI with the rest.
      await this.command(this.uv, [
        "pip", "install", "--python", this.python,
        "--index-url", PYPI_INDEX, "--exclude-newer", EARSHOT.released,
        "--only-binary", ":all:", "--no-binary", "earshot",
        `torch @ ${pathToFileURL(wheel).href}`, `earshot[mcp] @ ${pathToFileURL(archive).href}`,
      ], env, signal, SLOW_MS, "Installing earshot and PyTorch");
    } finally {
      stop();
    }
    const versions = await this.distributions(signal);
    if (versions.earshot !== EARSHOT.version) throw new Error(`earshot ${versions.earshot ?? "is missing"} was installed, not ${EARSHOT.version}.`);
    if (versions.torch !== TORCH.version) throw new Error(`torch ${versions.torch ?? "is missing"} was installed, not ${TORCH.version}.`);
    await this.record(signal, versions);
    await rm(this.cache, { recursive: true, force: true });
    await rm(this.downloads, { recursive: true, force: true });
  }

  private async record(signal: AbortSignal, packages?: Record<string, string>): Promise<void> {
    const state = await this.load();
    const [uv, python, ffmpeg] = await Promise.all([
      this.uvVersion(signal).catch(() => state.versions?.uv ?? ""),
      this.pythonVersion(signal).catch(() => state.versions?.python ?? ""),
      this.ffmpegVersion(signal).catch(() => state.versions?.ffmpeg ?? ""),
    ]);
    const all = packages ?? state.versions?.packages ?? {};
    state.versions = { earshot: all.earshot ?? EARSHOT.version, commit: EARSHOT.commit, uv, python, torch: all.torch ?? TORCH.version, ffmpeg, packages: all };
  }

  // 4. FFmpeg

  private async ffmpegVersion(signal: AbortSignal): Promise<string> {
    const versions: string[] = [];
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const out = await this.command(join(this.ffmpegDir, tool), ["-hide_banner", "-version"], baseEnv(), signal, QUICK_MS, tool);
      versions.push(/^\S+ version (\d[\w.]*)/.exec(out.trim())?.[1] ?? "");
    }
    return versions[0] === versions[1] ? versions[0]! : "";
  }

  private async installFfmpeg(signal: AbortSignal): Promise<void> {
    const files = FFMPEG_FILES[this.archKey()];
    await rm(this.downloads, { recursive: true, force: true });
    const unpacked = join(this.downloads, "ffmpeg");
    await mkdir(unpacked, { recursive: true });
    await mkdir(this.ffmpegDir, { recursive: true });
    let offset = 0;
    for (const tool of ["ffmpeg", "ffprobe"] as const) {
      const archive = await this.download(files[tool], `${tool}.zip`, signal, offset);
      offset += files[tool].bytes;
      await this.extract(archive, unpacked, [tool]);
      await rename(join(unpacked, tool), join(this.ffmpegDir, tool));
      await chmod(join(this.ffmpegDir, tool), 0o755);
    }
    await rm(this.downloads, { recursive: true, force: true });
    const version = await this.ffmpegVersion(signal);
    if (version !== FFMPEG.version) throw new Error(`FFmpeg reported version ${version || "nothing"}, not ${FFMPEG.version}.`);
    await this.record(signal);
  }

  // 5. Models

  private async fetchModels(signal: AbortSignal): Promise<void> {
    const local = new AbortController();
    const both = AbortSignal.any([signal, local.signal]);
    let stalled = false;
    const stop = this.track(this.home, both, () => { stalled = true; local.abort(); });
    let out: string;
    try {
      out = await this.command(this.python, ["-m", "earshot", "doctor", "--fetch", "--json"], this.earshotEnv(), both, SLOW_MS, "Downloading the sound models");
    } catch (error) {
      if (stalled && !signal.aborted) throw new Error("The sound model download stopped making progress. Check the network and try again.");
      throw error;
    } finally {
      stop();
    }
    let report: { fetched?: Record<string, string>; models_cached?: Record<string, boolean>; problems?: string[] };
    try {
      report = JSON.parse(out) as typeof report;
    } catch {
      throw new Error("earshot doctor answered with something other than JSON.");
    }
    const failed = Object.entries(report.fetched ?? {}).find(([, outcome]) => /^failed/i.test(outcome));
    if (failed) throw new Error(`Downloading ${failed[0]} ${failed[1].replace(/^failed:?\s*/i, "failed: ")}`);
    const missing = Object.entries(report.models_cached ?? {}).filter(([, cached]) => !cached).map(([id]) => id);
    if (missing.length) throw new Error(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} still not in the cache (${report.problems?.[0] ?? "no reason given"}).`);
    // Download-side caches; the models themselves are in home/hf.
    await rm(join(this.home, "hf-home", "xet"), { recursive: true, force: true });
    await this.warmUp(signal);
  }

  /**
   * Loads both models once, offline, while the install is still the thing
   * running: the very first load compiles Python's bytecode and has macOS
   * look over every new library (about 90 s on an M2 Pro, against 10 s for a
   * later cold start), which a first tool call would otherwise wait out. Only
   * an optimization: a failure is logged, and the tools report their own.
   */
  private async warmUp(signal: AbortSignal): Promise<void> {
    const env = { ...this.earshotEnv(), EARSHOT_OFFLINE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
    try {
      const out = await this.command(this.python, ["-m", "earshot", "doctor", "--load", "--json"], env, signal, SLOW_MS, "Loading the sound models");
      const problems = (JSON.parse(out) as { problems?: string[] }).problems ?? [];
      if (problems.length) this.log(`warm-up: ${problems.join("; ")}`);
    } catch (error) {
      signal.throwIfAborted();
      this.log(`warm-up skipped: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Remove

  /**
   * Stops any install, runs `beforeDelete` (the service stops the worker
   * there) and deletes the add-on's folder: only ever exactly
   * `<userData>/addons/earshot`, a real folder, never a link.
   */
  remove(beforeDelete: () => Promise<void> = async () => {}): Promise<void> {
    if (this.removing) return this.removing;
    const removing = (async () => {
      const running = this.running;
      if (running) {
        running.controller.abort(new InstallCanceled("Audio intelligence is being removed."));
        await running.promise.catch(() => {});
      }
      await beforeDelete();
      await this.assertRemovable();
      await rm(this.root, { recursive: true, force: true });
      this.state = { version: 1, steps: {} };
    })();
    this.removing = removing;
    const settled = () => {
      this.measured = null;
      this.removing = null;
    };
    void removing.then(settled, settled);
    return removing;
  }

  /** Throws unless `root` is exactly `<userData>/addons/earshot` and a real folder (or gone). */
  private async assertRemovable(): Promise<void> {
    const expected = join(this.userData, "addons", "earshot");
    if (this.root !== expected || basename(this.root) !== "earshot") {
      throw new Error(`Refusing to delete ${this.root}: it isn't Cutroom's audio intelligence folder.`);
    }
    const info = await lstat(this.root).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing to delete ${this.root}: it isn't a plain folder.`);
    const realParent = await realpath(dirname(this.root));
    const realData = await realpath(this.userData);
    if (realParent !== join(realData, "addons")) throw new Error(`Refusing to delete ${this.root}: its folder leads outside the app's data.`);
  }

  /** Stops an install for good: the app is quitting. */
  dispose(): void {
    this.running?.controller.abort(new InstallCanceled("Cutroom is quitting."));
  }

  /** Where a running install is, for the message a tool call gets when it stops waiting: `step 3/5, 410 of 1,260 MB`. */
  describe(status: EarshotStatus): string {
    const step = status.step ? `step ${status.step.index}/${status.step.count}` : "starting";
    const progress = status.progress ? `, ${formatMB(status.progress.bytes)} of ${formatMB(status.progress.totalBytes)} MB` : "";
    return `${step}${progress}`;
  }
}

/** Megabytes as macOS counts them (10^6 bytes), like the Finder. */
function formatMB(bytes: number): string {
  return Math.round(bytes / 1e6).toLocaleString("en-US");
}

export { TOTAL_BYTES };
