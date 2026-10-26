/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query, resolveSettings } from "@anthropic-ai/claude-agent-sdk";

import { runOnce } from "../src/host/env";
import { ClaudeHarness, PLAN_MODE_MESSAGE, globSearchRoot } from "../src/host/claude";
import { POLICY_MESSAGES, protectedMessage } from "../src/host/automatic-policy";
import { SHELL_MESSAGES } from "../src/host/project-sandbox";
import { emptyTranscript, reduce } from "../src/reduce";

import type { HookCallback, HookInput, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessSession } from "../src/host/harness";
import type { ChatEvent } from "../src/protocol";

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
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => {
  vi.mocked(console.info).mockRestore();
  for (const session of sessions.splice(0)) await session.close();
  for (const path of temporaryFolders.splice(0)) await rm(path, { recursive: true, force: true });
});

/** A query that stays open until closed and emits whatever the test pushes. */
function scriptedQuery(): { q: Query; push(message: SDKMessage): void } {
  const queued: SDKMessage[] = [];
  let waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  let closed = false;
  const q = {
    [Symbol.asyncIterator]() { return this; },
    next: () => {
      if (closed) return Promise.resolve({ value: undefined, done: true });
      const message = queued.shift();
      if (message) return Promise.resolve({ value: message, done: false });
      return new Promise<IteratorResult<SDKMessage>>((resolve) => { waiting = resolve; });
    },
    close: () => { closed = true; waiting?.({ value: undefined, done: true }); },
  } as unknown as Query;
  return {
    q,
    push(message) {
      const resolve = waiting;
      waiting = undefined;
      if (resolve) resolve({ value: message, done: false });
      else queued.push(message);
    },
  };
}

/** No real DNS in tests: a fixed table, and anything else does not resolve. */
const DNS: Record<string, string[]> = {
  "commons.wikimedia.org": ["198.35.26.96"],
  "upload.wikimedia.org": ["198.35.26.112"],
  "192-168-1-1.nip.io": ["192.168.1.1"],
  "127.0.0.1.nip.io": ["127.0.0.1"],
};
const lookupHost = vi.fn(async (name: string) => {
  const addresses = DNS[name];
  if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address }));
});

async function start(cwd = '/project', dataDir?: string) {
  const stream = scriptedQuery();
  vi.mocked(query).mockReturnValue(stream.q);
  let transcript = emptyTranscript();
  const events: ChatEvent[] = [];
  const env = { PATH: "/test", HOME: "/existing/home" };
  const session = await new ClaudeHarness(undefined, { lookupHost }).open({
    cwd, model: "test-model", mcp: { name: "cutroom", url: "http://127.0.0.1:43127/mcp" },
    env: { env, extraDirs: [] }, emit: () => {}, ...(dataDir ? { dataDir } : {}),
  });
  sessions.push(session);
  const turn = session.send("Edit this project", "test-model", (event) => {
    events.push(event);
    transcript = reduce(transcript, event);
  });
  const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
  const signal = new AbortController();
  const context = { signal: signal.signal, toolUseID: "tool-1", requestId: "request-1" };
  return { session, turn, options, env, signal, context, events, stream, pending: () => transcript.pending, items: () => transcript.items };
}

const hook = (callback: HookCallback, input: Record<string, unknown>, toolName = 'Bash') => callback({
  hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: 'tool-1',
  session_id: 's', transcript_path: '/t', cwd: '/project',
} as unknown as HookInput, 'tool-1', { signal: new AbortController().signal });

