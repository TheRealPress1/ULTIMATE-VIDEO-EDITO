/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Regression: every action that used to raise a "Permission" card is now
// decided automatically, for both providers. Only the model's own questions
// may still open a card.

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeHarness, PLAN_MODE_MESSAGE } from "../src/host/claude";
import { CodexHarness } from "../src/host/codex";
import { POLICY_MESSAGES, protectedMessage } from "../src/host/automatic-policy";
import { SHELL_MESSAGES } from "../src/host/project-sandbox";

import type { ChildProcess } from "node:child_process";
import type { HookCallback, HookInput, PermissionResult, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessSession } from "../src/host/harness";
import type { ChatEvent } from "../src/protocol";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(), resolveSettings: vi.fn(async () => ({ effective: {}, sources: [], provenance: {} })) }));
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("../src/host/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/host/env")>(),
  resolveBinary: (name: string) => `/test/${name}`,
  runOnce: vi.fn(async () => "2.1.310 (Claude Code)"),
  resolveClaudeExecutable: (path: string) => path,
  needsShell: () => false,
  killTree: async () => {},
}));

let project: string;
const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "uve-zero-prompt-")));
  await mkdir(join(project, "assets"));
});
afterAll(() => rm(project, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.mocked(console.info).mockRestore();
});

function expectNoPermissionCards(events: ChatEvent[]): void {
  const opened = events.filter((event): event is Extract<ChatEvent, { type: "request.opened" }> => event.type === "request.opened");
  expect(opened.flatMap((event) => event.request.questions).filter((question) => question.header === "Permission")).toEqual([]);
  expect(opened).toEqual([]);
  expect(events.some((event) => event.type === "item.completed" && event.item.kind === "notice" && /^Blocked:/.test(event.item.text))).toBe(false);
}

function idleQuery(): Query {
  let waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  return {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise<IteratorResult<SDKMessage>>((resolve) => { waiting = resolve; }),
    close: () => waiting?.({ value: undefined, done: true }),
  } as unknown as Query;
}

