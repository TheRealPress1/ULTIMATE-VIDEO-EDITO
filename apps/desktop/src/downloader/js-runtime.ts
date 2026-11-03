/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A JavaScript runtime for yt-dlp's YouTube challenge solver, without
// downloading one: Cutroom's own Electron binary runs as plain Node when
// ELECTRON_RUN_AS_NODE is set. yt-dlp only takes a path, so a two-line shell
// script beside the downloader sets that variable and execs the app binary
// with yt-dlp's arguments; the variable never enters yt-dlp's own
// environment.
//
// yt-dlp (yt_dlp/extractor/youtube/jsc/_builtin/node.py, as shipped in
// 2026.10.26) asks `<node> --version` for a version (22 or newer) and then
// runs `<node> --permission -` (`--experimental-permission
// --no-warnings=ExperimentalWarning` below Node 23.5), feeding the solver on
// stdin and treating any stderr output as a failure. The check here runs that
// same invocation, so a runtime that passes it works for yt-dlp too. (It adds
// `--v8-flags=--jitless` only when its `jitless` setting is turned on, which
// Cutroom never does; Electron's Node mode rejects that flag.)
//
// Checked on Electron 44.9.3 (Node 24.22.0), dev and the signed, notarized
// app alike: yt-dlp reports "JS runtimes: node-24.22.0" for the shim, and its
// bundled solver (yt_dlp_ejs lib + core) runs to completion under
// `--permission -` with nothing on stderr.

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { JsRuntimeStatus } from "./types";

/** The oldest Node yt-dlp accepts as a challenge runtime. */
export const NODE_MINIMUM: readonly [number, number, number] = [22, 0, 0];

/** `value` as one POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The shim: the app binary in Node mode, NODE_OPTIONS cleared so nothing outside Cutroom can preload code into it. */
export function shimScript(execPath: string): string {
  return [
    "#!/bin/sh",
    "# Written by Cutroom: runs Cutroom's own binary as Node for yt-dlp.",
    "unset NODE_OPTIONS NODE_PATH",
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} "$@"`,
    "",
  ].join("\n");
}

/** Writes the shim at `path` when it is missing or names another binary (the app was moved). Returns whether it changed. */
export async function writeShim(path: string, execPath: string): Promise<boolean> {
  const text = shimScript(execPath);
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === text) {
    await chmod(path, 0o755);
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o755 });
    await chmod(temp, 0o755);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return true;
}

/** `v24.22.0` → [24, 22, 0]; null when the output names no version. */
export function parseNodeVersion(output: string): [number, number, number] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)/m.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index++) {
    const a = version[index] ?? 0, b = minimum[index]!;
    if (a !== b) return a > b;
  }
  return true;
}

/** The permission flags yt-dlp passes to a Node of `version`. */
export function permissionArgs(version: readonly number[]): string[] {
  return atLeast(version, [23, 5, 0]) ? ["--permission"] : ["--experimental-permission", "--no-warnings=ExperimentalWarning"];
}

export type ExecResult = { code: number | null; stdout: string; stderr: string; error?: Error };
export type Exec = (file: string, args: string[], options: { input?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

/** Runs `file` without a shell, `input` on stdin; never rejects. */
export const execText: Exec = (file, args, options) => new Promise((settle) => {
  let stdout = "", stderr = "";
  const child = spawn(file, args, { env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < 65536) stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 65536) stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
  child.on("error", (error) => { clearTimeout(timer); settle({ code: null, stdout, stderr, error }); });
  child.on("close", (code) => { clearTimeout(timer); settle({ code, stdout, stderr }); });
});

/**
 * Whether the shim works the way yt-dlp will use it: a version of 22 or
 * newer, and a stdin script run under the permission model printing exactly
 * its result with nothing on stderr.
 */
export async function verifyNodeShim(shim: string, env: NodeJS.ProcessEnv, exec: Exec = execText): Promise<JsRuntimeStatus> {
  const probe = await exec(shim, ["--version"], { env, timeoutMs: 20_000 });
  const version = parseNodeVersion(probe.stdout);
  if (!version) {
    const why = probe.error?.message ?? (probe.stderr.trim() || `exit ${probe.code}`);
    return { kind: "none", error: `The app's Node mode didn't report a version (${why.slice(0, 200)}).` };
  }
  const text = version.join(".");
  if (!atLeast(version, NODE_MINIMUM)) return { kind: "none", error: `The app's Node ${text} is older than the ${NODE_MINIMUM[0]} yt-dlp needs.` };
  const run = await exec(shim, [...permissionArgs(version), "-"], { env, input: "console.log(6 * 7);\n", timeoutMs: 20_000 });
  if (run.code !== 0 || run.stdout.trim() !== "42" || run.stderr.trim()) {
    const why = run.error?.message ?? (run.stderr.trim() || `exit ${run.code}, output ${JSON.stringify(run.stdout.trim().slice(0, 40))}`);
    return { kind: "none", error: `The app's Node ${text} can't run yt-dlp's challenge solver (${why.slice(0, 200)}).` };
  }
  return { kind: "node", version: text };
}

/** yt-dlp's runtime flags: clear its defaults (a Deno the user installed, say), then enable only the shim. */
export function jsRuntimeArgs(runtime: JsRuntimeStatus | undefined, shim: string): string[] {
  return runtime?.kind === "node" ? ["--no-js-runtimes", "--js-runtimes", `node:${shim}`] : ["--no-js-runtimes"];
}
