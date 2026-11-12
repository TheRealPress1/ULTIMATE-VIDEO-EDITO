/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The managed yt-dlp: which release is installed, when to look for a newer
// one, and how each run is started. Everything lives under one folder in the
// app's data (`<userData>/tools/yt-dlp`), never inside the signed app:
//
//   state.json        the pointer: the current release, the previous one, checks
//   <tag>/            an unpacked release, read-only once installed
//   downloads/        archives while they download (removed after)
//   cache/            yt-dlp's own cache (YouTube player solutions)
//   home/, tmp/       the HOME and TMPDIR yt-dlp runs with (the single-file
//                     build's leftover `_MEI…` folders are swept when idle)
//   node-shim         the JavaScript runtime (see ./js-runtime)
//
// Policy: install on first use (single-flight, bounded in time); a new
// release goes in beside the current one and becomes current only after it
// passed its `--version` check, by rewriting state.json in one step, so a run
// already going keeps the folder it started from; the previous release stays
// until the new one has completed one run. Looks for a newer release in the
// background at most once a day (and only for someone who used the downloader
// in the last 30 days), and on a caller's request after an "outdated" failure
// at most every 30 minutes. Offline, the installed release keeps working.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DapiError } from "@diffusionstudio/dapi";
import { writeFileAtomic } from "../atomic";
import { EgressProxy } from "./egress-proxy";
import { execText, jsRuntimeArgs, verifyNodeShim, writeShim } from "./js-runtime";
import { downloaderLine } from "./yt-dlp-errors";
import { killAllRuns, runProcess } from "./yt-dlp-run";
import {
  InstallError, MACOS_ARTIFACTS, RELEASES_URL, SUMS_NAME, TAG_PATTERN, checkTree, compareTags, ensureDir, fetchFollowing, fetchSums, isMachO, latestTag,
  markExecutable, saveBody, smokeTest, suffix, swapInto, unpackZip,
} from "./yt-dlp-install";

import type { EgressSession } from "./egress-proxy";
import type { Exec } from "./js-runtime";
import type { ReleaseKey } from "./release-signature";
import type { DownloaderStatus, JsRuntimeStatus, YtDlpStatus } from "./types";
import type { YtDlpRunOptions, YtDlpRunResult } from "./yt-dlp-run";
import type { Artifact, ArtifactKind, Fetch, InstallFailure } from "./yt-dlp-install";

export type InstalledRelease = {
  tag: string;
  /** Its folder, relative to the root. */
  dir: string;
  kind: ArtifactKind;
  executable: string;
  sha256: string;
  installedAt: string;
  /** Completed runs; the previous release is removed after the first. */
  okRuns: number;
};

export type DownloaderState = {
  version: 1;
  current?: InstalledRelease;
  previous?: InstalledRelease;
  lastCheck?: { at: string; latest?: string; error?: string };
  forcedCheckAt?: string;
  lastUsedAt?: string;
  jsRuntime?: { execPath: string; appVersion: string; status: JsRuntimeStatus; checkedAt: string };
};

/** What `run` takes beyond the contract's options. */
export type ManagedRunOptions = YtDlpRunOptions & {
  /** Bytes the run may receive before it is stopped (a size cap). */
  maxBytes?: number;
};

