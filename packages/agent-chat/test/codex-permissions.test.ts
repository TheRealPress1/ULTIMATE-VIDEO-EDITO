/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexHarness } from "../src/host/codex";
import { emptyTranscript, reduce } from "../src/reduce";

import type { ChildProcess } from "node:child_process";
import type { HarnessSession, OpenOptions } from "../src/host/harness";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("../src/host/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/host/env")>(),
  resolveBinary: () => "/test/codex",
  needsShell: () => false,
  killTree: async () => {},
}));

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function start(resume?: OpenOptions["resume"], mcpName = "cutroom") {
  const calls: Message[] = [];
  const stdout = new PassThrough();
  const receive = (message: Message) => stdout.write(`${JSON.stringify(message)}\n`);
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString()) as Message;
      calls.push(message);
      if (message.id !== undefined && message.method) {
        const result = message.method === "config/read" ? { config: { mcp_servers: { compound: {}, node_repl: {}, cutroom: {} } } } :
          message.method.startsWith("thread/") ? { thread: { id: "thread-1" } } :
          message.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
        queueMicrotask(() => receive({ id: message.id, result }));
      }
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), { stdin, stdout }) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  let transcript = emptyTranscript();
  const session: HarnessSession = await new CodexHarness().open({
    cwd: "/project", model: "test-model", resume,
    mcp: { name: mcpName, url: "http://127.0.0.1:43127/mcp" },
    env: { env: { PATH: "/test", HOME: "/existing/home" }, extraDirs: [] }, emit: () => {},
  });
  const turn = session.send("Edit this project", "test-model", (event) => { transcript = reduce(transcript, event); });
  await Promise.resolve();
  cleanup.push(async () => {
    receive({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await turn;
    await session.close();
    stdout.destroy();
  });
  let nextId = 100;
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    receive({ id, method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
    return id;
  };
  const response = async (id: number) => {
    await vi.waitFor(() => expect(calls.some((call) => call.id === id && !call.method)).toBe(true));
    return calls.find((call) => call.id === id && !call.method)!.result;
  };
  const allow = () => {
    const pending = transcript.pending!;
    session.respond(pending.id, { answers: { [pending.questions[0]!.id]: ["Allow once"] } });
  };
  return { calls, receive, request, response, session, allow, pending: () => transcript.pending!, items: () => transcript.items };
}

describe("Codex project permissions", () => {
  it.each([false, true])("sets project sandbox and approval policy, including resumed threads (%s)", async (resumed) => {
    const { calls } = await start(resumed ? { codex: { threadId: "thread-1" } } : undefined);
    expect(calls.find((call) => call.method === (resumed ? "thread/resume" : "thread/start"))?.params).toMatchObject({
      cwd: "/project", sandbox: "workspace-write", approvalPolicy: "on-request",
      config: {
        "mcp_servers.compound.enabled": false,
        "mcp_servers.node_repl.enabled": false,
        "features.apps": false,
        "features.plugins": false,
        "features.computer_use": false,
      },
    });
    expect(calls.find((call) => call.method === "config/read")?.params).toEqual({ cwd: "/project", includeLayers: false });
    expect(calls.some((call) => call.method?.startsWith("config/") && call.method !== "config/read")).toBe(false);
    expect(calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    });
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      'mcp_servers.cutroom.url="http://127.0.0.1:43127/mcp"',
      "mcp_servers.cutroom.enabled=true",
      "mcp_servers.cutroom.required=true",
      "mcp_servers.cutroom.tool_timeout_sec=14400",
    ]));
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ env: { HOME: "/existing/home" }, shell: false });
  });

  it("injects a different valid MCP name without creating quoted key segments", async () => {
    const { calls } = await start(undefined, "editor-tools");
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('mcp_servers.editor-tools.url="http://127.0.0.1:43127/mcp"');
    expect(calls.find((call) => call.method === "thread/start")?.params?.config).toMatchObject({ "mcp_servers.cutroom.enabled": false });
  });

  it("rejects an MCP name that would change the override path", async () => {
    await expect(start(undefined, "editor.tools")).rejects.toThrow("Invalid MCP server name");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reviews native MCP confirmations and supplies the elicitation response shape", async () => {
    const { receive, request, calls, response, pending, allow } = await start();
    receive({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {
      id: "capture-1", type: "mcpToolCall", server: "cutroom", tool: "capture",
      arguments: { id: "smoke", output: "/project/cache/verification" },
    } } });
    const id = request("mcpServer/elicitation/request", {
      serverName: "cutroom", mode: "form", message: "Allow capture to write these images?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { tool_description: "INTERNAL LONG DOCUMENTATION", persist: true, tool_params: { id: "smoke", output: "/project/cache/verification" } },
    });
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending().questions[0]?.question).toContain("Allow capture to write these images?");
    expect(pending().questions[0]?.question).toContain("/project/cache/verification");
    expect(pending().questions[0]?.question).not.toContain("INTERNAL LONG DOCUMENTATION");
    expect(pending().questions[0]?.question).not.toContain("thread-1");
    expect(calls.some((call) => call.id === id)).toBe(false);
    allow();
    await expect(response(id)).resolves.toEqual({ action: "accept", content: {}, _meta: null });
  });

  it('automatically approves an exact current local editor call without a card', async () => {
    const { receive, request, response, pending } = await start();
    receive({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
      id: 'check-1', type: 'mcpToolCall', server: 'cutroom', tool: 'check', arguments: { id: 'scene' },
    } } });
    const id = request('mcpServer/elicitation/request', {
      serverName: 'cutroom', mode: 'form', requestedSchema: { type: 'object', properties: {} },
      _meta: { tool_params: { id: 'scene' } },
    });
    await expect(response(id)).resolves.toEqual({ action: 'accept', content: {}, _meta: null });
    expect(pending()).toBeNull();
  });

  it.each(['ambiguous', 'different arguments', 'uncorrelated turn', 'other server'])('keeps the approval card for %s MCP confirmation', async (reason) => {
    const { receive, request, response, pending, session } = await start();
    const server = reason === 'other server' ? 'untrusted' : 'cutroom';
    const item = { id: 'check-1', type: 'mcpToolCall', server, tool: 'check', arguments: { id: 'scene' } };
    receive({ method: 'item/started', params: { item } });
    if (reason === 'ambiguous') receive({ method: 'item/started', params: { item: { ...item, id: 'check-2' } } });
    const id = request('mcpServer/elicitation/request', {
      ...(reason === 'uncorrelated turn' ? { turnId: null } : {}), serverName: server, mode: 'form',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { tool_params: { id: reason === 'different arguments' ? 'other' : 'scene' } },
    });
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    session.respond(pending().id, 'skip');
    await expect(response(id)).resolves.toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('cancels a valid automatic MCP decision if the item completes during validation', async () => {
    const { receive, request, response, pending } = await start();
    const item = { id: 'check-1', type: 'mcpToolCall', server: 'cutroom', tool: 'check', arguments: {} };
    receive({ method: 'item/started', params: { item } });
    const id = request('mcpServer/elicitation/request', { serverName: 'cutroom', mode: 'form',
      requestedSchema: { type: 'object', properties: {} }, _meta: { tool_params: {} },
    });
    receive({ method: 'item/completed', params: { item } });
    await expect(response(id)).resolves.toEqual({ action: 'cancel', content: null, _meta: null });
    expect(pending()).toBeNull();
  });

  it("handles MCP confirmations without a correlated turn and denies skipped cards", async () => {
    const { request, response, pending, session } = await start();
    const id = request("mcpServer/elicitation/request", {
      turnId: null, serverName: "cutroom", mode: "form", message: "Allow context?",
      requestedSchema: { type: "object", properties: {}, required: [] },
    });
    expect(pending().questions[0]?.question).toContain("Allow context?");
    session.respond(pending().id, "skip");
    await expect(response(id)).resolves.toEqual({ action: "decline", content: null, _meta: null });
  });

  it("cancels resolved and stale MCP confirmations without granting access", async () => {
    const { request, receive, response, pending } = await start();
    const params = { serverName: "cutroom", mode: "form", requestedSchema: { type: "object", properties: {} } };
    const id = request("mcpServer/elicitation/request", params);
    expect(pending()).not.toBeNull();
    receive({ method: "serverRequest/resolved", params: { requestId: id } });
    await expect(response(id)).resolves.toEqual({ action: "cancel", content: null, _meta: null });
    expect(pending()).toBeNull();
    const stale = request("mcpServer/elicitation/request", { ...params, threadId: "other-thread" });
    await expect(response(stale)).resolves.toEqual({ action: "cancel", content: null, _meta: null });
    expect(pending()).toBeNull();
  });

  it.each([
    { mode: "url", url: "https://example.com/authorize" },
    { mode: "form", requestedSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } },
    { mode: "openai/form", requestedSchema: {} },
  ])("explains unsupported MCP elicitation instead of inventing input: $mode", async (params) => {
    const { request, response, pending, items } = await start();
    const id = request("mcpServer/elicitation/request", { ...params, serverName: "cutroom", message: "Confirm access" });
    await expect(response(id)).resolves.toEqual({ action: "decline", content: null, _meta: null });
    expect(pending()).toBeNull();
    expect(items()).toContainEqual(expect.objectContaining({ kind: "notice", level: "error", text: expect.stringContaining("This chat cannot complete") }));
  });

  it("does not execute a command approval until the user chooses Allow once", async () => {
    const { request, calls, response, pending, allow } = await start();
    const id = request("item/commandExecution/requestApproval", { command: "ffmpeg -i source.mp4 /outside/final.mp4", cwd: "/project" });
    expect(pending().questions[0]?.question).toContain("/outside/final.mp4");
    expect(calls.some((call) => call.id === id)).toBe(false);
    allow();
    await expect(response(id)).resolves.toEqual({ decision: "accept" });
  });

  it("denies skipped requests and rejects stale thread or turn approvals", async () => {
    const { request, response, pending, session } = await start();
    const id = request("item/fileChange/requestApproval", { grantRoot: "/outside" });
    session.respond(pending().id, "skip");
    await expect(response(id)).resolves.toEqual({ decision: "decline" });
    const wrongThread = request("item/fileChange/requestApproval", { threadId: "another-thread" });
    const oldTurn = request("item/fileChange/requestApproval", { turnId: "old-turn" });
    await expect(response(wrongThread)).resolves.toEqual({ decision: "cancel" });
    await expect(response(oldTurn)).resolves.toEqual({ decision: "cancel" });
    expect(pending()).toBeNull();
  });

  it("shows the proposed file changes with their approval", async () => {
    const { request, response, pending, receive, allow } = await start();
    const diff = "-export const title = 'Before';\n+export const title = 'After';";
    receive({ method: "item/started", params: { item: { id: "file-edit", type: "fileChange", changes: [{ path: "/outside/title.tsx", diff }] } } });
    const id = request("item/fileChange/requestApproval", { itemId: "file-edit", grantRoot: "/outside" });
    expect(pending().questions[0]?.question).toContain("Before");
    expect(pending().questions[0]?.question).toContain("After");
    allow();
    await expect(response(id)).resolves.toEqual({ decision: "accept" });
  });

  it("grants only the permissions shown and only for the active turn", async () => {
    const { request, response, pending, allow } = await start();
    const permissions = { network: null, fileSystem: { write: ["/outside/render"] } };
    const id = request("item/permissions/requestApproval", { permissions });
    expect(pending().questions[0]?.question).toContain("for the current turn");
    allow();
    await expect(response(id)).resolves.toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: "turn" });
  });

  it("withdraws a resolved request without granting or dismissing the next queued request", async () => {
    const { request, response, pending, receive, allow } = await start();
    const first = request("item/fileChange/requestApproval", { grantRoot: "/one" });
    const second = request("item/fileChange/requestApproval", { grantRoot: "/two" });
    expect(pending().questions[0]?.question).toContain("/one");
    receive({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: first } });
    await expect(response(first)).resolves.toEqual({ decision: "cancel" });
    expect(pending().questions[0]?.question).toContain("/two");
    allow();
    await expect(response(second)).resolves.toEqual({ decision: "accept" });
  });
});