describe("Claude: former permission-card triggers", () => {
  // No real DNS in tests.
  const records: Record<string, string> = { "upload.wikimedia.org": "198.35.26.112", "commons.wikimedia.org": "198.35.26.96", "192-168-1-1.nip.io": "192.168.1.1" };
  const lookupHost = async (name: string) => {
    if (!records[name]) throw new Error(`getaddrinfo ENOTFOUND ${name}`);
    return [{ address: records[name]! }];
  };

  async function start() {
    vi.mocked(query).mockReturnValue(idleQuery());
    const events: ChatEvent[] = [];
    const session: HarnessSession = await new ClaudeHarness(undefined, { lookupHost }).open({
      cwd: project, model: "test-model", mcp: { name: "cutroom", url: "http://127.0.0.1:43127/mcp" },
      env: { env: { PATH: "/test" }, extraDirs: [] }, emit: () => {},
    });
    cleanup.push(() => session.close());
    void session.send("Make a timeline with images that match this script", "test-model", (event) => events.push(event));
    const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
    return { options, events };
  }

  const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });
  const refuse = (message: string): PermissionResult => ({ behavior: "deny", message });

  // What the CLI attaches when it asks: none of it may turn into a card.
  const asked = {
    signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1",
    title: "Claude wants to use this tool", description: "Needs permission", decisionReason: "Matched ask rule",
    blockedPath: "/outside", matchedAskRule: { source: "policySettings" as const, toolName: "Bash" },
  };

  const cases: Array<[string, string, Record<string, unknown>, (input: Record<string, unknown>) => PermissionResult]> = [
    ["hosted generation (flux)", "mcp__cutroom__generate", { model: "flux-2-klein", prompt: "rocket launch at dawn", output: "assets/launch.png" }, allow],
    ["listen without a path", "mcp__cutroom__listen", { prompt: "Who is speaking?" }, allow],
    ["a cutroom tool unknown to the old allowlist", "mcp__cutroom__web_media_download", { url: "https://upload.wikimedia.org/a.jpg" }, allow],
    // The user's own key in Settings is what authorizes the upload; the tool refuses until one is saved, so no card is needed.
    ["asking Gemini about a file", "mcp__cutroom__ask_gemini", { path: "assets/footage/take.mp4", question: "How does the take feel?", send: "audio" }, allow],
    ["saving the editing style", "mcp__cutroom__editing_style", { action: "set", revision: "r1", style: {} }, allow],
    ["web search", "WebSearch", { query: "apollo 11 launch photo public domain" }, allow],
    ["web fetch", "WebFetch", { url: "https://commons.wikimedia.org/wiki/File:Apollo_11_Launch.jpg", prompt: "Find the file URL" }, allow],
    ["web fetch to the editor's loopback server", "WebFetch", { url: "http://127.0.0.1:43127/mcp", prompt: "List tools" }, () => refuse(POLICY_MESSAGES.privateHost)],
    ["globbing a credential store by absolute pattern", "Glob", { pattern: join(homedir(), ".ssh", "*"), path: project }, () => refuse(POLICY_MESSAGES.sensitive)],
    ["reading /etc/hosts", "Read", { file_path: "/etc/hosts" }, allow],
    ["reading a credential store", "Read", { file_path: "~/.aws/credentials" }, () => refuse(POLICY_MESSAGES.sensitive)],
    ["replacing a file outside the project", "Write", { file_path: "/etc/hosts", content: "" }, () => refuse(POLICY_MESSAGES.outsideExisting)],
    ["writing outside every allowed folder", "Edit", { file_path: "/outside/title.tsx", old_string: "a", new_string: "b" }, () => refuse(POLICY_MESSAGES.outside)],
    ["writing a project config folder", "Write", { file_path: ".claude/settings.json", content: "{}" }, () => refuse("Blackout keeps .claude off-limits to editing sessions. Write project files elsewhere in the project folder.")],
    ["a project write", "Write", { file_path: "assets/title.json", content: "{}" }, allow],
    ["rm", "Bash", { command: "rm -rf assets/old-renders" }, () => refuse(SHELL_MESSAGES.destructive)],
    ["dangerouslyDisableSandbox", "Bash", { command: "curl -O https://example.com/a.jpg", dangerouslyDisableSandbox: true }, () => refuse(SHELL_MESSAGES.unsandboxed)],
    ["a sandboxed download", "Bash", { command: "curl -L -o assets/a.jpg https://upload.wikimedia.org/a.jpg" }, allow],
    ["sandbox network to a public host", "SandboxNetworkAccess", { host: "upload.wikimedia.org" }, allow],
    ["sandbox network to loopback", "SandboxNetworkAccess", { host: "127.0.0.1" }, () => refuse(POLICY_MESSAGES.privateHost)],
    ["sandbox network to a private host", "SandboxNetworkAccess", { host: "192.168.1.20" }, () => refuse(POLICY_MESSAGES.privateHost)],
    ["sandbox network to a name that resolves into the LAN", "SandboxNetworkAccess", { host: "192-168-1-1.nip.io" }, () => refuse(POLICY_MESSAGES.privateHost)],
    ["entering plan mode", "EnterPlanMode", {}, () => refuse(PLAN_MODE_MESSAGE)],
    ["another MCP server", "mcp__other__run", {}, () => refuse("Only Blackout's tools are connected in this chat.")],
    ["a scheduling tool", "CronCreate", { cron: "* * * * *" }, () => refuse("CronCreate isn't available in Blackout editing sessions; use the cutroom tools or a sandboxed shell command.")],
    ["a benign built-in", "TodoWrite", { todos: [] }, allow],
  ];

  it("decides every trigger automatically and never opens a Permission card", async () => {
    const { options, events } = await start();
    for (const [name, tool, input, expected] of cases) {
      await expect(options.canUseTool!(tool, input, asked), name).resolves.toEqual(expected(input));
    }
    expectNoPermissionCards(events);
  });

  it("refuses rm and unsandboxed commands in the PreToolUse hook with guidance", async () => {
    const { options, events } = await start();
    const hook = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
    const run = (input: Record<string, unknown>) => hook({
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: input, tool_use_id: "tool-1",
      session_id: "s", transcript_path: "/t", cwd: project,
    } as unknown as HookInput, "tool-1", { signal: new AbortController().signal });
    await expect(run({ command: "rm assets/a.png" })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: SHELL_MESSAGES.destructive } });
    await expect(run({ command: "ls", dangerouslyDisableSandbox: true })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: SHELL_MESSAGES.unsandboxed } });
    expectNoPermissionCards(events);
  });

  it("refuses protected project names in the PreToolUse hook, where acceptEdits would not ask", async () => {
    const { options, events } = await start();
    const hook = options.hooks!.PreToolUse!.find((entry) => entry.matcher === "Write|Edit|MultiEdit|NotebookEdit")!.hooks[0] as HookCallback;
    const run = (input: Record<string, unknown>) => hook({
      hook_event_name: "PreToolUse", tool_name: "Write", tool_input: input, tool_use_id: "tool-1",
      session_id: "s", transcript_path: "/t", cwd: project,
    } as unknown as HookInput, "tool-1", { signal: new AbortController().signal });
    await expect(run({ file_path: join(project, ".cutroom", "web-media.json"), content: "{}" })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: protectedMessage(".cutroom") } });
    await expect(run({ file_path: join(project, "assets", "title.json"), content: "{}" })).resolves.toEqual({});
    expectNoPermissionCards(events);
  });
});

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number } };

