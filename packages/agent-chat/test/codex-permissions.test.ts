/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.mocked(console.info).mockRestore();
});

async function start(resume?: OpenOptions["resume"], mcpName = "cutroom", cwd = "/project") {
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
    cwd, model: "test-model", resume,
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
  return { calls, receive, request, response, session, pending: () => transcript.pending, items: () => transcript.items };
}

describe("Codex automatic permissions", () => {
  it.each([false, true])("never asks for approval and keeps the sandbox offline, including resumed threads (%s)", async (resumed) => {
    const { calls } = await start(resumed ? { codex: { threadId: "thread-1" } } : undefined);
    expect(calls.find((call) => call.method === (resumed ? "thread/resume" : "thread/start"))?.params).toMatchObject({
      cwd: "/project", sandbox: "workspace-write", approvalPolicy: "never",
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
      approvalPolicy: "never",
      // Workspace-write reads the whole disk, credential stores included: no network to send them anywhere.
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    });
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      'mcp_servers.cutroom.url="http://127.0.0.1:43127/mcp"',
      "mcp_servers.cutroom.enabled=true",
      "mcp_servers.cutroom.required=true",
      "mcp_servers.cutroom.tool_timeout_sec=14400",
      'mcp_servers.cutroom.default_tools_approval_mode="approve"',
    ]));
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ env: { HOME: "/existing/home" }, shell: false });
  });

  it("injects a different valid MCP name without creating quoted key segments", async () => {
    const { calls } = await start(undefined, "editor-tools");
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('mcp_servers.editor-tools.url="http://127.0.0.1:43127/mcp"');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('mcp_servers.editor-tools.default_tools_approval_mode="approve"');
    expect(calls.find((call) => call.method === "thread/start")?.params?.config).toMatchObject({ "mcp_servers.cutroom.enabled": false });
  });

  it("rejects an MCP name that would change the override path", async () => {
    await expect(start(undefined, "editor.tools")).rejects.toThrow("Invalid MCP server name");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["an uncorrelated confirmation", { turnId: null, mode: "form", requestedSchema: { type: "object", properties: {}, required: [] } }],
    ["a tool-call confirmation", { mode: "form", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { model: "flux-2-klein" } } }],
    ["a confirmation with optional fields", { mode: "form", requestedSchema: { type: "object", properties: { persist: { type: "boolean" } } } }],
  ])("accepts %s from the cutroom server without a card", async (_name, params) => {
    const { request, response, pending } = await start();
    const id = request("mcpServer/elicitation/request", { serverName: "cutroom", message: "Allow generate?", ...params });
    await expect(response(id)).resolves.toEqual({ action: "accept", content: {}, _meta: null });
    expect(pending()).toBeNull();
  });

  it("declines confirmations from other servers without a card", async () => {
    const { request, response, pending, items } = await start();
    const id = request("mcpServer/elicitation/request", {
      serverName: "untrusted", mode: "form", requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call" },
    });
    await expect(response(id)).resolves.toEqual({ action: "decline", content: null, _meta: null });
    expect(pending()).toBeNull();
    expect(items()).toEqual([]);
  });

  it("cancels resolved and stale MCP confirmations without granting access", async () => {
    const { request, response, pending } = await start();
    const params = { serverName: "cutroom", mode: "form", requestedSchema: { type: "object", properties: {} } };
    const stale = request("mcpServer/elicitation/request", { ...params, threadId: "other-thread" });
    await expect(response(stale)).resolves.toEqual({ action: "cancel", content: null, _meta: null });
    const oldTurn = request("mcpServer/elicitation/request", { ...params, turnId: "old-turn" });
    await expect(response(oldTurn)).resolves.toEqual({ action: "cancel", content: null, _meta: null });
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

  it("declines command escalations and cancels stale ones", async () => {
    const { request, response, pending } = await start();
    const id = request("item/commandExecution/requestApproval", { command: "ffmpeg -i source.mp4 /outside/final.mp4", cwd: "/project" });
    await expect(response(id)).resolves.toEqual({ decision: "decline" });
    const wrongThread = request("item/commandExecution/requestApproval", { threadId: "another-thread", command: "ls" });
    await expect(response(wrongThread)).resolves.toEqual({ decision: "cancel" });
    expect(pending()).toBeNull();
  });

  it("accepts project file additions and updates, and declines everything else", async () => {
    const project = await realpath(await mkdtemp(join(tmpdir(), "uve-codex-project-")));
    cleanup.push(() => rm(project, { recursive: true, force: true }));
    await mkdir(join(project, "assets"));
    await writeFile(join(project, "assets", "title.tsx"), "export default 'Title';");
    const { request, response, pending, receive } = await start(undefined, "cutroom", project);
    const cases: [string, unknown[], unknown, string][] = [
      ["in-project", [{ path: join(project, "assets/title.tsx"), kind: "update" }, { path: join(project, "assets/new.tsx"), kind: { type: "add" } }], undefined, "accept"],
      ["granted", [{ path: join(project, "assets/title.tsx"), kind: "update" }], project, "accept"],
      ["outside", [{ path: "/outside/title.tsx", kind: "update" }], undefined, "decline"],
      ["delete", [{ path: join(project, "assets/title.tsx"), kind: "delete" }], undefined, "decline"],
      ["move", [{ path: join(project, "a.tsx"), kind: { type: "update", move_path: join(project, "b.tsx") } }], undefined, "decline"],
      ["protected", [{ path: join(project, ".git/config"), kind: "update" }], undefined, "decline"],
      ["outside grant", [{ path: join(project, "assets/title.tsx"), kind: "update" }], "/outside", "decline"],
      ["empty", [], undefined, "decline"],
    ];
    for (const [id, changes, grantRoot, decision] of cases) {
      receive({ method: "item/started", params: { item: { id, type: "fileChange", changes } } });
      const requestId = request("item/fileChange/requestApproval", { itemId: id, grantRoot });
      await expect(response(requestId), id).resolves.toEqual({ decision });
    }
    const unknown = request("item/fileChange/requestApproval", { itemId: "never-started" });
    await expect(response(unknown)).resolves.toEqual({ decision: "decline" });
    const oldTurn = request("item/fileChange/requestApproval", { turnId: "old-turn" });
    await expect(response(oldTurn)).resolves.toEqual({ decision: "cancel" });
    expect(pending()).toBeNull();
  });

  it("grants neither network nor file system access when Codex asks for more", async () => {
    const { request, response, pending } = await start();
    const network = request("item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
    await expect(response(network)).resolves.toEqual({ permissions: {}, scope: "turn" });
    const both = request("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { write: ["/outside/render"] } } });
    await expect(response(both)).resolves.toEqual({ permissions: {}, scope: "turn" });
    const files = request("item/permissions/requestApproval", { permissions: { network: null, fileSystem: { write: ["/outside/render"] } } });
    await expect(response(files)).resolves.toEqual({ permissions: {}, scope: "turn" });
    expect(pending()).toBeNull();
  });

  it("denies legacy approval callbacks", async () => {
    const { request, response, pending } = await start();
    for (const method of ["execCommandApproval", "applyPatchApproval"]) {
      const id = request(method, { conversationId: "thread-1", callId: "call-1" });
      await expect(response(id)).resolves.toEqual({ decision: { denied: { rejection: expect.any(String) } } });
    }
    expect(pending()).toBeNull();
  });

  it("still routes the model's own questions to the question card", async () => {
    const { request, response, pending, session } = await start();
    const id = request("item/tool/requestUserInput", { itemId: "ask-1", questions: [
      { id: "format", header: "Format", question: "Which format?", options: [{ label: "9:16", description: "Portrait" }] },
    ] });
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()!.questions[0]).toMatchObject({ header: "Format", question: "Which format?" });
    session.respond(pending()!.id, { answers: { format: ["9:16"] } });
    await expect(response(id)).resolves.toEqual({ answers: { format: { answers: ["9:16"] } } });
  });
});