export type ManagerOptions = {
  root: string;
  ffmpegDir: string;
  appExecPath: string;
  /** The app's version, for the User-Agent and the JavaScript runtime check. */
  version: string;
  fetch: Fetch;
  now?: () => Date;
  exec?: Exec;
  egress?: EgressProxy;
  platform?: NodeJS.Platform;
  artifacts?: readonly Artifact[];
  isExecutable?: (header: Buffer) => boolean;
  /** The keys a release's checksums must be signed with: yt-dlp's release key unless a test gives its own. */
  releaseKeys?: readonly ReleaseKey[];
  installTimeoutMs?: number;
  smokeTimeoutMs?: number;
  maxConcurrentRuns?: number;
  log?: (line: string) => void;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BACKGROUND_FIRST_MS = MINUTE;
const BACKGROUND_EVERY_MS = HOUR;
const CHECK_EVERY_MS = DAY;
const FORCED_CHECK_MS = 30 * MINUTE;
const USED_RECENTLY_MS = 30 * DAY;
const USE_RECORD_MS = HOUR;
const INSTALL_TIMEOUT_MS = 3 * MINUTE;
const STATE_FILE = "state.json";
/** Names the manager creates in its root; nothing else there is ever removed. */
const RELEASE_NAME = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?(?:-onefile)?(?:\.(?:partial|trash)-[0-9a-f]+)?$/;

const UNSUPPORTED = "Platform media downloads need macOS for now.";

/** Why an install failed, as far as the next step depends on it. */
function failureReason(error: unknown): InstallFailure | undefined {
  if (error instanceof InstallError) return error.reason;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? "disk" : undefined;
}

/** The sentence after an install failure: what can fix it, which is only sometimes the network. */
export function installNextStep(error: unknown): string {
  switch (failureReason(error)) {
    case "network": return "Check the network, then try again.";
    case "disk": return "Free some disk space, then try again.";
    case "checksum": return "Try again later; if it keeps failing, something between this Mac and GitHub is changing the download.";
    case "signature": return "Blackout installs only yt-dlp releases signed with yt-dlp's release key, so it didn't install this one. Try again after yt-dlp's next release; if it keeps failing, Blackout needs an update.";
    case "smoke": return "Reinstall it from Settings > Downloads; if it still won't start, look for a blocked app in System Settings > Privacy & Security.";
    case "invalid": return "This yt-dlp release isn't one Blackout can use; try again after its next release, or reinstall from Settings > Downloads.";
    default: return "Try again, or reinstall it from Settings > Downloads.";
  }
}

/** `state.json` as far as it can be trusted; anything malformed reads as nothing installed. */
export function parseState(text: string | undefined): DownloaderState {
  if (!text) return { version: 1 };
  try {
    const value = JSON.parse(text) as DownloaderState;
    if (!value || value.version !== 1) return { version: 1 };
    const release = (item: unknown): InstalledRelease | undefined => {
      const candidate = item as InstalledRelease | undefined;
      return candidate && typeof candidate.tag === "string" && TAG_PATTERN.test(candidate.tag) && typeof candidate.dir === "string" && RELEASE_NAME.test(candidate.dir)
        && typeof candidate.executable === "string" && /^[\w.-]+$/.test(candidate.executable) ? { ...candidate, okRuns: Number(candidate.okRuns) || 0 } : undefined;
    };
    return {
      version: 1,
      current: release(value.current),
      previous: release(value.previous),
      lastCheck: value.lastCheck && typeof value.lastCheck.at === "string" ? value.lastCheck : undefined,
      forcedCheckAt: typeof value.forcedCheckAt === "string" ? value.forcedCheckAt : undefined,
      lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : undefined,
      jsRuntime: value.jsRuntime && typeof value.jsRuntime.execPath === "string" && value.jsRuntime.status ? value.jsRuntime : undefined,
    };
  } catch {
    return { version: 1 };
  }
}

/** A wait the caller can walk away from; the work it waits on goes on. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DapiError("canceled", "The download was canceled."));
  return new Promise<T>((settle, reject) => {
    const abort = () => reject(new DapiError("canceled", "The download was canceled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(settle, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** At most `limit` holders at once, in arrival order; a waiter can give up. */
class Slots {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((settle, reject) => {
        const turn = () => {
          signal?.removeEventListener("abort", abort);
          settle();
        };
        const abort = () => {
          const index = this.queue.indexOf(turn);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new DapiError("canceled", "The download was canceled."));
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        this.queue.push(turn);
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export class YtDlpManager {
  private readonly root: string;
  private readonly fetch: Fetch;
  private readonly now: () => Date;
  private readonly exec: Exec;
  private readonly egress: EgressProxy;
  private readonly supported: boolean;
  private readonly artifacts: readonly Artifact[];
  private readonly isExecutable: (header: Buffer) => boolean;
  private readonly log: (line: string) => void;
  private readonly slots: Slots;
  private state: DownloaderState;
  private job: Promise<{ version: string; changed: boolean }> | null = null;
  private busy: "installing" | "updating" | null = null;
  private failure: string | undefined;
  private runtime: Promise<JsRuntimeStatus> | null = null;
  private runtimeChecked = false;
  private saving: Promise<void> = Promise.resolve();
  private readonly inUse = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private readonly options: ManagerOptions;

  constructor(options: ManagerOptions) {
    this.options = options;
    this.root = options.root;
    this.now = options.now ?? (() => new Date());
    this.exec = options.exec ?? execText;
    this.egress = options.egress ?? new EgressProxy({ log: (line) => this.log(line) });
    this.supported = (options.platform ?? process.platform) === "darwin";
    this.artifacts = options.artifacts ?? MACOS_ARTIFACTS;
    this.isExecutable = options.isExecutable ?? isMachO;
    this.log = options.log ?? ((line) => console.info(`[yt-dlp] ${line}`));
    this.slots = new Slots(options.maxConcurrentRuns ?? 4);
    this.fetch = options.fetch;
    let text: string | undefined;
    try { text = readFileSync(join(this.root, STATE_FILE), "utf8"); } catch { /* first launch */ }
    this.state = parseState(text);
  }

  private get headers(): Record<string, string> {
    return { "user-agent": `Blackout/${this.options.version}`, accept: "*/*" };
  }

  private exePath(release: InstalledRelease): string {
    return join(this.root, release.dir, release.executable);
  }

  private get shimPath(): string {
    return join(this.root, "node-shim");
  }

  /** The environment yt-dlp runs with: nothing inherited. */
  private get env(): NodeJS.ProcessEnv {
    return {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: join(this.root, "home"),
      TMPDIR: `${join(this.root, "tmp")}/`,
      LANG: "en_US.UTF-8",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    };
  }

  private save(): Promise<void> {
    const text = `${JSON.stringify(this.state, null, 2)}\n`;
    this.saving = this.saving.then(async () => {
      await mkdir(this.root, { recursive: true });
      await writeFileAtomic(join(this.root, STATE_FILE), text);
    }).catch((error) => this.log(`couldn't save the downloader state: ${(error as Error).message}`));
    return this.saving;
  }

  status(): YtDlpStatus {
    const current = this.state.current;
    const error = !this.supported ? UNSUPPORTED : (this.failure ?? this.state.lastCheck?.error);
    return {
      state: !this.supported ? "failed" : this.busy ?? (current ? "ready" : error ? "failed" : "missing"),
      ...(current ? { version: current.tag, path: this.exePath(current) } : {}),
      ...(error ? { error } : {}),
      ...(this.state.lastCheck ? { checkedAt: this.state.lastCheck.at } : {}),
    };
  }

  /** The status with what the Settings card shows besides. */
  details(): DownloaderStatus {
    const status = this.status();
    const latest = this.state.lastCheck?.latest;
    const runtime = this.state.jsRuntime?.status;
    let message: string;
    if (!this.supported) message = UNSUPPORTED;
    else if (status.state === "installing") message = "Installing the downloader (yt-dlp) from GitHub…";
    else if (status.state === "updating") message = "Looking for a newer downloader and installing it…";
    else if (status.state === "missing") message = "Blackout installs its downloader (yt-dlp) from GitHub the first time an agent downloads from a platform like YouTube.";
    else if (status.state === "failed") message = `The downloader couldn't be installed: ${status.error}.`;
    else {
      const newer = latest && status.version && compareTags(latest, status.version) > 0 ? ` ${latest} is available.` : "";
      const limited = runtime?.kind === "none" ? " YouTube may offer fewer formats: the JavaScript runtime didn't pass its check." : "";
      message = `yt-dlp ${status.version} is installed.${newer}${limited}`;
    }
    return {
      ...status,
      ...(latest ? { latest } : {}),
      ...(this.state.current ? { installedAt: this.state.current.installedAt } : {}),
      ...(runtime ? { jsRuntime: runtime } : {}),
      supported: this.supported,
      message,
    };
  }

  private unsupported(): DapiError {
    return new DapiError("unsupported", UNSUPPORTED);
  }

  private async usable(release: InstalledRelease | undefined): Promise<boolean> {
    if (!release) return false;
    return stat(this.exePath(release)).then((info) => info.isFile(), () => false);
  }

  /** The installed release, installing one on first use. */
  async ensure(signal?: AbortSignal): Promise<{ path: string; version: string }> {
    if (!this.supported) throw this.unsupported();
    if (this.disposed) throw new DapiError("canceled", "Blackout is quitting.");
    if (!(await this.usable(this.state.current))) {
      if (this.state.current) this.log(`release ${this.state.current.tag} is missing on disk; installing again`);
      await waitFor(this.install(this.state.current ? "reinstall" : "install"), signal);
    }
    await waitFor(this.jsRuntime(), signal);
    const current = this.state.current!;
    return { path: this.exePath(current), version: current.tag };
  }

  /**
   * Looks for a newer release and installs it, for a caller whose run failed
   * as "outdated". Asks GitHub at most every 30 minutes; in between (or when
   * a check just found nothing newer) it answers `changed: false` at once.
   */
  async update(signal?: AbortSignal): Promise<{ version: string; changed: boolean }> {
    if (!this.supported) throw this.unsupported();
    if (!(await this.usable(this.state.current))) {
      const { version } = await this.ensure(signal);
      return { version, changed: true };
    }
    const now = this.now().getTime();
    const recent = [this.state.forcedCheckAt, this.state.lastCheck?.error ? undefined : this.state.lastCheck?.at]
      .map((at) => (at ? Date.parse(at) : NaN))
      .some((at) => Number.isFinite(at) && now - at < FORCED_CHECK_MS);
    if (recent && !this.job) return { version: this.state.current!.tag, changed: false };
    if (!this.job) {
      this.state.forcedCheckAt = this.now().toISOString();
      void this.save();
    }
    return waitFor(this.install("update"), signal);
  }

  /** Settings → Check for update: asks GitHub now. */
  checkNow(signal?: AbortSignal): Promise<{ version: string; changed: boolean }> {
    if (!this.supported) return Promise.reject(this.unsupported());
    return waitFor(this.install(this.state.current ? "update" : "install"), signal);
  }

  /** Settings → Reinstall: the latest release, downloaded and checked again. */
  reinstall(signal?: AbortSignal): Promise<{ version: string; changed: boolean }> {
    if (!this.supported) return Promise.reject(this.unsupported());
    return waitFor(this.install("reinstall"), signal);
  }

  /** One install, update or reinstall at a time; a second caller shares it. */
  private install(mode: "install" | "update" | "reinstall"): Promise<{ version: string; changed: boolean }> {
    if (this.disposed) return Promise.reject(new DapiError("canceled", "Blackout is quitting."));
    this.job ??= this.installLatest(mode).finally(() => {
      this.job = null;
      this.busy = null;
      // A single-file build's smoke test that ran out of time was killed with its folder still unpacked.
      void this.sweepTemp();
    });
    return this.job;
  }

  private async installLatest(mode: "install" | "update" | "reinstall"): Promise<{ version: string; changed: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new InstallError("network", "the install took longer than three minutes")), this.options.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
    timer.unref?.();
    this.abortJob = () => controller.abort(new DapiError("canceled", "Blackout is quitting."));
    const signal = controller.signal;
    const current = this.state.current;
    this.busy = current ? "updating" : "installing";
    let latest: string | undefined;
    try {
      latest = await latestTag(this.fetch, this.headers, signal);
      if (mode === "update" && current && compareTags(latest, current.tag) <= 0 && (await this.usable(current))) {
        this.state.lastCheck = { at: this.now().toISOString(), latest };
        this.failure = undefined;
        await this.save();
        return { version: current.tag, changed: false };
      }
      this.log(`installing yt-dlp ${latest}${current ? ` (was ${current.tag})` : ""}`);
      const sums = await fetchSums(this.fetch, latest, this.headers, signal, this.options.releaseKeys);
      let installed: InstalledRelease | undefined;
      // The first build that was tried and failed explains the failure best.
      let failed: unknown;
      let unlisted: InstallError | undefined;
      for (const artifact of this.artifacts) {
        const expected = sums.get(artifact.name);
        if (!expected) {
          unlisted ??= new InstallError("invalid", `the release's ${SUMS_NAME} has no single entry for ${artifact.name}`);
          continue;
        }
        try {
          installed = await this.installArtifact(latest, artifact, expected, signal);
          break;
        } catch (error) {
          failed ??= error;
          // Only a build that won't run on this Mac is worth trying the other build for.
          if (!(error instanceof InstallError && (error.reason === "smoke" || error.reason === "invalid"))) throw error;
          this.log(`${artifact.name} failed: ${error.message}`);
        }
      }
      if (!installed) throw failed ?? unlisted ?? new InstallError("invalid", "the release has no macOS build");
      // The release it replaces stays until the new one has completed a run.
      if (current && current.dir !== installed.dir && (await this.usable(current))) this.state.previous = current;
      if (this.state.previous?.dir === installed.dir) this.state.previous = undefined;
      this.state.current = installed;
      this.state.lastCheck = { at: this.now().toISOString(), latest };
      this.failure = undefined;
      await this.save();
      await this.prune(false, true);
      this.log(`yt-dlp ${latest} is ready`);
      return { version: latest, changed: true };
    } catch (error) {
      const reason = error instanceof DapiError && error.code === "canceled" ? error.message
        : error instanceof InstallError ? error.message
        : `${(error as Error)?.message ?? String(error)}`;
      if (error instanceof DapiError && error.code === "canceled") throw error;
      this.failure = reason;
      this.state.lastCheck = { at: this.now().toISOString(), ...(latest ? { latest } : {}), error: reason };
      await this.save();
      this.log(`install failed: ${reason}`);
      throw new DapiError("unsupported", `Blackout couldn't install its downloader (yt-dlp) from GitHub: ${reason}. ${installNextStep(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
      this.abortJob = undefined;
    }
  }

  private abortJob: (() => void) | undefined;

  private async installArtifact(tag: string, artifact: Artifact, expected: string, signal: AbortSignal): Promise<InstalledRelease> {
    const downloads = join(this.root, "downloads");
    await ensureDir(downloads);
    await ensureDir(join(this.root, "tmp"));
    await ensureDir(join(this.root, "home"));
    const archive = join(downloads, `${tag}-${artifact.name}.${suffix()}.part`);
    const name = artifact.kind === "onedir" ? tag : `${tag}-onefile`;
    const partial = join(this.root, `${name}.partial-${suffix()}`);
    try {
      const response = await fetchFollowing(this.fetch, `${RELEASES_URL}/download/${tag}/${artifact.name}`, this.headers, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new InstallError("network", `GitHub answered ${response.status} for ${artifact.name}`);
      }
      const { sha256 } = await saveBody(response, archive, artifact.maxBytes, signal);
      if (sha256 !== expected) throw new InstallError("checksum", `${artifact.name} doesn't match the checksum its release publishes`);
      if (artifact.kind === "onedir") {
        await unpackZip(archive, partial, this.exec);
      } else {
        await ensureDir(partial);
        await swapInto(archive, join(partial, artifact.executable));
        await markExecutable(join(partial, artifact.executable));
      }
      signal.throwIfAborted();
      await checkTree(partial, artifact.executable, this.isExecutable);
      // Node's writes carry no quarantine flag; this is for an archive a person dropped in.
      await this.exec("/usr/bin/xattr", ["-dr", "com.apple.quarantine", partial], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000 }).catch(() => undefined);
      await smokeTest(join(partial, artifact.executable), tag, this.exec, this.env, this.options.smokeTimeoutMs);
      signal.throwIfAborted();
      await swapInto(partial, join(this.root, name));
      return { tag, dir: name, kind: artifact.kind, executable: artifact.executable, sha256, installedAt: this.now().toISOString(), okRuns: 0 };
    } finally {
      await rm(archive, { force: true }).catch(() => {});
      await rm(partial, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Removes releases and leftovers that are neither current nor (unless
   * `dropPrevious`) previous, and not in use by a run. Outside an install
   * only: a release that is being moved into place is in neither yet.
   */
  private async prune(dropPrevious: boolean, fromJob = false): Promise<void> {
    if (this.job && !fromJob) return;
    const keep = new Set<string>();
    if (this.state.current) keep.add(this.state.current.dir);
    if (this.state.previous && !dropPrevious) keep.add(this.state.previous.dir);
    let names: string[] = [];
    try { names = await readdir(this.root); } catch { return; }
    for (const name of names) {
      if (!RELEASE_NAME.test(name) || keep.has(name) || this.inUse.has(name)) continue;
      await rm(join(this.root, name), { recursive: true, force: true }).catch(() => {});
    }
    if (dropPrevious && this.state.previous && !this.inUse.has(this.state.previous.dir)) {
      this.state.previous = undefined;
      await this.save();
    }
    if (!fromJob) {
      const downloads = join(this.root, "downloads");
      for (const name of await readdir(downloads).catch(() => [] as string[])) {
        if (name.endsWith(".part")) await rm(join(downloads, name), { force: true }).catch(() => {});
      }
    }
  }

  /**
   * Removes what the single-file build left in `tmp/`. It unpacks itself into
   * a fresh `tmp/_MEI…` folder on every launch and removes it on the way out,
   * except when it is killed: on quit, or when a stop outlasts its grace.
   * With no run and no install going, no such folder is in use.
   */
  private async sweepTemp(): Promise<void> {
    const idle = () => this.inUse.size === 0 && !this.job;
    if (!idle()) return;
    const tmp = join(this.root, "tmp");
    for (const name of await readdir(tmp).catch(() => [] as string[])) {
      // A run that started since the folder was read stops the sweep: the list may hold its folder.
      if (!idle()) return;
      if (name.startsWith("_MEI")) await rm(join(tmp, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The challenge runtime: written and checked once per app version and location. */
  private jsRuntime(): Promise<JsRuntimeStatus> {
    this.runtime ??= (async () => {
      const execPath = this.options.appExecPath;
      await ensureDir(join(this.root, "tmp"));
      await ensureDir(join(this.root, "home"));
      const changed = await writeShim(this.shimPath, execPath);
      const record = this.state.jsRuntime;
      const known = !changed && record?.execPath === execPath && record.appVersion === this.options.version;
      // A failed check is tried once more per launch: it may have been a slow first start.
      if (known && (record.status.kind === "node" || this.runtimeChecked)) return record.status;
      const status = await verifyNodeShim(this.shimPath, this.env, this.exec);
      this.runtimeChecked = true;
      this.state.jsRuntime = { execPath, appVersion: this.options.version, status, checkedAt: this.now().toISOString() };
      if (status.kind === "none") this.log(`JavaScript runtime unavailable: ${status.error}`);
      await this.save();
      return status;
    })().finally(() => { this.runtime = null; });
    return this.runtime;
  }

  /** The arguments every run starts with. */
  baseArgs(proxy: string, runtime: JsRuntimeStatus | undefined): string[] {
    const ffmpeg = join(this.options.ffmpegDir, "ffmpeg");
    return [
      "--ignore-config", "--no-plugin-dirs",
      "--no-cookies", "--no-cookies-from-browser",
      "--color", "never",
      "--cache-dir", join(this.root, "cache"),
      "--proxy", proxy,
      "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "5",
      // The bundled FFmpeg has no network: yt-dlp downloads, FFmpeg only remuxes.
      "--downloader", "native",
      "--no-mtime",
      ...jsRuntimeArgs(runtime, this.shimPath),
      ...(existsSync(ffmpeg) ? ["--ffmpeg-location", this.options.ffmpegDir] : []),
    ];
  }

  /** Runs the installed yt-dlp (installing it first), through the egress gate. Rejects only when it can't be installed. */
  async run(args: string[], options: ManagedRunOptions = {}): Promise<YtDlpRunResult> {
    await this.ensure(options.signal);
    const release = await this.slots.acquire(options.signal).catch(() => null);
    if (!release) return { code: null, signal: null, stdout: "", stderr: downloaderLine("canceled", "The download was canceled.") };
    const current = this.state.current!;
    this.inUse.set(current.dir, (this.inUse.get(current.dir) ?? 0) + 1);
    let touch: (() => void) | undefined;
    let stop: ((kind: "byte-cap", message: string) => void) | undefined;
    let session: EgressSession | undefined;
    const cap = options.maxBytes;
    try {
      session = await this.egress.open({
        maxBytes: cap,
        onActivity: () => touch?.(),
        onLimit: () => stop?.("byte-cap", `The download went over its ${Math.round((cap ?? 0) / (1024 * 1024))} MB limit.`),
      });
      const gate = session;
      this.noteUse();
      const result = await runProcess(this.exePath(current), [...this.baseArgs(gate.url, this.state.jsRuntime?.status), ...args], {
        ...options,
        cwd: options.cwd ?? join(this.root, "tmp"),
        env: this.env,
        activity: (fn) => { touch = fn; },
        stopper: (fn) => { stop = fn; },
        failureLines: () => [
          ...gate.refusedPorts().map((target) => downloaderLine("port", `Refused to connect to ${target}: Blackout's downloader only reaches ports 80 and 443.`)),
          ...gate.refused().map((host) => downloaderLine("private-address", `Refused to connect to ${host}: it is a local or private network address.`)),
        ],
      });
      if (result.code === 0) void this.noteSuccess(current);
      return result;
    } finally {
      session?.close();
      const count = (this.inUse.get(current.dir) ?? 1) - 1;
      if (count > 0) this.inUse.set(current.dir, count);
      else {
        this.inUse.delete(current.dir);
        // The last run of a replaced release: it can go now that its successor has run.
        if (this.state.previous?.dir === current.dir && (this.state.current?.okRuns ?? 0) > 0) void this.prune(true);
      }
      if (current.kind === "onefile") void this.sweepTemp();
      release();
    }
  }

  private noteUse(): void {
    const last = this.state.lastUsedAt ? Date.parse(this.state.lastUsedAt) : NaN;
    const now = this.now();
    if (Number.isFinite(last) && now.getTime() - last < USE_RECORD_MS) return;
    this.state.lastUsedAt = now.toISOString();
    void this.save();
  }

  private async noteSuccess(release: InstalledRelease): Promise<void> {
    const current = this.state.current;
    if (!current || current.dir !== release.dir || current.okRuns > 0) return;
    current.okRuns = 1;
    await this.save();
    if (this.state.previous) await this.prune(true);
  }

  /** Background checks: the first a minute after launch, then hourly, each asking GitHub only when the last check is a day old. */
  startBackgroundChecks(): void {
    if (!this.supported || this.timer || this.disposed) return;
    const tick = async () => {
      this.timer = undefined;
      if (this.disposed) return;
      if (this.dueForCheck()) await this.install("update").catch(() => {});
      if (!this.disposed) this.schedule(tick, BACKGROUND_EVERY_MS);
    };
    this.schedule(tick, BACKGROUND_FIRST_MS);
    // Leftovers from a run that quit mid-install, or mid-run.
    void this.prune(false);
    void this.sweepTemp();
  }

  private schedule(fn: () => Promise<void>, ms: number): void {
    this.timer = setTimeout(() => void fn(), ms);
    this.timer.unref?.();
  }

  /** Whether a background check should ask GitHub now. */
  dueForCheck(): boolean {
    if (!this.state.current || this.job) return false;
    const now = this.now().getTime();
    const used = this.state.lastUsedAt ? Date.parse(this.state.lastUsedAt) : NaN;
    if (!Number.isFinite(used) || now - used > USED_RECENTLY_MS) return false;
    const checked = this.state.lastCheck ? Date.parse(this.state.lastCheck.at) : NaN;
    return !Number.isFinite(checked) || now - checked >= CHECK_EVERY_MS;
  }

  /** A copy of the persisted state, for tests and diagnostics. */
  snapshot(): DownloaderState {
    return structuredClone(this.state);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abortJob?.();
    killAllRuns();
    this.egress.dispose();
  }
}