describe("Codex: former permission-card triggers", () => {
  async function start() {
    const calls: Message[] = [];
    const stdout = new PassThrough();
    const receive = (message: Message) => stdout.write(`${JSON.stringify(message)}\n`);
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString()) as Message;
        calls.push(message);
        if (message.id !== undefined && message.method) {
          const result = message.method === "config/read" ? { config: { mcp_servers: {} } } :
            message.method.startsWith("thread/") ? { thread: { id: "thread-1" } } :
            message.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
          queueMicrotask(() => receive({ id: message.id, result }));
        }
        callback();
      },
    });
    vi.mocked(spawn).mockReturnValue(Object.assign(new EventEmitter(), { stdin, stdout }) as unknown as ChildProcess);
    const events: ChatEvent[] = [];
    const session = await new CodexHarness().open({
      cwd: project, model: "test-model", mcp: { name: "cutroom", url: "http://127.0.0.1:43127/mcp" },
      env: { env: { PATH: "/test" }, extraDirs: [] }, emit: () => {},
    });
    const turn = session.send("Make a timeline with images that match this script", "test-model", (event) => events.push(event));
    await Promise.resolve();
    cleanup.push(async () => {
      receive({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      await turn;
      await session.close();
      stdout.destroy();
    });
    let nextId = 100;
    const reply = async (method: string, params: Record<string, unknown>) => {
      const id = nextId++;
      receive({ id, method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
      await vi.waitFor(() => expect(calls.some((call) => call.id === id && !call.method)).toBe(true));
      const answer = calls.find((call) => call.id === id && !call.method)!;
      return answer.error ? { error: answer.error.code } : answer.result;
    };
    return { receive, reply, events };
  }

  it("decides every approval request automatically and never opens a Permission card", async () => {
    const { receive, reply, events } = await start();
    receive({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {
      id: "edit-1", type: "fileChange", changes: [{ path: join(project, "assets", "title.json"), kind: { type: "add" } }],
    } } });
    receive({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {
      id: "edit-2", type: "fileChange", changes: [{ path: "/etc/hosts", kind: "update" }],
    } } });
    const cases: Array<[string, string, Record<string, unknown>, unknown]> = [
      ["command escalation", "item/commandExecution/requestApproval", { command: "rm -rf /outside", cwd: project }, { decision: "decline" }],
      ["network command escalation", "item/commandExecution/requestApproval", { command: "curl https://example.com", networkApprovalContext: { host: "example.com" } }, { decision: "decline" }],
      ["project file change", "item/fileChange/requestApproval", { itemId: "edit-1" }, { decision: "accept" }],
      ["outside file change", "item/fileChange/requestApproval", { itemId: "edit-2" }, { decision: "decline" }],
      ["extra permissions", "item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { write: ["/"] } } }, { permissions: {}, scope: "turn" }],
      ["hosted generation tool call", "mcpServer/elicitation/request", {
        serverName: "cutroom", mode: "form", message: "Allow generate?", requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { model: "flux-2-klein", prompt: "rocket" } },
      }, { action: "accept", content: {}, _meta: null }],
      ["editing style tool call", "mcpServer/elicitation/request", {
        serverName: "cutroom", mode: "form", message: "Allow editing_style?", requestedSchema: { type: "object", properties: {} },
        _meta: { tool_params: { action: "set" } },
      }, { action: "accept", content: {}, _meta: null }],
      ["another server's tool call", "mcpServer/elicitation/request", {
        serverName: "other", mode: "form", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call" },
      }, { action: "decline", content: null, _meta: null }],
      ["URL authorization", "mcpServer/elicitation/request", {
        serverName: "cutroom", mode: "url", message: "Sign in", url: "https://example.com/authorize", elicitationId: "e1",
      }, { action: "decline", content: null, _meta: null }],
      ["legacy command approval", "execCommandApproval", { command: ["rm", "-rf", "/"] }, { decision: { denied: { rejection: expect.any(String) } } }],
      ["legacy patch approval", "applyPatchApproval", { fileChanges: {} }, { decision: { denied: { rejection: expect.any(String) } } }],
      ["retired file read approval", "item/fileRead/requestApproval", { path: "/etc/hosts" }, { error: -32601 }],
    ];
    for (const [name, method, params, expected] of cases) {
      await expect(reply(method, params), name).resolves.toEqual(expected);
    }
    expectNoPermissionCards(events);
  });
});
