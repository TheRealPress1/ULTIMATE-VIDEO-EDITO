/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { EarshotWorker, WorkerCrashed, WorkerTimeout, stdioConnect } from "./worker";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkerConnection } from "./worker";

/** A server that answers every call with its name, and can be made to die. */
class FakeServer implements WorkerConnection {
  static started: FakeServer[] = [];
  closed = false;
  killed = false;
  calls: Array<{ name: string; args: Record<string, unknown>; timeout: number }> = [];
  pending: Array<{ name: string; resolve: (result: CallToolResult) => void; reject: (error: Error) => void }> = [];
  hang = false;
  /** Answers every call as the SDK does when its time is up. */
  slow = false;
  onclose?: () => void;

  constructor() {
    FakeServer.started.push(this);
  }

  async callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeout: number }): Promise<CallToolResult> {
    this.calls.push({ name, args, timeout: options.timeout });
    if (this.slow) throw new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: options.timeout });
    if (this.hang) {
      return new Promise<CallToolResult>((resolve, reject) => {
        this.pending.push({ name, resolve, reject });
        options.signal?.addEventListener("abort", () => reject(options.signal!.reason));
      });
    }
    return { content: [{ type: "text", text: `${name} ok` }] };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  kill(): void {
    this.killed = true;
    this.onclose?.();
    for (const call of this.pending.splice(0)) call.reject(new Error("MCP error -32000: Connection closed"));
  }

  /** The calls it is working on finish. */
  finish(): void {
    for (const call of this.pending.splice(0)) call.resolve({ content: [{ type: "text", text: `${call.name} ok` }] });
  }

  stderrTail(): string {
    return "earshot mcp 0.4.0: serving 16 tools on stdio (threads=4)\nMemoryError: out of memory";
  }

  /** The process dies by itself: pending calls fail as the SDK fails them. */
  crash(): void {
    this.onclose?.();
    for (const call of this.pending.splice(0)) call.reject(new Error("MCP error -32000: Connection closed"));
  }
}

let clock = 0;
const worker = (options: Partial<ConstructorParameters<typeof EarshotWorker>[0]> = {}) =>
  new EarshotWorker({ connect: async () => new FakeServer(), now: () => clock, log: () => {}, ...options });

afterEach(() => {
  FakeServer.started = [];
  clock = 0;
  vi.useRealTimers();
});

