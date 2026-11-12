/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The audio intelligence add-on as the rest of main uses it: its status for
// Settings, Install now and Remove, and the one door the sound tools go
// through. The first sound tool call installs it by itself, waiting up to
// about 90 s; past that it answers `busy` with how far the install is, so
// the agent carries on and calls again. From a call on, earshot's caches are
// swept under their limit while the worker runs (see cache.ts), and the
// status Settings shows counts what they hold. Nothing here ever asks the
// user.

import { rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { DapiError, isDapiError } from "@diffusionstudio/dapi";
import { EarshotCache } from "./cache";
import { EarshotInstaller, InstallCanceled } from "./install";
import { EARSHOT } from "./pins";
import { spawnRunner, lastLine } from "./process";
import { EarshotWorker, WorkerTimeout, stdioConnect } from "./worker";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { InstallerOptions } from "./install";
import type { Runner } from "./process";
import type { EarshotStatus, SoundAudit } from "./types";

/** How long a tool call waits for an install it started before answering `busy`. */
export const INSTALL_WAIT_MS = 90 * 1000;

/** One earshot answer: its plain-language text, its JSON, and sheet's picture. */
export type EarshotReply = {
  summary: string;
  json: Record<string, unknown> | null;
  /** The PNG a sheet wrote. */
  png?: string;
  image?: { bytes: Uint8Array; mimeType: string };
};

export type EarshotServiceOptions = {
  userData: string;
  version: string;
  installer?: EarshotInstaller;
  worker?: EarshotWorker;
  cache?: EarshotCache;
  /** What earshot's caches may hold (default `CACHE_LIMIT_BYTES`, 500 MB). */
  cacheLimitBytes?: number;
  /** Overrides for the installer the service makes (tests). */
  install?: Partial<InstallerOptions>;
  run?: Runner;
  waitMs?: number;
  noteContent?: (path: string, text: string | null) => void;
  startWrite?: (dir: string) => () => void;
};

/**
 * earshot's text answer split up: `PNG: <path>` first for a sheet, then the
 * summary (and transcript), and last a line of `JSON: …` or `JSON (compact): …`.
 */
export function parseReply(text: string): Omit<EarshotReply, "image"> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let json: Record<string, unknown> | null = null;
  const match = /^JSON(?: \(compact\))?: (.*)$/.exec(lines.at(-1) ?? "");
  if (match) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
        lines.pop();
      }
    } catch { /* not JSON after all: it stays in the summary */ }
  }
  let png: string | undefined;
  if (lines[0]?.startsWith("PNG: ")) png = lines.shift()!.slice(5).trim();
  return { summary: lines.join("\n").trim(), json, ...(png ? { png } : {}) };
}

function delay(ms: number, signal?: AbortSignal): Promise<"waited"> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve("waited"); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const canceled = () => new DapiError("canceled", "The sound tool call was canceled.");

/** Why a call stopped: the reason it was given when that is one an agent can act on (a save, a move), else canceled. */
function canceledBy(signal: AbortSignal | undefined): DapiError {
  const reason: unknown = signal?.reason;
  return isDapiError(reason) ? reason : canceled();
}

/** What to do about a call that ran out of time, by earshot tool. */
const TIMEOUT_ADVICE: Record<string, string> = {
  timeline: 'Analyze a shorter start/end window, or use detail "low".',
  sheet: 'Analyze a shorter start/end window, or use detail "low".',
  critique: "Pass fast: true, or critique a shorter export.",
  rank: "Rank fewer files at once.",
  compare: "Compare against fewer references, or a shorter start/end window.",
  realness: "Check fewer files at once, or a shorter start/end window.",
};

export function timeoutAdvice(tool: string): string {
  return TIMEOUT_ADVICE[tool] ?? (tool.startsWith("sfx_") || tool.startsWith("kit_") ? "Call it again." : "Analyze a shorter start/end window.");
}

type JobEntry = { dir: string; controller: AbortController; write: (() => void) | null; temps: Set<string> };

/** One job's handle: its signal, what to call when it is over, and the temporary paths a quit removes. */
export type ProjectJob = { signal: AbortSignal; done: () => void; hold: (path: string) => void };

/**
 * Work on its way into a project folder that doesn't hold up a save or move
 * while it runs (a render can wait behind a long analysis), but stops when
 * one is asked for: the folder is about to go, and whoever asked has let go
 * of the project. A stopped job counts as a write into the folder until it
 * is done, so the move takes a folder it has finished with. Quitting stops
 * every job and removes its temporary files at once.
 */
export class ProjectJobs {
  private readonly jobs = new Set<JobEntry>();
  private readonly startWrite: (dir: string) => () => void;
  private readonly reason: string;

  constructor(startWrite: (dir: string) => () => void, reason: string) {
    this.startWrite = startWrite;
    this.reason = reason;
  }

