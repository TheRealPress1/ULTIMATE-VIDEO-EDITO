/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Running yt-dlp: in its own process group, so canceling also ends the
// ffmpeg and Node processes it starts; with an environment built from
// nothing, so no proxy variable, NODE_OPTIONS or Python path of the user's
// reaches it; with its output bounded (a `-J` of a long playlist is large, a
// stuck progress bar endless); and with the reason it stopped early added to
// stderr as a `[cutroom:<kind>]` line, which `classifyYtDlpError` reads
// first. It never rejects: a failure is a result for the caller to classify.

import { spawn } from "node:child_process";
import { downloaderLine } from "./yt-dlp-errors";

import type { ChildProcess } from "node:child_process";
import type { DownloaderLineKind } from "./yt-dlp-errors";

export type YtDlpRunOptions = {
  signal?: AbortSignal;
  cwd?: string;
  /** The whole run, by default 30 minutes. */
  timeoutMs?: number;
  /** Silence (no output, no network traffic) after which the run counts as stalled; by default 2 minutes. */
  idleTimeoutMs?: number;
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
};

export type YtDlpRunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

export type ProcessOptions = YtDlpRunOptions & {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Called on network traffic too, so a quiet download isn't taken for a stalled one. */
  activity?: (touch: () => void) => void;
  /** Ends the run early from outside (the egress session went over its cap, say). */
  stopper?: (stop: (kind: DownloaderLineKind, message: string) => void) => void;
  /** Extra stderr lines for a failed run (refused hosts), read once it ends. */
  failureLines?: () => string[];
  stdoutMax?: number;
  stderrMax?: number;
  killGraceMs?: number;
};

export const RUN_TIMEOUT_MS = 30 * 60_000;
export const IDLE_TIMEOUT_MS = 2 * 60_000;
export const STDOUT_MAX = 64 * 1024 * 1024;
export const STDERR_MAX = 256 * 1024;
const KILL_GRACE_MS = 2_000;

/** Processes still running, so quitting the app can end them. */
const running = new Set<ChildProcess>();

/** Signals the whole process group, falling back to the process alone. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Ends every yt-dlp still running, children and all. */
export function killAllRuns(): void {
  for (const child of running) killGroup(child, "SIGKILL");
  running.clear();
}

/** Splits a stream into lines on \n, \r\n and the bare \r progress bars redraw with. */
function lineSplitter(emit: ((line: string) => void) | undefined): { push(text: string): void; flush(): void } {
  let partial = "";
  const send = (line: string) => {
    if (!line || !emit) return;
    try { emit(line); } catch { /* a listener's failure must not end the run */ }
  };
  return {
    push(text) {
      if (!emit) return;
      const parts = (partial + text).split(/\r\n|\n|\r/);
      partial = parts.pop() ?? "";
      if (partial.length > 65536) partial = partial.slice(-65536);
      for (const line of parts) send(line);
    },
    flush() {
      send(partial);
      partial = "";
    },
  };
}

/** Runs `file` with `args` under the rules above. */
export function runProcess(file: string, args: readonly string[], options: ProcessOptions): Promise<YtDlpRunResult> {
  const stdoutMax = options.stdoutMax ?? STDOUT_MAX;
  const stderrMax = options.stderrMax ?? STDERR_MAX;
  if (options.signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: downloaderLine("canceled", "The download was canceled.") });
  }
  return new Promise((settle) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      settle({ code: null, signal: null, stdout: "", stderr: downloaderLine("spawn", `macOS couldn't start the downloader (${(error as NodeJS.ErrnoException).code ?? "error"}).`) });
      return;
    }
    running.add(child);
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let own: string | undefined;
    let done = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const outLines = lineSplitter(options.onStdoutLine);
    const errLines = lineSplitter(options.onStderrLine);

    const stop = (kind: DownloaderLineKind, message: string) => {
      if (done || own) return;
      own = downloaderLine(kind, message);
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    const touch = () => {
      if (done || !idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("stalled", `The download stalled: nothing arrived for ${Math.round(idleMs / 1000)} seconds.`), idleMs);
      idleTimer.unref?.();
    };
    const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    const overall = setTimeout(() => stop("timeout", `The download took longer than ${Math.round(timeoutMs / 60_000) || 1} minutes.`), timeoutMs);
    overall.unref?.();
    const abort = () => stop("canceled", "The download was canceled.");
    options.signal?.addEventListener("abort", abort, { once: true });
    options.activity?.(touch);
    options.stopper?.(stop);
    touch();

    child.stdout!.on("data", (chunk: Buffer) => {
      touch();
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutMax) {
        stop("byte-cap", `yt-dlp printed more than ${Math.round(stdoutMax / (1024 * 1024))} MB.`);
        return;
      }
      stdoutChunks.push(chunk);
      outLines.push(chunk.toString("utf8"));
    });
    child.stderr!.setEncoding("utf8").on("data", (text: string) => {
      touch();
      stderr += text;
      // Keep the tail, where the final ERROR line is, from a line start.
      if (stderr.length > stderrMax) {
        const cut = stderr.slice(-stderrMax);
        const newline = cut.indexOf("\n");
        stderr = newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut;
      }
      errLines.push(text);
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      running.delete(child);
      clearTimeout(overall);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      outLines.flush();
      errLines.flush();
      if (spawnError && !own) own = downloaderLine("spawn", `macOS couldn't start the downloader (${spawnError.code ?? spawnError.message}).`);
      // The downloader's own reason goes last: the classifier reads the last tagged line.
      const extra = code === 0 && !own ? [] : (options.failureLines?.() ?? []);
      const tail = [...extra, ...(own ? [own] : [])];
      const text = tail.length ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${tail.join("\n")}\n` : stderr;
      settle({ code, signal, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: text });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      // A process that never started has no close to wait for.
      if (child.pid === undefined) finish(null, null, error);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
}
