/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, resolveSettings } from "@anthropic-ai/claude-agent-sdk";

import { runOnce } from "../src/host/env";
import { ClaudeHarness } from "../src/host/claude";
import { emptyTranscript, reduce } from "../src/reduce";

import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessSession } from "../src/host/harness";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(), resolveSettings: vi.fn(async () => ({ effective: {}, sources: [], provenance: {} })) }));
vi.mock("../src/host/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/host/env")>(),
  resolveBinary: () => "/test/claude",
  runOnce: vi.fn(async () => "2.1.310 (Claude Code)"),
  resolveClaudeExecutable: (path: string) => path,
}));

const sessions: HarnessSession[] = [];
const temporaryFolders: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runOnce).mockResolvedValue("2.1.310 (Claude Code)");
  vi.mocked(resolveSettings).mockResolvedValue({ effective: {}, sources: [], provenance: {} });
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const path of temporaryFolders.splice(0)) await rm(path, { recursive: true, force: true });
});

function idleQuery(): Query {
  let waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  return {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise<IteratorResult<SDKMessage>>((resolve) => { waiting = resolve; }),
    close: () => waiting?.({ value: undefined, done: true }),
  } as unknown as Query;
}

async function start(cwd = '/project') {
  vi.mocked(query).mockReturnValue(idleQuery());
  let transcript = emptyTranscript();
  const env = { PATH: "/test", HOME: "/existing/home" };
  const session = await new ClaudeHarness().open({
    cwd, model: "test-model", mcp: { name: "cutroom", url: "http://127.0.0.1:43127/mcp" },
    env: { env, extraDirs: [] }, emit: () => {},
  });
  sessions.push(session);
  const turn = session.send("Edit this project", "test-model", (event) => { transcript = reduce(transcript, event); });
  const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
  const signal = new AbortController();
  const context = { signal: signal.signal, toolUseID: "tool-1", requestId: "request-1" };
  return { session, turn, options, env, signal, context, pending: () => transcript.pending! };
}

