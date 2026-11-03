/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// earshot's own MCP server (`python -m earshot mcp`, stdio), run by main as
// a warm worker: started on the first call, kept while calls keep coming so
// the models stay loaded, stopped after 15 idle minutes to give the RAM back,
// restarted when it dies (twice in ten minutes at most) and killed on quit.
// Calls go to it one at a time, as earshot runs them anyway. earshot can't
// stop a tool it has started, so a call canceled or timed out while it runs
// ends the process instead, and the next call starts a fresh one. Only main
// talks to it; agents reach it through Cutroom's sound tools.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One running server. */
export type WorkerConnection = {
  callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeout: number }): Promise<CallToolResult>;
  close(): Promise<void>;
  /** Ends the process at once, whatever it is doing, without waiting for anything. */
  kill(): void;
  /** The last lines the server wrote to stderr. */
  stderrTail(): string;
  /** Set by the worker: called once the process is gone, however it went. */
  onclose?: () => void;
};

export type Connect = () => Promise<WorkerConnection>;

export type WorkerOptions = {
  connect: Connect;
  /** Stopped after this long without a call (default 15 min). */
  idleMs?: number;
  /** Restarts allowed after unexpected exits within `restartWindowMs` (default 2 in 10 min). */
  maxRestarts?: number;
  restartWindowMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export const IDLE_MS = 15 * 60 * 1000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 2;
/** The handshake: the server answers within seconds, longer on a cold disk. */
const CONNECT_MS = 120 * 1000;

export class WorkerCrashed extends Error {}

/** A call earshot was still running when its time was up; the process running it was ended. */
export class WorkerTimeout extends Error {}

/** The server as a child process of main, by `@modelcontextprotocol/sdk` over stdio. */
export function stdioConnect(options: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; version: string; log?: (line: string) => void }): Connect {
  return async () => {
    const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({ command: options.command, args: options.args, env, cwd: options.cwd, stderr: "pipe" });
    let tail = "";
    transport.stderr?.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-8000);
      for (const line of text.split(/\r?\n/)) if (/^earshot mcp/.test(line)) options.log?.(line.trim());
    });
    const client = new Client({ name: "cutroom", version: options.version }, { capabilities: {} });
    const connection: WorkerConnection = {
      callTool: async (name, args, { signal, timeout }) =>
        (await client.callTool({ name, arguments: args }, undefined, { signal, timeout, maxTotalTimeout: timeout })) as CallToolResult,
      close: () => client.close(),
      // The SDK's close() only ends stdin, which a busy earshot reads once its tool returns, and signals it seconds later on timers that don't outlive the app.
      kill: () => {
        const pid = transport.pid;
        if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone already */ }
      },
      stderrTail: () => tail,
    };
    client.onclose = () => connection.onclose?.();
    try {
      await client.connect(transport, { timeout: CONNECT_MS });
    } catch (error) {
      await client.close().catch(() => {});
      const last = tail.trim().split(/\r?\n/).at(-1);
      throw new WorkerCrashed(`The sound analysis worker didn't start${last ? ` (${last.slice(0, 240)})` : ""}.`, { cause: error });
    }
    return connection;
  };
}

/** Whether the SDK gave up on a request because its time was up. */
function timedOut(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === ErrorCode.RequestTimeout;
}

export class EarshotWorker {
  private readonly connect: Connect;
  private readonly idleMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private connection: Promise<WorkerConnection> | null = null;
  /** The connection once it is up, for what has to happen at once (quitting). */
  private live: WorkerConnection | null = null;
  /** Settles when the call ahead is done: calls go to earshot one at a time. */
  private line: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** When the server went away without being asked to. */
  private crashes: number[] = [];
  /** When it was started again after one of those. */
  private restarts: number[] = [];
  private crashedSinceStart = false;
  private disposed = false;
  private lastTail = "";