  /** A job into `dir`: its signal (aborted with the caller's, or by `cancel`), what to call when it is over, and `hold` for its temporary paths. */
  start(dir: string, signal?: AbortSignal): ProjectJob {
    const job: JobEntry = { dir, controller: new AbortController(), write: null, temps: new Set() };
    this.jobs.add(job);
    return {
      signal: signal ? AbortSignal.any([signal, job.controller.signal]) : job.controller.signal,
      done: () => {
        this.jobs.delete(job);
        job.temps.clear();
        job.write?.();
        job.write = null;
      },
      hold: (path) => { job.temps.add(path); },
    };
  }

  /** Whether a running job holds `path` (a sweep of temporary folders leaves it). */
  holds(path: string): boolean {
    for (const job of this.jobs) if (job.temps.has(path)) return true;
    return false;
  }

  /** The project in `dir` is about to be saved or moved: its jobs stop. */
  cancel(dir: string): void {
    for (const job of this.jobs) {
      if (job.dir !== dir) continue;
      job.write ??= this.startWrite(dir);
      job.controller.abort(new DapiError("no-project", this.reason));
    }
  }

  /** The app is quitting: every job stops, and its temporary files go now, as nothing waits for the cleanup that would follow. */
  dispose(): void {
    for (const job of this.jobs) {
      job.controller.abort(new DapiError("canceled", "Blackout quit while the sound effect rendered."));
      for (const path of job.temps) rmSync(path, { recursive: true, force: true });
      job.temps.clear();
    }
  }
}

export class EarshotService {
  readonly installer: EarshotInstaller;
  readonly worker: EarshotWorker;
  readonly version: string;
  readonly noteContent: (path: string, text: string | null) => void;
  readonly startWrite: (dir: string) => () => void;
  /** The app's own stores, which the sound tools never read for an agent. */
  readonly privateDirs: readonly string[];
  /** `sound_effects` renders on their way into a project (see `cancelRenders`). */
  readonly renders: ProjectJobs;
  /** earshot's caches, kept under their limit while the worker runs. */
  readonly cache: EarshotCache;
  private readonly run: Runner;
  private readonly waitMs: number;

  constructor(options: EarshotServiceOptions) {
    this.version = options.version;
    this.installer = options.installer ?? new EarshotInstaller({
      root: join(options.userData, "addons", "earshot"),
      userData: options.userData,
      userAgent: `Blackout/${options.version} (desktop video editor; https://github.com/diffusionstudio/editor)`,
      ...options.install,
    });
    const installer = this.installer;
    this.worker = options.worker ?? new EarshotWorker({
      connect: stdioConnect({
        command: installer.python,
        args: ["-m", "earshot", "mcp"],
        env: this.workerEnv(),
        cwd: installer.root,
        version: options.version,
        log: (line) => console.info(`[earshot] ${line}`),
      }),
    });
    this.run = options.run ?? spawnRunner;
    this.waitMs = options.waitMs ?? INSTALL_WAIT_MS;
    this.noteContent = options.noteContent ?? (() => {});
    this.startWrite = options.startWrite ?? (() => () => {});
    this.privateDirs = [join(options.userData, "agent-chat"), join(options.userData, "instagram")];
    this.renders = new ProjectJobs(this.startWrite, "The project was saved or moved while the sound effect rendered. Render it again in the project where it is now.");
    this.cache = options.cache ?? new EarshotCache({ home: installer.home, limitBytes: options.cacheLimitBytes, inUse: (path) => this.renders.holds(path) });
  }

  /** The project in `dir` is about to be saved or moved: renders into it stop, and the move waits until they have. */
  cancelRenders(dir: string): void {
    this.renders.cancel(dir);
  }

  /** What earshot runs with: the installer's environment, offline, a few CPU threads. */
  private workerEnv(): NodeJS.ProcessEnv {
    return {
      ...this.installer.earshotEnv(),
      EARSHOT_OFFLINE: "1",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      EARSHOT_THREADS: String(threadsFor(availableParallelism())),
    };
  }

  /** The add-on's status for Settings; once it is ready, its size includes what earshot's caches hold now. */
  async status(): Promise<EarshotStatus> {
    const status = await this.installer.status();
    if (status.state !== "ready") return status;
    const cached = await this.cache.size();
    return { ...status, sizeBytes: (status.sizeBytes ?? 0) + cached, cacheBytes: cached, cacheLimitBytes: this.cache.limitBytes };
  }

  /** Settings' Install now: starts (or joins) the install and answers at once; Settings follows it by status. */
  async install(): Promise<EarshotStatus> {
    void this.installer.ensureInstalled().catch(() => {});
    return this.status();
  }

  /** Settings' Remove: stops the worker and any install, and deletes the add-on's folder; an install after it starts the worker afresh. */
  async remove(): Promise<EarshotStatus> {
    this.cache.stop();
    await this.installer.remove(async () => {
      await this.worker.stop();
      this.worker.forgetCrashes();
    });
    this.cache.forget();
    return this.status();
  }

  /** Keeps earshot's caches under their limit from now until the worker stops (the worker starts with a call, so that is when). */
  private tidy(): void {
    this.cache.keepTidy(() => this.worker.running);
  }

