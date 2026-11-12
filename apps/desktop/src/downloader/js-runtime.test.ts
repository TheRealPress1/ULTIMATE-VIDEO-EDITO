/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execText, jsRuntimeArgs, parseNodeVersion, permissionArgs, shellQuote, shimScript, verifyNodeShim, writeShim } from "./js-runtime";

import type { Exec, ExecResult } from "./js-runtime";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uve-js-runtime-"));
  dirs.push(dir);
  return dir;
}

/** An exec answering `--version` and the stdin run from a script of results. */
function fakeExec(version: ExecResult, run?: ExecResult): Exec & { calls: Array<{ args: string[]; input?: string }> } {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const exec = (async (_file: string, args: string[], options: { input?: string }) => {
    calls.push({ args, input: options.input });
    return args[0] === "--version" ? version : (run ?? { code: 1, stdout: "", stderr: "" });
  }) as unknown as Exec & { calls: typeof calls };
  exec.calls = calls;
  return exec;
}

describe("the node shim", () => {
  it("quotes paths with spaces and quotes", () => {
    expect(shellQuote("/Applications/My App.app")).toBe("'/Applications/My App.app'");
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    const text = shimScript("/Applications/Cut 'room'.app/Contents/MacOS/Blackout");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain("unset NODE_OPTIONS NODE_PATH");
    expect(text).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Applications/Cut '\\''room'\\''.app/Contents/MacOS/Blackout' "$@"`);
  });

  it("runs the quoted binary with every argument intact", async () => {
    const dir = await scratch();
    const fake = join(dir, "bin with 'quote'");
    await writeFile(fake, '#!/bin/sh\nprintf "%s|" "$ELECTRON_RUN_AS_NODE" "$NODE_OPTIONS" "$@"\n', { mode: 0o755 });
    const shim = join(dir, "node-shim");
    await writeShim(shim, fake);
    const result = await execText(shim, ["--permission", "a b", "-"], { env: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--require /tmp/evil.js" }, timeoutMs: 10_000 });
    expect(result.stdout).toBe("1||--permission|a b|-|");
  });

  it("is rewritten only when the app moved", async () => {
    const dir = await scratch();
    const shim = join(dir, "tools", "node-shim");
    expect(await writeShim(shim, "/Applications/Blackout.app/Contents/MacOS/Blackout")).toBe(true);
    expect(await writeShim(shim, "/Applications/Blackout.app/Contents/MacOS/Blackout")).toBe(false);
    expect((await stat(shim)).mode & 0o777).toBe(0o755);
    expect(await writeShim(shim, "/Users/me/Applications/Blackout.app/Contents/MacOS/Blackout")).toBe(true);
    expect(await readFile(shim, "utf8")).toContain("/Users/me/Applications/");
  });
});

describe("versions and flags", () => {
  it("parses node's version", () => {
    expect(parseNodeVersion("v24.22.0\n")).toEqual([24, 22, 0]);
    expect(parseNodeVersion("Electron v1")).toBeNull();
    expect(parseNodeVersion("")).toBeNull();
  });

  it("passes the permission flag yt-dlp passes for that version", () => {
    expect(permissionArgs([24, 22, 0])).toEqual(["--permission"]);
    expect(permissionArgs([23, 5, 0])).toEqual(["--permission"]);
    expect(permissionArgs([22, 12, 0])).toEqual(["--experimental-permission", "--no-warnings=ExperimentalWarning"]);
  });

  it("clears yt-dlp's default runtimes before enabling the shim", () => {
    expect(jsRuntimeArgs({ kind: "node", version: "24.22.0" }, "/x/node-shim")).toEqual(["--no-js-runtimes", "--js-runtimes", "node:/x/node-shim"]);
    expect(jsRuntimeArgs({ kind: "none", error: "no" }, "/x/node-shim")).toEqual(["--no-js-runtimes"]);
    expect(jsRuntimeArgs(undefined, "/x/node-shim")).toEqual(["--no-js-runtimes"]);
  });
});

describe("verifyNodeShim", () => {
  it("accepts a runtime that runs the stdin script under the permission model", async () => {
    const exec = fakeExec({ code: 0, stdout: "v24.22.0\n", stderr: "" }, { code: 0, stdout: "42\n", stderr: "" });
    expect(await verifyNodeShim("/shim", {}, exec)).toEqual({ kind: "node", version: "24.22.0" });
    expect(exec.calls[1]).toEqual({ args: ["--permission", "-"], input: "console.log(6 * 7);\n" });
  });

  it("refuses an old node, a missing version, stderr noise and a wrong answer", async () => {
    expect((await verifyNodeShim("/shim", {}, fakeExec({ code: 0, stdout: "v20.11.0", stderr: "" }))).kind).toBe("none");
    expect(await verifyNodeShim("/shim", {}, fakeExec({ code: 127, stdout: "", stderr: "not found" }))).toMatchObject({ kind: "none", error: expect.stringContaining("not found") });
    expect(await verifyNodeShim("/shim", {}, fakeExec({ code: 0, stdout: "v24.1.0", stderr: "" }, { code: 0, stdout: "42", stderr: "ExperimentalWarning" }))).toMatchObject({ kind: "none" });
    expect(await verifyNodeShim("/shim", {}, fakeExec({ code: 0, stdout: "v24.1.0", stderr: "" }, { code: 9, stdout: "", stderr: "bad option: --permission" }))).toMatchObject({ kind: "none", error: expect.stringContaining("bad option") });
  });

  // The real thing: the Electron this app ships, in Node mode, the way yt-dlp starts it.
  const electron = resolve(__dirname, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const hoisted = resolve(__dirname, "../../../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const binary = existsSync(electron) ? electron : existsSync(hoisted) ? hoisted : null;
  it.skipIf(process.platform !== "darwin" || !binary)("passes with the bundled Electron's Node", async () => {
    const dir = await scratch();
    const shim = join(dir, "node-shim");
    await writeShim(shim, binary!);
    const status = await verifyNodeShim(shim, { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir });
    expect(status.kind).toBe("node");
  }, 30_000);
});