  constructor(options: WorkerOptions) {
    this.connect = options.connect;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.maxRestarts = options.maxRestarts ?? MAX_RESTARTS;
    this.restartWindowMs = options.restartWindowMs ?? RESTART_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.info(`[earshot] ${line}`));
  }

  /** Whether a server is running (or starting). */
  get running(): boolean {
    return this.connection !== null;
  }

  /**
   * Calls one of earshot's tools, starting the server when none runs. Waits
   * for the calls ahead first; `timeoutMs` counts from when earshot gets it.
   */
  async call(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<CallToolResult> {
    if (this.disposed) throw new Error("Cutroom is quitting.");
    options.signal?.throwIfAborted();
    this.inFlight++;
    this.clearIdle();
    try {
      const done = await this.turn(options.signal);
      try {
        return await this.send(name, args, options);
      } finally {
        done();
      }
    } finally {
      this.inFlight--;
      this.armIdle();
    }
  }

  /** Resolves, with what ends the turn, once the calls ahead are done; a call canceled while it waits leaves the line, never having reached earshot. */
  private turn(signal?: AbortSignal): Promise<() => void> {
    let done!: () => void;
    const mine = new Promise<void>((resolve) => (done = resolve));
    const ahead = this.line;
    this.line = ahead.then(() => mine);
    return new Promise((resolve, reject) => {
      const onAbort = () => { done(); reject(signal!.reason); };
      signal?.addEventListener("abort", onAbort, { once: true });
      void ahead.then(() => {
        signal?.removeEventListener("abort", onAbort);
        if (!signal?.aborted) resolve(done);
      });
    });
  }

  private async send(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<CallToolResult> {
    const pending = this.started();
    const connection = await pending;
    options.signal?.throwIfAborted();
    try {
      return await connection.callTool(name, args, { signal: options.signal, timeout: options.timeoutMs });
    } catch (error) {
      const timeout = !options.signal?.aborted && timedOut(error);
      if (options.signal?.aborted || timeout) {
        // Left alone, earshot would keep working on it (minutes, on four threads) and the next call would wait it out.
        this.abandon(pending, connection);
        if (timeout) throw new WorkerTimeout(`earshot's ${name} took longer than ${Math.round(options.timeoutMs / 60_000) || 1} min.`, { cause: error });
        throw error;
      }
      if (this.connection === null || this.crashedSinceStart) {
        const last = (connection.stderrTail() || this.lastTail).trim().split(/\r?\n/).at(-1);
        throw new WorkerCrashed(`The sound analysis worker stopped while working${last ? ` (${last.slice(0, 240)})` : ""}. Call the tool again; for a long file, try a shorter start/end window.`, { cause: error });
      }
      throw error;
    }
  }

  private started(): Promise<WorkerConnection> {
    if (this.connection) return this.connection;
    const now = this.now();
    this.crashes = this.crashes.filter((at) => now - at < this.restartWindowMs);
    this.restarts = this.restarts.filter((at) => now - at < this.restartWindowMs);
    const restart = this.crashes.length > 0;
    if (restart && this.restarts.length >= this.maxRestarts) {
      const last = this.lastTail.trim().split(/\r?\n/).at(-1);
      return Promise.reject(new WorkerCrashed(
        `The sound analysis worker stopped unexpectedly ${this.crashes.length} times in ${Math.round(this.restartWindowMs / 60_000)} minutes${last ? ` (${last.slice(0, 240)})` : ""}, so it isn't being restarted for now. Try again in a few minutes, or reinstall audio intelligence in Cutroom's Settings (Remove, then Install now).`,
      ));
    }
    if (restart) this.restarts.push(now);
    this.crashedSinceStart = false;
    const pending: Promise<WorkerConnection> = this.connect().then((connection) => {
      connection.onclose = () => this.closed(pending, connection);
      if (this.connection === pending) this.live = connection;
      return connection;
    });
    this.connection = pending;
    pending.catch(() => {
      if (this.connection !== pending) return;
      this.connection = null;
      this.crashes.push(this.now());
    });
    if (restart) this.log("restarting the worker after an unexpected exit");
    return pending;
  }

  /** The server went away: asked to (stop), or not (a crash). */
  private closed(which: Promise<WorkerConnection>, connection: WorkerConnection): void {
    if (this.connection !== which) return;
    this.connection = null;
    this.live = null;
    this.lastTail = connection.stderrTail();
    this.crashedSinceStart = true;
    this.crashes.push(this.now());
    this.log("the worker exited unexpectedly");
  }

  /** Ends a server busy with a call nobody waits for any more. Not a crash: the next call starts a fresh one. */
  private abandon(pending: Promise<WorkerConnection>, connection: WorkerConnection): void {
    if (this.connection === pending) {
      this.connection = null;
      this.live = null;
    }
    connection.onclose = undefined;
    connection.kill();
    void connection.close().catch(() => {});
    this.log("ended the worker: a call it was running was canceled or timed out");
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.inFlight > 0 || !this.connection || this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight === 0) void this.stop().then(() => this.log("stopped the idle worker"));
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Stops the server; the next call starts a new one. In-flight calls fail. */
  async stop(): Promise<void> {
    this.clearIdle();
    const pending = this.connection;
    this.connection = null;
    this.live = null;
    if (!pending) return;
    const connection = await pending.catch(() => null);
    if (connection) {
      connection.onclose = undefined;
      await connection.close().catch(() => {});
    }
  }

  /** Starts the restart count over: Remove (and so a reinstall) is a fresh start. */
  forgetCrashes(): void {
    this.crashes = [];
    this.restarts = [];
    this.lastTail = "";
    this.crashedSinceStart = false;
  }

  /** The app is quitting: the process ends now (the app is gone before a graceful stop would get to it), and nothing more starts. */
  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    const live = this.live;
    if (live) {
      live.onclose = undefined;
      live.kill();
    }
    void this.stop();
  }
}
