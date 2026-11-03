/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyYtDlpError, downloaderLine } from "./yt-dlp-errors";
import { runProcess } from "./yt-dlp-run";

let dir: string;
const env = { PATH: "/usr/bin:/bin" };

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(test: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "uve-ytdlp-run-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("runProcess", () => {
  it("collects output and splits lines on newlines and progress redraws", async () => {
    const exe = await script("lines", `printf 'one\\ntwo\\r\\nthree'; printf '[download]  10%%\\r[download]  50%%\\rERROR: last\\n' >&2; exit 3`);
    const out: string[] = [], err: string[] = [];
    const result = await runProcess(exe, [], { env, cwd: dir, onStdoutLine: (line) => out.push(line), onStderrLine: (line) => err.push(line) });
    expect(result).toMatchObject({ code: 3, signal: null, stdout: "one\ntwo\r\nthree" });
    expect(out).toEqual(["one", "two", "three"]);
    expect(err).toEqual(["[download]  10%", "[download]  50%", "ERROR: last"]);
  });

  it("passes only the environment it is given", async () => {
    process.env.UVE_SHOULD_NOT_LEAK = "1";
    const exe = await script("env", "env");
    const result = await runProcess(exe, [], { env: { ...env, ONLY: "this" }, cwd: dir });
    delete process.env.UVE_SHOULD_NOT_LEAK;
    expect(result.stdout).toContain("ONLY=this");
    expect(result.stdout).not.toContain("UVE_SHOULD_NOT_LEAK");
    expect(result.stdout).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("ends the whole process group on cancel", async () => {
    const pidFile = join(dir, "child.pid");
    const exe = await script("forks", `sleep 30 &\necho $! > '${pidFile}'\necho started\nwait`);
    const controller = new AbortController();
    const running = runProcess(exe, [], { env, cwd: dir, signal: controller.signal, onStdoutLine: () => controller.abort() });
    const result = await running;
    const child = Number((await readFile(pidFile, "utf8")).trim());
    expect(child).toBeGreaterThan(0);
    await waitUntil(() => !alive(child));
    expect(result.code).toBeNull();
    expect(classifyYtDlpError(result.stderr, result.code, result.signal).category).toBe("canceled");
  });

  it("answers at once when canceled before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess("/bin/sleep", ["30"], { env, cwd: dir, signal: controller.signal });
    expect(classifyYtDlpError(result.stderr, result.code, result.signal).category).toBe("canceled");
  });

  it("stops a run that takes too long, or goes quiet", async () => {
    const slow = await script("slow", "while true; do echo tick; sleep 0.05; done");
    const timed = await runProcess(slow, [], { env, cwd: dir, timeoutMs: 300, killGraceMs: 200 });
    expect(classifyYtDlpError(timed.stderr, timed.code, timed.signal)).toMatchObject({ category: "too-large", reason: "timeout" });

    const quiet = await script("quiet", "exec sleep 30");
    let touch: (() => void) | undefined;
    const started = Date.now();
    const stalled = await runProcess(quiet, [], { env, cwd: dir, idleTimeoutMs: 300, killGraceMs: 200, activity: (fn) => { touch = fn; } });
    expect(touch).toBeTypeOf("function");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(classifyYtDlpError(stalled.stderr, stalled.code, stalled.signal)).toMatchObject({ category: "network", reason: "stalled" });
  });

  it("caps stdout and keeps the tail of stderr", async () => {
    const loud = await script("loud", "head -c 300000 /dev/zero | tr '\\\\0' 'a'; sleep 5");
    const capped = await runProcess(loud, [], { env, cwd: dir, stdoutMax: 100_000, killGraceMs: 200 });
    expect(capped.stdout.length).toBeLessThanOrEqual(100_000);
    expect(classifyYtDlpError(capped.stderr, capped.code, capped.signal)).toMatchObject({ category: "too-large", reason: "byte-cap" });

    const chatty = await script("chatty", "i=0; while [ $i -lt 2000 ]; do echo \"WARNING: line $i\" >&2; i=$((i+1)); done; echo 'ERROR: [youtube] abc: Video unavailable' >&2; exit 1");
    const tail = await runProcess(chatty, [], { env, cwd: dir, stderrMax: 4096 });
    expect(tail.stderr.length).toBeLessThanOrEqual(4096);
    expect(tail.stderr.startsWith("WARNING: line")).toBe(true);
    expect(classifyYtDlpError(tail.stderr, tail.code).category).toBe("unavailable");
  });

  it("reports a binary that won't start", async () => {
    const missing = await runProcess(join(dir, "missing"), [], { env, cwd: dir });
    expect(classifyYtDlpError(missing.stderr, missing.code)).toMatchObject({ category: "blocked", reason: "os-blocked" });
    const plain = join(dir, "not-executable");
    await writeFile(plain, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    const denied = await runProcess(plain, [], { env, cwd: dir });
    expect(denied.stderr).toContain("EACCES");
  });

  it("adds its failure lines only when the run failed", async () => {
    const lines = () => [downloaderLine("private-address", "Refused to connect to 10.0.0.2.")];
    const ok = await runProcess(await script("ok", "exit 0"), [], { env, cwd: dir, failureLines: lines });
    expect(ok.stderr).toBe("");
    const failed = await runProcess(await script("fail", "echo 'ERROR: Unable to download webpage: Tunnel connection failed: 403 Forbidden' >&2; exit 1"), [], { env, cwd: dir, failureLines: lines });
    expect(classifyYtDlpError(failed.stderr, failed.code)).toMatchObject({ category: "unavailable", reason: "private-address" });
  });

  it("can be stopped from outside", async () => {
    let stop: ((kind: "byte-cap", message: string) => void) | undefined;
    const running = runProcess(await script("waits", "exec sleep 30"), [], { env, cwd: dir, stopper: (fn) => { stop = fn; } });
    stop!("byte-cap", "Over the cap.");
    const result = await running;
    expect(classifyYtDlpError(result.stderr, result.code, result.signal)).toMatchObject({ category: "too-large", reason: "byte-cap", detail: "Over the cap." });
  });
});
