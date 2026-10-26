import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexHarness } from '../src/host/codex';
import { killTree } from '../src/host/env';
import type { HarnessSession, OpenOptions } from '../src/host/harness';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('../src/host/env', async (original) => ({
  ...await original<typeof import('../src/host/env')>(),
  resolveBinary: () => '/offline-test/codex', needsShell: () => false,
  killTree: vi.fn(async (child: ChildProcess) => { child.emit('exit', null, 'SIGTERM'); }),
}));

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const sessions: HarnessSession[] = [];
const streams: PassThrough[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const stream of streams.splice(0)) stream.destroy();
});

function server(respond: (message: Message) => Pick<Message, 'result' | 'error'> = () => ({ result: { thread: { id: 'confirmed-thread', ephemeral: false } } })) {
  const calls: Message[] = [];
  const stdout = new PassThrough();
  streams.push(stdout);
  const stdin = new Writable({ write(chunk, _encoding, next) {
    const message: Message = JSON.parse(chunk.toString());
    calls.push(message);
    if (message.id !== undefined) {
      const response = message.method === 'initialize' ? { result: {} } :
        message.method === 'config/read' ? { result: { config: {} } } : respond(message);
      queueMicrotask(() => stdout.write(JSON.stringify({ id: message.id, ...response }) + '\n'));
    }
    next();
  } });
  const child = Object.assign(new EventEmitter(), { stdin, stdout }) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  return { calls, child };
}

const options = (extra: Partial<OpenOptions> = {}): OpenOptions => ({
  cwd: '/fixture', model: 'fixture-model', mcp: null,
  env: { env: {}, extraDirs: [] }, emit: () => {}, ...extra,
});
const open = async (extra: Partial<OpenOptions> = {}) => {
  const session = await new CodexHarness().open(options(extra));
  sessions.push(session);
  return session;
};

describe('confirmed Codex conversation recovery', () => {
  it('awaits durable cursor acknowledgement before the first turn can start', async () => {
    const { calls } = server();
    let saved!: () => void;
    const onResume = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
    let opened = false;
    const opening = open({ onResume }).then((session) => { opened = true; return session; });
    await vi.waitFor(() => expect(onResume).toHaveBeenCalledWith({ codex: { threadId: 'confirmed-thread' } }));
    expect(opened).toBe(false);
    expect(calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ ephemeral: false });
    expect(calls.some((call) => call.method === 'turn/start')).toBe(false);
    saved();
    expect((await opening).resume).toEqual({ codex: { threadId: 'confirmed-thread' } });
  });

  it('keeps the acknowledged thread ID rather than the session-tree root', async () => {
    const { calls } = server(() => ({ result: { thread: { id: 'resumed-thread', sessionId: 'different-root', ephemeral: false } } }));
    const onResume = vi.fn(async () => {});
    await open({ resume: { codex: { threadId: 'resumed-thread' } }, onResume });
    expect(calls.find((call) => call.method === 'thread/resume')?.params?.threadId).toBe('resumed-thread');
    expect(onResume).toHaveBeenCalledWith({ codex: { threadId: 'resumed-thread' } });
    expect(calls.some((call) => call.method === 'thread/start')).toBe(false);
  });

  it('records a replacement only after the old thread is explicitly missing', async () => {
    const { calls } = server((message) => message.method === 'thread/resume'
      ? { error: { code: -32602, message: 'Thread not found' } }
      : { result: { thread: { id: 'replacement-thread' } } });
    const onResume = vi.fn(async () => {});
    const emit = vi.fn();
    await open({ resume: { codex: { threadId: 'missing-thread' } }, onResume, emit });
    expect(onResume).toHaveBeenCalledExactlyOnceWith({ codex: { threadId: 'replacement-thread' } });
    expect(calls.filter((call) => call.method === 'thread/start')).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ kind: 'notice', text: expect.stringContaining('started fresh') }) }));
  });

  it('preserves a conversation after a transient resume failure', async () => {
    const { calls } = server(() => ({ error: { code: -32603, message: 'Storage temporarily unavailable' } }));
    const onResume = vi.fn();
    await expect(open({ resume: { codex: { threadId: 'existing-thread' } }, onResume })).rejects.toThrow('Storage temporarily unavailable');
    expect(calls.some((call) => call.method === 'thread/start')).toBe(false);
    expect(onResume).not.toHaveBeenCalled();
    expect(killTree).toHaveBeenCalledOnce();
  });

  it.each([{ thread: { id: 42 } }, { thread: { id: '' } }, { thread: { id: '  ' } }, { thread: { id: 'embedded space' } }, { thread: { id: 'temporary', ephemeral: true } }])('refuses invalid or nonpersistent thread acknowledgements: %j', async (result) => {
    const { calls } = server(() => ({ result }));
    const onResume = vi.fn();
    await expect(open({ resume: { codex: { threadId: 'existing-thread' } }, onResume })).rejects.toThrow(/thread/);
    expect(onResume).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === 'thread/start')).toBe(false);
  });

  it('closes the provider without running a turn when cursor storage fails', async () => {
    const { calls } = server();
    await expect(open({ onResume: async () => { throw new Error('Disk full'); } })).rejects.toThrow('Disk full');
    expect(killTree).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('does not return a dead session when Codex exits during cursor persistence', async () => {
    const { child } = server();
    await expect(open({ onResume: async () => { child.emit('exit', 1); } })).rejects.toThrow('Codex exited while saving');
  });
});