describe("Claude automatic permissions", () => {
  async function capturePath() {
    const folder = await mkdtemp(join(tmpdir(), 'dapi-capture-'));
    temporaryFolders.push(folder);
    const path = join(await realpath(folder), '01s-29s.png');
    await writeFile(path, 'capture fixture');
    return path;
  }

  it('reads a canonical temporary capture outside the native working directories', async () => {
    const input = { file_path: await capturePath() };
    const { options, context, pending } = await start(process.cwd());
    await expect(options.canUseTool!('Read', input, {
      ...context, decisionReason: 'Path is outside allowed working directories',
    })).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it.each(['matched rule', 'blocked path', 'deny rule', 'managed policy', 'critical path'])('decides by its own policy when the CLI reports a %s', async (kind) => {
    const input = { file_path: await capturePath() };
    const { options, context, pending } = await start(process.cwd());
    await expect(options.canUseTool!('Read', input, {
      ...context,
      decisionReason: kind === 'deny rule' ? 'Matched deny rule' : kind === 'managed policy' ? 'Blocked by organization policy' : kind === 'critical path' ? 'This is a critical path' : 'Path is outside allowed working directories',
      ...(kind === 'matched rule' ? { matchedAskRule: { source: 'policySettings', toolName: 'Read' } } : {}),
      ...(kind === 'blocked path' ? { blockedPath: input.file_path } : {}),
    })).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it.each([false, true])('reads unrelated system files without a card (blockedPath=%s)', async (blocked) => {
    const input = { file_path: '/etc/hosts' };
    const { options, context, pending } = await start(process.cwd());
    await expect(options.canUseTool!('Read', input, { ...context,
      decisionReason: 'Path is outside allowed working directories', ...(blocked ? { blockedPath: input.file_path } : {}),
    })).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it('refuses credential stores with guidance', async () => {
    const { options, context, pending } = await start(process.cwd());
    await expect(options.canUseTool!('Read', { file_path: '~/.ssh/id_ed25519' }, context))
      .resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.sensitive });
    expect(pending()).toBeNull();
  });

  it('judges Glob by the folder an absolute pattern searches, not only by path', async () => {
    const { options, context, pending } = await start(process.cwd());
    const glob = (input: Record<string, unknown>) => options.canUseTool!('Glob', input, context);
    await expect(glob({ pattern: join(homedir(), '.ssh', '*') })).resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.sensitive });
    await expect(glob({ pattern: join(homedir(), '.ssh', 'id_*'), path: process.cwd() })).resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.sensitive });
    await expect(glob({ pattern: join(homedir(), '**', '*.pem') })).resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.sensitiveSearch });
    const relative = { pattern: '**/*.mp4', path: process.cwd() };
    await expect(glob(relative)).resolves.toEqual({ behavior: 'allow', updatedInput: relative });
    const system = { pattern: '/usr/share/**/*.txt' };
    await expect(glob(system)).resolves.toEqual({ behavior: 'allow', updatedInput: system });
    expect(pending()).toBeNull();
  });

  it.each([
    ['/Users/me/.ssh/*', '/Users/me/.ssh'],
    ['/Users/me/.ssh/id_ed25519', '/Users/me/.ssh'],
    ['/Users/me/**/*.json', '/Users/me'],
    ['/*', '/'],
    ['~/.aws/*', '~/.aws'],
    ['~/*', '~'],
    ['**/*.mp4', undefined],
    ['assets/*.png', undefined],
  ])('reads the searched folder of %s like the CLI', (pattern, root) => {
    expect(globSearchRoot(pattern)).toBe(root);
  });

  it('refuses web fetches to local and private addresses', async () => {
    const { options, context, pending } = await start();
    for (const url of ['http://127.0.0.1:43127/mcp', 'http://[::1]:43127/mcp', 'http://169.254.169.254/latest/meta-data', 'http://nas.local/', 'http://router/'])
      await expect(options.canUseTool!('WebFetch', { url, prompt: 'Read it' }, context)).resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.privateHost });
    const input = { url: 'https://commons.wikimedia.org/wiki/File:Apollo_11_Launch.jpg', prompt: 'Find the file URL' };
    await expect(options.canUseTool!('WebFetch', input, context)).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    await expect(options.canUseTool!('WebFetch', { url: 'http://192-168-1-1.nip.io/admin', prompt: 'Read it' }, context))
      .resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.privateHost });
    expect(pending()).toBeNull();
  });

  it('checks where a sandbox host resolves, so wildcard DNS cannot reach the LAN or loopback', async () => {
    const { options, context, pending } = await start();
    const network = (host: string) => options.canUseTool!('SandboxNetworkAccess', { host, port: 80 }, context);
    await expect(network('upload.wikimedia.org')).resolves.toEqual({ behavior: 'allow', updatedInput: { host: 'upload.wikimedia.org', port: 80 } });
    await expect(network('192-168-1-1.nip.io')).resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.privateHost });
    await expect(network('127.0.0.1.nip.io')).resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.privateHost });
    await expect(network('does-not-resolve.example')).resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.unresolvedHost });
    expect(lookupHost).toHaveBeenCalledWith('192-168-1-1.nip.io');
    expect(pending()).toBeNull();
  });

  it('turns auto-memory off and refuses plan mode with guidance, keeping ExitPlanMode', async () => {
    const { options, context, pending } = await start();
    expect(options.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    const before = options.hooks!.PreToolUse!.find((entry) => entry.matcher === 'EnterPlanMode')!;
    await expect(hook(before.hooks[0]!, {}, 'EnterPlanMode')).resolves.toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_MODE_MESSAGE,
    } });
    await expect(options.canUseTool!('EnterPlanMode', {}, context)).resolves.toEqual({ behavior: 'deny', message: PLAN_MODE_MESSAGE });
    await expect(options.canUseTool!('ExitPlanMode', { plan: 'Cut the intro' }, context))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'Cut the intro' } });
    expect(pending()).toBeNull();
  });

  it("hides the host's chat store from the file tools and the shell", async () => {
    const dataDir = join(await realpath(await mkdtemp(join(tmpdir(), 'uve-chat-store-'))), 'agent-chat');
    temporaryFolders.push(dirname(dataDir));
    const { options, context, pending } = await start(process.cwd(), dataDir);
    expect(options.sandbox!.filesystem!.denyRead).toContain(dataDir);
    await expect(options.canUseTool!('Read', { file_path: join(dataDir, 'chats', 'c1', 'events.jsonl') }, context))
      .resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.sensitive });
    await expect(options.canUseTool!('Grep', { pattern: 'token', path: dirname(dataDir) }, context))
      .resolves.toEqual({ behavior: 'deny', message: POLICY_MESSAGES.sensitiveSearch });
    expect(pending()).toBeNull();
  });

  it('refuses protected project names before acceptEdits writes them', async () => {
    const project = await realpath(await mkdtemp(join(tmpdir(), 'uve-claude-project-')));
    temporaryFolders.push(project);
    const { options, pending } = await start(project);
    const before = options.hooks!.PreToolUse!.find((entry) => entry.matcher === 'Write|Edit|MultiEdit|NotebookEdit')!;
    for (const [tool, input, segment] of [
      ['Write', { file_path: '.cutroom/web-media.json', content: '{}' }, '.cutroom'],
      ['Edit', { file_path: join(project, '.codex', 'config.toml'), old_string: 'a', new_string: 'b' }, '.codex'],
      ['MultiEdit', { file_path: join(project, '.ssh', 'config'), edits: [] }, '.ssh'],
      ['NotebookEdit', { notebook_path: join(project, '.aws', 'notes.ipynb'), new_source: '' }, '.aws'],
    ] as const) {
      await expect(hook(before.hooks[0]!, input, tool), tool).resolves.toEqual({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: protectedMessage(segment),
      } });
    }
    await expect(hook(before.hooks[0]!, { file_path: join(project, 'assets', 'title.json'), content: '{}' }, 'Write')).resolves.toEqual({});
    await expect(hook(before.hooks[0]!, { file_path: '/etc/hosts', content: '' }, 'Write')).resolves.toMatchObject({ hookSpecificOutput: {
      permissionDecision: 'deny', permissionDecisionReason: POLICY_MESSAGES.outsideExisting,
    } });
    expect(pending()).toBeNull();
  });

  it('automatically approves the caption backup and Python edit inside the mandatory sandbox', async () => {
    const { options, context, pending } = await start();
    const input = { command: "cp assets/Captions.json /tmp/captions-backup.json && python3 - <<'PY'\nimport json\np='assets/Captions.json'\nd=json.load(open(p)); d['text']='Updated'; json.dump(d,open(p,'w'))\nPY" };
    await expect(options.canUseTool!('Bash', input, { ...context, decisionReason: 'Contains brace with quote character (expansion obfuscation)' })).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it("refuses a command Claude Code flags as a dangerous removal instead of approving the ask", async () => {
    const { options, context, pending } = await start();
    const input = { command: 'sh -c "$CLEANUP"' };
    for (const decisionReason of [
      'A permission rule denies a command in this shell -c script',
      'This shell -c script runs rm and could not be checked',
      'Dangerous rm operation in a shell -c script, on a target built from a value known only when it runs',
    ]) {
      await expect(options.canUseTool!('Bash', input, { ...context, decisionReason }), decisionReason)
        .resolves.toEqual({ behavior: 'deny', message: SHELL_MESSAGES.destructive });
    }
    await expect(options.canUseTool!('Bash', { command: "bash -c 'rm -rf assets'" }, context))
      .resolves.toEqual({ behavior: 'deny', message: SHELL_MESSAGES.destructive });
    await expect(options.canUseTool!('Bash', input, context)).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it('ignores a matched ask rule for an ordinary sandboxed command', async () => {
    const { options, context, pending } = await start();
    const input = { command: "python3 -c 'print(1)'" };
    await expect(options.canUseTool!('Bash', input, { ...context,
      matchedAskRule: { source: 'policySettings', toolName: 'Bash' }, decisionReason: 'Contains quoted command',
    })).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(pending()).toBeNull();
  });

  it.each(['sandbox', 'policyHelper'])('refuses shell callbacks with guidance when managed %s affects execution', async (key) => {
    const settings = key === 'sandbox' ? { sandbox: { enabled: false } } : { policyHelper: '/admin/policy' };
    vi.mocked(resolveSettings).mockResolvedValue({ effective: settings, sources: [{ source: 'managed', settings }], provenance: {} } as never);
    const { options, context, pending } = await start();
    await expect(options.canUseTool!('Bash', { command: "python3 -c 'print(1)'" }, context))
      .resolves.toEqual({ behavior: 'deny', message: SHELL_MESSAGES.managed });
    expect(pending()).toBeNull();
  });

  it('rejects an old CLI before starting any editing session', async () => {
    vi.mocked(runOnce).mockResolvedValue('2.0.0 (Claude Code)');
    await expect(start()).rejects.toThrow('2.1.310');
    expect(query).not.toHaveBeenCalled();
  });

  it('does not approve a callback after cancellation', async () => {
    const { options, context, signal, pending } = await start();
    signal.abort();
    await expect(options.canUseTool!('Bash', { command: 'python3 script.py' }, context))
      .resolves.toEqual({ behavior: 'deny', message: 'The editing request is no longer active.' });
    expect(pending()).toBeNull();
  });

  it("keeps native login, scopes automatic edits, routes hosts through canUseTool and isolates this run's MCP", async () => {
    const { options, env } = await start();
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.allowDangerouslySkipPermissions).not.toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [], network: { allowedDomains: [], strictAllowlist: false } });
    // Sandboxed commands reach public hosts without asking: credential stores stay unreadable to them,
    // and protected project names unwritable.
    const filesystem = options.sandbox!.filesystem!;
    expect(filesystem.allowWrite).toContain('/project');
    expect(filesystem.denyWrite).toEqual(expect.arrayContaining(['/project/.cutroom', '/project/.codex', '/project/.git', '/project/.claude', '/project/.mcp.json']));
    expect(filesystem.denyRead).toEqual(expect.arrayContaining([join(homedir(), '.ssh'), join(homedir(), '.aws'), join(homedir(), 'Library', 'Keychains')]));
    if (process.platform === 'darwin') expect(filesystem.denyRead).toContain(`/System/Volumes/Data${join(await realpath(homedir()), '.ssh')}`);
    // The CLI's saved tool results for this session stay readable to jq and grep.
    expect(filesystem.denyRead).toContain(join(homedir(), '.claude', 'projects'));
    expect(typeof options.sessionId).toBe('string');
    expect(filesystem.allowRead).toContain(join(homedir(), '.claude', 'projects', '-project', options.sessionId!, 'tool-results'));
    expect(options.settings).toEqual({ permissions: { deny: [
      'Bash(dangerouslyDisableSandbox:true)',
      'Bash(rm *)', 'Bash(/bin/rm *)', 'Bash(rmdir *)', 'Bash(/bin/rmdir *)',
      'Bash(sudo *)', 'Bash(git push *)', 'Bash(git reset *)', 'Bash(git clean *)',
    ] } });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({ cutroom: { type: "http", url: "http://127.0.0.1:43127/mcp" } });
    expect(options.pathToClaudeCodeExecutable).toBe("/test/claude");
    expect(options.env).toMatchObject(env);
    expect(options.env).toMatchObject({ MCP_TOOL_TIMEOUT: "14400000", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "14400000" });
    expect(options.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(options.additionalDirectories).toBeUndefined();
  });

  it("refuses writes outside the project with guidance instead of waiting", async () => {
    const { options, pending, context } = await start();
    const input = { file_path: "/outside/title.tsx", content: "export default 'Title'" };
    await expect(options.canUseTool!("Write", input, { ...context, blockedPath: input.file_path }))
      .resolves.toEqual({ behavior: "deny", message: POLICY_MESSAGES.outside });
    await expect(options.canUseTool!("Write", { file_path: "/etc/hosts", content: "" }, context))
      .resolves.toEqual({ behavior: "deny", message: POLICY_MESSAGES.outsideExisting });
    expect(pending()).toBeNull();
  });

  it("refuses unsandboxed and destructive commands in the hook and the callback", async () => {
    const { options, pending, context } = await start();
    const before = options.hooks!.PreToolUse![0]!;
    expect(before.matcher).toBe("Bash");
    const unsandboxed = { command: "ffmpeg -i /source.mp4 /outside.mp4", dangerouslyDisableSandbox: true };
    await expect(options.canUseTool!("Bash", unsandboxed, context)).resolves.toEqual({ behavior: "deny", message: SHELL_MESSAGES.unsandboxed });
    await expect(hook(before.hooks[0]!, unsandboxed)).resolves.toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SHELL_MESSAGES.unsandboxed,
    } });
    await expect(hook(before.hooks[0]!, { command: "rm -rf assets/old" })).resolves.toMatchObject({ hookSpecificOutput: {
      permissionDecision: 'deny', permissionDecisionReason: SHELL_MESSAGES.destructive,
    } });
    await expect(hook(before.hooks[0]!, { command: "ffmpeg -i in.mp4 out.mp4" })).resolves.toEqual({});
    expect(pending()).toBeNull();
  });

  it("logs permission denials instead of posting Blocked notices", async () => {
    const { stream, items, turn } = await start();
    stream.push({
      type: "result", subtype: "success", is_error: false, result: "done", session_id: "s",
      permission_denials: [{ tool_name: "Bash", tool_use_id: "tool-1", tool_input: { command: "rm secret.txt" } }],
    } as unknown as SDKMessage);
    await expect(turn).resolves.toEqual({ status: "completed" });
    expect(items().some((item) => item.kind === "notice")).toBe(false);
    const logged = vi.mocked(console.info).mock.calls.map((call) => String(call[1]));
    expect(logged).toContain(JSON.stringify({ provider: "claude", denials: ["Bash"] }));
    expect(logged.join("\n")).not.toContain("secret.txt");
  });

  it("routes ordinary questions once through the question card", async () => {
    const { options, pending, session, context } = await start();
    const questions = [{ question: "Which format?", header: "Format", options: [{ label: "9:16", description: "Portrait" }] }];
    const result = options.canUseTool!("AskUserQuestion", { questions }, context);
    expect(pending()!.questions[0]).toMatchObject({ header: "Format", question: "Which format?" });
    session.respond(pending()!.id, { answers: { "Which format?": ["9:16"] } });
    await expect(result).resolves.toEqual({ behavior: "allow", updatedInput: { questions, answers: { "Which format?": "9:16" } } });
  });
});
