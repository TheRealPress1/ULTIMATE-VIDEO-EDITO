/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Child processes and downloads for the audio intelligence add-on: one way
// to run a command (bounded output, a timeout, cancel that takes the whole
// process group with it), one way to fetch a pinned file (HTTPS to known
// hosts only, redirects checked hop by hop, SHA-256 verified before the file
// gets its name), and the folder sizes the install reports.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DOWNLOAD_HOSTS } from "./pins";

import type { PinnedFile } from "./pins";

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

export type RunOptions = {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  /** Killed after this long; no limit when omitted. */
  timeoutMs?: number;
};

/** Runs a command to its end; never throws for a non-zero exit, only for one that could not start or was canceled. */
export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Unpacks `members` of the archive at `archive` into the folder `into`. */
export type Extract = (archive: string, into: string, members: readonly string[]) => Promise<void>;

export type Fetch = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;

/** What a command may print before the rest is dropped: pip and doctor JSON stay far below it. */
const STDOUT_MAX = 8 * 1024 * 1024;
const STDERR_MAX = 256 * 1024;
const KILL_GRACE_MS = 3000;

function canceledError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("The audio intelligence install was stopped.");
}

/** `spawn` in its own process group, so a cancel or a timeout also stops what the command started (uv's builds, Python's workers). */
export const spawnRunner: Runner = (command, args, options) =>
  new Promise<RunResult>((settle, reject) => {
    if (options.signal?.aborted) return reject(canceledError(options.signal));
    let stdout = "";
    let stderr = "";
    let finished = false;
    let killer: NodeJS.Timeout | undefined;
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => {
      if (finished || child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      killer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, KILL_GRACE_MS);
      killer.unref();
    };
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs) : undefined;
    timer?.unref();
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < STDOUT_MAX) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_MAX) stderr = stderr.slice(-STDERR_MAX);
    });
    const done = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(killer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (code, signal) => {
      done();
      if (options.signal?.aborted) return reject(canceledError(options.signal));
      if (timedOut) return reject(new Error(`${command.split("/").pop()} took longer than ${Math.round(options.timeoutMs! / 60_000) || 1} min and was stopped.`));
      settle({ code, signal, stdout, stderr });
    });
  });

/** macOS's bsdtar, which reads tar.gz and zip alike. */
export function tarExtract(run: Runner): Extract {
  return async (archive, into, members) => {
    const result = await run("/usr/bin/tar", ["-xf", archive, "-C", into, ...members], { env: { PATH: "/usr/bin:/bin" } });
    if (result.code !== 0) throw new Error(`The downloaded archive couldn't be unpacked (${lastLine(result.stderr) || `tar exited ${result.code}`}).`);
  };
}

/** The line a failed command's output says the most in: uv's `error:` and its deepest cause, else the last line. */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const error = lines.findIndex((line) => /^error:/i.test(line));
  if (error >= 0) {
    const causes = lines.slice(error + 1).filter((line) => /^caused by:/i.test(line));
    const cause = causes.at(-1)?.replace(/^caused by:\s*/i, "");
    return clip([lines[error]!.replace(/^error:\s*/i, ""), cause].filter(Boolean).join(": "));
  }
  return clip(lines.at(-1) ?? "");
}

/** One line of at most 300 characters. */
export function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

export class ChecksumError extends Error {}

/**
 * Downloads `file` to `dest`: HTTPS only, every hop's host one of
 * DOWNLOAD_HOSTS, streamed to `<dest>.part` while hashed, renamed into place
 * only when its SHA-256 is the pinned one. A partial or wrong file never
 * stays behind.
 */
export async function fetchVerified(
  fetch: Fetch,
  file: PinnedFile,
  dest: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void = () => {},
  userAgent = "Blackout",
): Promise<void> {
  let url = new URL(file.url);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname)) {
      throw new Error(`The download of ${new URL(file.url).pathname.split("/").pop()} was sent to ${url.hostname}, which Blackout doesn't download from.`);
    }
    const response = await fetch(url.href, { signal, redirect: "manual", headers: { "user-agent": userAgent, accept: "application/octet-stream" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop >= 5) throw new Error(`${url.hostname} redirected the download too many times.`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${url.hostname} answered ${response.status} for ${new URL(file.url).pathname.split("/").pop()}.`);
    }
    const part = `${dest}.part`;
    await rm(part, { force: true });
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(part, "wx", 0o644);
    try {
      const reader = response.body.getReader();
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > file.bytes * 2 + 1024 * 1024) throw new ChecksumError(`${url.hostname} sent more than the pinned file holds.`);
          hash.update(value);
          await handle.write(value);
          onBytes(bytes);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      await handle.close();
      const digest = hash.digest("hex");
      if (digest !== file.sha256) {
        throw new ChecksumError(`${new URL(file.url).pathname.split("/").pop()} didn't match its pinned SHA-256 (got ${digest.slice(0, 12)}…), so it wasn't used.`);
      }
      await rename(part, dest);
      return;
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(part, { force: true });
      throw error;
    }
  }
}

/** What the regular files under `path` take on disk (as `du` counts it), links not followed. */
export async function folderBytes(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (!info) return 0;
  if (info.isFile()) return Number.isFinite(info.blocks) && info.blocks > 0 ? info.blocks * 512 : info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  const entries = await readdir(path).catch(() => [] as string[]);
  for (const entry of entries) total += await folderBytes(join(path, entry));
  return total;
}