describe("EarshotWorker", () => {
  it("starts one server on the first call and keeps it warm for the next ones", async () => {
    const w = worker();
    expect(w.running).toBe(false);
    const first = await w.call("describe", { path: "/a.wav" }, { timeoutMs: 1234 });
    expect(first.content).toEqual([{ type: "text", text: "describe ok" }]);
    await w.call("match", { path: "/a.wav", query: "a whoosh" }, { timeoutMs: 99 });
    expect(FakeServer.started).toHaveLength(1);
    expect(FakeServer.started[0]!.calls.map((call) => [call.name, call.timeout])).toEqual([["describe", 1234], ["match", 99]]);
    w.dispose();
  });

  it("stops after the idle time to free the RAM, and starts again on the next call", async () => {
    vi.useFakeTimers();
    const w = worker({ idleMs: 15 * 60 * 1000 });
    await w.call("describe", {}, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(FakeServer.started[0]!.closed).toBe(false);
    await w.call("describe", {}, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(FakeServer.started[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 1000 + 10);
    expect(FakeServer.started[0]!.closed).toBe(true);
    expect(w.running).toBe(false);
    await w.call("describe", {}, { timeoutMs: 1000 });
    expect(FakeServer.started).toHaveLength(2);
    w.dispose();
  });

  it("never idles out while a call runs", async () => {
    vi.useFakeTimers();
    const w = worker({ idleMs: 1000, connect: async () => Object.assign(new FakeServer(), { hang: true }) });
    const call = w.call("timeline", {}, { timeoutMs: 60_000 }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeServer.started[0]!.closed).toBe(false);
    FakeServer.started[0]!.crash();
    await call;
    w.dispose();
  });

  it("fails a call the server died in with what it last said, and restarts on the next", async () => {
    const w = worker({ connect: async () => { const first = FakeServer.started.length === 0; return Object.assign(new FakeServer(), { hang: first }); } });
    const call = w.call("timeline", {}, { timeoutMs: 60_000 });
    await vi.waitFor(() => expect(FakeServer.started[0]?.pending).toHaveLength(1));
    FakeServer.started[0]!.crash();
    const error = await call.catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(WorkerCrashed);
    expect((error as Error).message).toBe("The sound analysis worker stopped while working (MemoryError: out of memory). Call the tool again; for a long file, try a shorter start/end window.");
    expect(w.running).toBe(false);
    const again = await w.call("describe", {}, { timeoutMs: 1000 });
    expect(again.content[0]).toEqual({ type: "text", text: "describe ok" });
    expect(FakeServer.started).toHaveLength(2);
    w.dispose();
  });

  it("restarts at most twice in ten minutes after crashes, then again once the window has passed", async () => {
    const w = worker();
    for (let crash = 0; crash < 3; crash++) {
      await w.call("describe", {}, { timeoutMs: 1000 });
      FakeServer.started.at(-1)!.crash();
      clock += 60 * 1000;
    }
    expect(FakeServer.started).toHaveLength(3);
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).rejects.toThrow(/stopped unexpectedly 3 times in 10 minutes \(MemoryError: out of memory\), so it isn't being restarted for now/);
    expect(FakeServer.started).toHaveLength(3);
    clock += 10 * 60 * 1000;
    await w.call("describe", {}, { timeoutMs: 1000 });
    expect(FakeServer.started).toHaveLength(4);
    w.dispose();
  });

  it("counts a server that never started as a crash and reports why", async () => {
    let attempts = 0;
    const w = worker({
      connect: async () => {
        attempts++;
        throw new WorkerCrashed("The sound analysis worker didn't start (ModuleNotFoundError: No module named 'mcp').");
      },
    });
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).rejects.toThrow("didn't start (ModuleNotFoundError: No module named 'mcp')");
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).rejects.toThrow("didn't start");
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).rejects.toThrow("didn't start");
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).rejects.toThrow(/isn't being restarted for now/);
    expect(attempts).toBe(3);
    w.dispose();
  });

  it("does not count stopping it (idle, Remove) as a crash", async () => {
    const w = worker();
    for (let round = 0; round < 5; round++) {
      await w.call("describe", {}, { timeoutMs: 1000 });
      await w.stop();
    }
    expect(FakeServer.started).toHaveLength(5);
    w.dispose();
  });

  it("sends calls one at a time, as earshot runs them; one canceled while it waits never reaches earshot", async () => {
    const w = worker({ connect: async () => Object.assign(new FakeServer(), { hang: true }) });
    const first = w.call("timeline", {}, { timeoutMs: 60_000 });
    await vi.waitFor(() => expect(FakeServer.started[0]?.pending).toHaveLength(1));
    const controller = new AbortController();
    const waiting = w.call("sfx_render", {}, { signal: controller.signal, timeoutMs: 5000 });
    const next = w.call("describe", {}, { timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeServer.started[0]!.calls.map((call) => call.name)).toEqual(["timeline"]);
    controller.abort(new Error("canceled while waiting"));
    await expect(waiting).rejects.toThrow("canceled while waiting");
    expect(FakeServer.started[0]!.killed).toBe(false);
    FakeServer.started[0]!.finish();
    await expect(first).resolves.toMatchObject({ content: [{ text: "timeline ok" }] });
    // The next one goes once the first is done, with its own time limit from then on.
    await vi.waitFor(() => expect(FakeServer.started[0]!.calls.map((call) => [call.name, call.timeout])).toEqual([["timeline", 60_000], ["describe", 1000]]));
    FakeServer.started[0]!.finish();
    await next;
    expect(FakeServer.started).toHaveLength(1);
    w.dispose();
  });

  it("ends earshot when a call it runs is canceled, so the next call doesn't wait it out; that isn't a crash", async () => {
    const w = worker({ connect: async () => Object.assign(new FakeServer(), { hang: true }) });
    for (let round = 0; round < 4; round++) {
      const controller = new AbortController();
      const call = w.call("rank", {}, { signal: controller.signal, timeoutMs: 60_000 });
      await vi.waitFor(() => expect(FakeServer.started[round]?.pending).toHaveLength(1));
      controller.abort(new Error("canceled by the caller"));
      await expect(call).rejects.toThrow("canceled by the caller");
      expect(FakeServer.started[round]!.killed).toBe(true);
      expect(w.running).toBe(false);
    }
    // Four fresh starts, none refused as too many restarts.
    expect(FakeServer.started).toHaveLength(4);
    w.dispose();
  });

  it("ends earshot when a call times out, and says it was the time", async () => {
    const w = worker({ connect: async () => { const first = FakeServer.started.length === 0; return Object.assign(new FakeServer(), { slow: first }); } });
    const error = await w.call("timeline", {}, { timeoutMs: 60 * 60 * 1000 }).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(WorkerTimeout);
    expect((error as Error).message).toBe("earshot's timeline took longer than 60 min.");
    expect(FakeServer.started[0]!.killed).toBe(true);
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).resolves.toMatchObject({ content: [{ text: "describe ok" }] });
    expect(FakeServer.started).toHaveLength(2);
    w.dispose();
  });

  it("kills a busy earshot at once when the app quits", async () => {
    const w = worker({ connect: async () => Object.assign(new FakeServer(), { hang: true }) });
    const call = w.call("timeline", {}, { timeoutMs: 60_000 }).catch((error: Error) => error);
    await vi.waitFor(() => expect(FakeServer.started[0]?.pending).toHaveLength(1));
    w.dispose();
    // Synchronously: the app is gone before close() would signal it.
    expect(FakeServer.started[0]!.killed).toBe(true);
    await call;
  });

  it("starts the restart count over after Remove, so a reinstall can run it", async () => {
    const w = worker();
    for (let crash = 0; crash < 3; crash++) {
      await w.call("describe", {}, { timeoutMs: 1000 });
      FakeServer.started.at(-1)!.crash();
    }
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).rejects.toThrow(/isn't being restarted for now\. Try again in a few minutes, or reinstall audio intelligence in Cutroom's Settings \(Remove, then Install now\)\./);
    await w.stop();
    w.forgetCrashes();
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).resolves.toMatchObject({ content: [{ text: "describe ok" }] });
    w.dispose();
  });

  it("passes the call's signal on, and starts nothing once disposed", async () => {
    const w = worker({ connect: async () => Object.assign(new FakeServer(), { hang: true }) });
    const controller = new AbortController();
    const call = w.call("rank", {}, { signal: controller.signal, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(FakeServer.started[0]?.pending).toHaveLength(1));
    controller.abort(new Error("canceled by the caller"));
    await expect(call).rejects.toThrow("canceled by the caller");
    w.dispose();
    await vi.waitFor(() => expect(FakeServer.started[0]!.closed).toBe(true));
    await expect(w.call("describe", {}, { timeoutMs: 1000 })).rejects.toThrow("Cutroom is quitting.");
  });
});