  /**
   * Installs on first use, waiting up to `waitMs`. Past that it throws `busy`
   * with how far the install is; an install that failed is retried by the
   * next call.
   */
  async ready(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw canceledBy(signal);
    if (await this.installer.isReady()) return;
    const install = this.installer.ensureInstalled();
    let outcome: "ready" | "waited" | { error: unknown };
    try {
      outcome = await Promise.race([
        install.then(() => "ready" as const, (error: unknown) => ({ error })),
        delay(this.waitMs, signal),
      ]);
    } catch {
      throw canceledBy(signal);
    }
    if (outcome === "ready") return;
    if (outcome === "waited") {
      const where = this.installer.describe(await this.installer.status());
      throw new DapiError("busy", `Audio intelligence is installing (${where}). Continue with other work and call this tool again in a few minutes.`);
    }
    const error = outcome.error;
    if (error instanceof InstallCanceled) throw new DapiError("canceled", "Audio intelligence was removed from Blackout's Settings while installing, so the sound tools can't run right now.");
    const reason = (error as Error)?.message ?? String(error);
    if (/Apple silicon|macOS only/.test(reason)) throw new DapiError("unsupported", reason);
    throw new DapiError("unsupported", `Audio intelligence couldn't be installed: ${reason.replace(/\.$/, "")}. Calling a sound tool again retries the install (it resumes where it stopped), or use Install now in Blackout's Settings.`);
  }

  /** One earshot MCP tool, installed and started as needed. */
  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<EarshotReply> {
    await this.ready(signal);
    this.tidy();
    let result: CallToolResult;
    try {
      result = await this.worker.call(tool, args, { signal, timeoutMs });
    } catch (error) {
      if (signal?.aborted) throw canceledBy(signal);
      if (error instanceof WorkerTimeout) {
        throw new DapiError("busy", `earshot's ${tool} took longer than ${Math.round(timeoutMs / 60_000) || 1} minutes and was stopped. ${timeoutAdvice(tool)}`, { cause: error });
      }
      throw error;
    }
    const texts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text);
    const text = texts.join("\n").trim();
    if (result.isError) throw new DapiError("invalid-input", text || `earshot's ${tool} failed.`);
    const reply: EarshotReply = parseReply(text);
    const image = result.content.find((part): part is { type: "image"; data: string; mimeType: string } => part.type === "image");
    if (image) reply.image = { bytes: new Uint8Array(Buffer.from(image.data, "base64")), mimeType: image.mimeType || "image/jpeg" };
    return reply;
  }

  /** earshot's model-free audit of one file (`earshot sfx check`; its MCP server has no tool for it). */
  async check(path: string, context: { category?: string; role?: string }, signal?: AbortSignal): Promise<SoundAudit> {
    await this.ready(signal);
    this.tidy();
    const args = ["-m", "earshot", "sfx", "check", path, "--json"];
    if (context.category) args.push("--category", context.category);
    if (context.role) args.push("--role", context.role);
    let result;
    try {
      result = await this.run(this.installer.python, args, { env: this.workerEnv(), cwd: this.installer.root, signal, timeoutMs: 5 * 60 * 1000 });
    } catch (error) {
      if (signal?.aborted) throw canceledBy(signal);
      throw error;
    }
    let parsed: Partial<SoundAudit> | null = null;
    try { parsed = JSON.parse(result.stdout) as Partial<SoundAudit>; } catch { parsed = null; }
    if (!parsed || typeof parsed.ok !== "boolean") {
      throw new DapiError("invalid-input", `earshot couldn't audit the file: ${lastLine(result.stderr).replace(/^earshot sfx: error:\s*/, "") || `exit ${result.code}`}`);
    }
    return audit(parsed);
  }

  /** The earshot version that answers. */
  async earshotVersion(): Promise<string> {
    return (await this.installer.status()).versions?.earshot ?? EARSHOT.version;
  }

  dispose(): void {
    this.cache.stop();
    this.renders.dispose();
    this.installer.dispose();
    this.worker.dispose();
  }
}

/** Torch threads for earshot: half the cores, 1 to 4. */
export function threadsFor(cores: number): number {
  return Math.min(4, Math.max(1, Math.floor(cores / 2)));
}

/** earshot's audit, kept to the fields the tools publish. */
export function audit(value: Partial<SoundAudit> | null | undefined): SoundAudit {
  const items = (list: unknown) => (Array.isArray(list) ? list : []).filter((item): item is { code: string; msg: string } => !!item && typeof item.code === "string" && typeof item.msg === "string").map(({ code, msg }) => ({ code, msg }));
  return { ok: value?.ok === true, summary: typeof value?.summary === "string" ? value.summary : "", warnings: items(value?.warnings), notes: items(value?.notes) };
}

let singleton: EarshotService | undefined;

/** Sets up the app's add-on with what only main.ts has; call once, after the profile's userData is set. */
export function configureEarshot(options: EarshotServiceOptions): EarshotService {
  singleton?.dispose();
  singleton = new EarshotService(options);
  return singleton;
}

/** The app's add-on. */
export function earshot(): EarshotService {
  if (!singleton) throw new DapiError("unsupported", "Audio intelligence isn't set up in this build.");
  return singleton;
}