describe("Claude native permissions", () => {
  async function capturePath() {
    const folder = await mkdtemp(join(tmpdir(), 'dapi-capture-'));
    temporaryFolders.push(folder);
    const path = join(await realpath(folder), '01s-29s.png');
    await writeFile(path, 'capture fixture');
    return path;
  }

  it('reads a canonical temporary capture without prompting for native working-directory scope', async () => {
    const input = { file_path: await capturePath() };
    const { options, context, pending } = await start(process.cwd());
    await expect(options.canUseTool!('Read', input, {
      ...context, decisionReason: 'Path is outside allowed working directories',
    })).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it.each(['matched rule', 'blocked path', 'deny rule', 'managed policy', 'critical path'])('still reviews temporary files with an explicit %s boundary', async (kind) => {
    const input = { file_path: await capturePath() };
    const { options, context, pending, session } = await start(process.cwd());
    const result = options.canUseTool!('Read', input, {
      ...context,
      decisionReason: kind === 'deny rule' ? 'Matched deny rule' : kind === 'managed policy' ? 'Blocked by organization policy' : kind === 'critical path' ? 'This is a critical path' : 'Path is outside allowed working directories',
      ...(kind === 'matched rule' ? { matchedAskRule: { source: 'policySettings', toolName: 'Read' } } : {}),
      ...(kind === 'blocked path' ? { blockedPath: input.file_path } : {}),
    });
    expect(pending()).not.toBeNull();
    session.respond(pending().id, 'skip');
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
  });

  it.each([false, true])('reviews unrelated paths even with ordinary scope reason (blockedPath=%s)', async (blocked) => {
    const input = { file_path: '/etc/hosts' };
    const { options, context, pending, session } = await start(process.cwd());
    const result = options.canUseTool!('Read', input, { ...context,
      decisionReason: 'Path is outside allowed working directories', ...(blocked ? { blockedPath: input.file_path } : {}),
    });
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    session.respond(pending().id, 'skip');
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('automatically approves the caption backup and Python edit inside the mandatory sandbox', async () => {
    const { options, context, pending } = await start();
    const input = { command: "cp assets/Captions.json /tmp/captions-backup.json && python3 - <<'PY'\nimport json\np='assets/Captions.json'\nd=json.load(open(p)); d['text']='Updated'; json.dump(d,open(p,'w'))\nPY" };
    await expect(options.canUseTool!('Bash', input, { ...context, decisionReason: 'Contains brace with quote character (expansion obfuscation)' })).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it('honors a managed ask rule even when the native reason describes ordinary shell syntax', async () => {
    const { options, context, pending, session } = await start();
    const result = options.canUseTool!('Bash', { command: "python3 -c 'print(1)'" }, { ...context,
      matchedAskRule: { source: 'policySettings', toolName: 'Bash' }, decisionReason: 'Contains quoted command',
    });
    expect(pending()).not.toBeNull();
    session.respond(pending().id, 'skip');
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
  });

  it.each(['sandbox', 'policyHelper'])('does not autoapprove shell callbacks when managed %s affects execution', async (key) => {
    const settings = key === 'sandbox' ? { sandbox: { enabled: false } } : { policyHelper: '/admin/policy' };
    vi.mocked(resolveSettings).mockResolvedValue({ effective: settings, sources: [{ source: 'managed', settings }], provenance: {} } as never);
    const { options, context, pending, session } = await start();
    const result = options.canUseTool!('Bash', { command: "python3 -c 'print(1)'" }, context);
    expect(pending()).not.toBeNull();
    session.respond(pending().id, 'skip');
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('rejects an old CLI before starting any editing session', async () => {
    vi.mocked(runOnce).mockResolvedValue('2.0.0 (Claude Code)');
    await expect(start()).rejects.toThrow('2.1.310');
    expect(query).not.toHaveBeenCalled();
  });

  it('does not approve a callback after cancellation', async () => {
    const { options, context, signal, pending } = await start();
    signal.abort();
    await expect(options.canUseTool!('Bash', { command: 'python3 script.py' }, context)).resolves.toMatchObject({ behavior: 'deny' });
    expect(pending()).toBeNull();
  });
  it("keeps native login, scopes automatic edits, and isolates this run's MCP", async () => {
    const { options, env } = await start();
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.allowDangerouslySkipPermissions).not.toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [], network: { allowedDomains: [], strictAllowlist: true } });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({ cutroom: { type: "http", url: "http://127.0.0.1:43127/mcp" } });
    expect(options.pathToClaudeCodeExecutable).toBe("/test/claude");
    expect(options.env).toMatchObject(env);
    expect(options.env).toMatchObject({ MCP_TOOL_TIMEOUT: "14400000", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "14400000" });
    expect(options.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(options.additionalDirectories).toBeUndefined();
  });

  it("waits on outside-project actions and grants only the reviewed call", async () => {
    const { options, session, pending, context } = await start();
    const input = { file_path: "/outside/title.tsx", content: "export default 'Title'" };
    const result = options.canUseTool!("Write", input, { ...context, blockedPath: input.file_path });
    expect(pending().questions[0]?.question).toContain(input.file_path);
    session.respond(pending().id, { answers: { [pending().questions[0]!.id]: ["Allow once"] } });
    await expect(result).resolves.toEqual({ behavior: "allow", updatedInput: input });

    const second = options.canUseTool!("Write", input, context);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    session.respond(pending().id, "skip");
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
  });

  it("denies an action when the user stops waiting", async () => {
    const { options, pending, context, signal } = await start();
    const result = options.canUseTool!("Bash", { command: "ffmpeg -i /source.mp4 /outside.mp4", dangerouslyDisableSandbox: true }, context);
    expect(pending()).not.toBeNull();
    signal.abort();
    await expect(result).resolves.toMatchObject({ behavior: "deny" });
    expect(pending()).toBeNull();
  });

  it("routes ordinary questions once through the same UI", async () => {
    const { options, pending, session, context } = await start();
    const questions = [{ question: "Which format?", header: "Format", options: [{ label: "9:16", description: "Portrait" }] }];
    const result = options.canUseTool!("AskUserQuestion", { questions }, context);
    expect(options.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
    session.respond(pending().id, { answers: { "Which format?": ["9:16"] } });
    await expect(result).resolves.toEqual({ behavior: "allow", updatedInput: { questions, answers: { "Which format?": "9:16" } } });
  });
});