/**
 * A stand-in for `python -m earshot mcp` as a real child process: MCP over
 * stdio, one JSON message a line. `pid` answers with its process id; `busy`
 * never answers and keeps the process going whatever happens to its stdin,
 * as earshot does while a tool holds its lock, and it shrugs off SIGTERM, so
 * only a kill ends it.
 */
const FAKE_SERVER = String.raw`
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
process.stderr.write("earshot mcp 0.4.0: serving 16 tools on stdio (threads=1)\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "earshot", version: "0.4.0" } } });
  } else if (message.method === "tools/call") {
    if (message.params.name === "busy") { setInterval(() => {}, 1000); return; }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(process.pid) }] } });
  }
});
`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("EarshotWorker over a real process", () => {
  it("kills a busy server when its call is canceled or times out, and the next call gets a fresh one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "earshot-worker-"));
    const seen: number[] = [];
    try {
      const script = join(dir, "server.cjs");
      await writeFile(script, FAKE_SERVER);
      const w = new EarshotWorker({ connect: stdioConnect({ command: process.execPath, args: [script], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, cwd: dir, version: "test" }), log: () => {} });
      const pid = async () => {
        const value = Number(((await w.call("pid", {}, { timeoutMs: 10_000 })).content[0] as { text: string }).text);
        seen.push(value);
        return value;
      };

      const first = await pid();
      expect(alive(first)).toBe(true);

      // Canceled while earshot works on it: the process ends right away (the SDK's own close would wait seconds, then only signal it).
      const controller = new AbortController();
      const canceled = w.call("busy", {}, { signal: controller.signal, timeoutMs: 60_000 });
      setTimeout(() => controller.abort(new Error("canceled by the agent")), 100);
      await expect(canceled).rejects.toThrow("canceled by the agent");
      await vi.waitFor(() => expect(alive(first)).toBe(false), { timeout: 1000, interval: 20 });

      const second = await pid();
      expect(second).not.toBe(first);

      // Out of time: the same, reported as a timeout.
      await expect(w.call("busy", {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(WorkerTimeout);
      await vi.waitFor(() => expect(alive(second)).toBe(false), { timeout: 1000, interval: 20 });

      const third = await pid();
      expect([first, second]).not.toContain(third);

      // Quitting kills it at once too.
      const busy = w.call("busy", {}, { timeoutMs: 60_000 }).catch((error: Error) => error);
      await new Promise((resolve) => setTimeout(resolve, 100));
      w.dispose();
      await vi.waitFor(() => expect(alive(third)).toBe(false), { timeout: 1000, interval: 20 });
      await busy;
    } finally {
      // Whatever the outcome, no stand-in outlives the test.
      for (const value of seen) if (alive(value)) process.kill(value, "SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
