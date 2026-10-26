import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeHarness } from "../src/host/claude";
import type { HarnessSession, OpenOptions } from "../src/host/harness";
import type { ChatEvent } from "../src/protocol";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(), resolveSettings: vi.fn(async () => ({ effective: {}, sources: [], provenance: {} })) }));
vi.mock("../src/host/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/host/env")>(),
  resolveBinary: () => "/test/claude",
  runOnce: vi.fn(async () => "2.1.310 (Claude Code)"),
  resolveClaudeExecutable: (path: string) => path,
}));

const CONFIRMED = "21b1666e-7fba-4ab9-887a-758e87cc35bf";
const OTHER = "ac132b82-c980-47bf-b53c-d19aa717a281";
const init = (id = CONFIRMED) => ({ type: "system", subtype: "init", session_id: id }) as SDKMessage;
const result = () => ({ type: "result", subtype: "success", is_error: false, result: "done", session_id: CONFIRMED, permission_denials: [] }) as unknown as SDKMessage;
const assistant = () => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Restored context" }] } }) as unknown as SDKMessage;

function controlledQuery() {
  const items: Array<IteratorResult<SDKMessage> | Error> = [];
  let waiting: { resolve(value: IteratorResult<SDKMessage>): void; reject(error: Error): void } | undefined;
  let closed = false;
  const put = (item: IteratorResult<SDKMessage> | Error) => {
    if (waiting) {
      const current = waiting;
      waiting = undefined;
      if (item instanceof Error) current.reject(item);
      else current.resolve(item);
    } else items.push(item);
  };
  const q = {
    [Symbol.asyncIterator]() { return this; },
    next: vi.fn((): Promise<IteratorResult<SDKMessage>> => {
      if (closed) return Promise.resolve({ value: undefined, done: true });
      const item = items.shift();
      if (item instanceof Error) return Promise.reject(item);
      if (item) return Promise.resolve(item);
      return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
    }),
    close: vi.fn(() => { closed = true; put({ value: undefined, done: true }); }),
    setModel: vi.fn(async () => {}),
  };
  return { q: q as unknown as Query, next: q.next, close: q.close, push: (message: SDKMessage) => put({ value: message, done: false }), fail: (error: Error) => put(error) };
}

const sessions: HarnessSession[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); });
async function open(extra: Partial<OpenOptions> = {}) {
  const session = await new ClaudeHarness().open({
    cwd: "/fixture", model: "test", mcp: null, env: { env: {}, extraDirs: [] }, emit() {}, ...extra,
  });
  sessions.push(session);
  return session;
}

describe("Claude confirmed session recovery", () => {
  it("keeps the generated ID private and waits for confirmed-cursor persistence before processing more messages", async () => {
    const stream = controlledQuery();
    vi.mocked(query).mockReturnValue(stream.q);
    let saved!: () => void;
    const onResume = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
    const session = await open({ onResume });
    expect(session.resume).toBeNull();
    const events: ChatEvent[] = [];
    const turn = session.send("First prompt", "test", (event) => events.push(event));
    expect(vi.mocked(query).mock.calls[0]![0].options?.sessionId).toBeTruthy();
    expect(vi.mocked(query).mock.calls[0]![0].options?.resume).toBeUndefined();
    expect(session.resume).toBeNull();
    stream.push(init());
    stream.push(assistant());
    await vi.waitFor(() => expect(onResume).toHaveBeenCalledWith({ claude: { sessionId: CONFIRMED } }));
    expect(events).toEqual([]);
    expect(stream.next).toHaveBeenCalledTimes(1);
    saved();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    stream.push(result());
    await expect(turn).resolves.toEqual({ status: "completed" });
    expect(session.resume).toEqual({ claude: { sessionId: CONFIRMED } });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("retries a startup failure as a new session instead of resuming a guessed ID", async () => {
    const first = controlledQuery();
    const second = controlledQuery();
    vi.mocked(query).mockReturnValueOnce(first.q).mockReturnValueOnce(second.q);
    const onResume = vi.fn(async () => {});
    const session = await open({ onResume });
    const failed = session.send("First prompt", "test", () => {});
    first.fail(new Error("CLI failed before initialization"));
    await expect(failed).resolves.toMatchObject({ status: "failed", error: "CLI failed before initialization" });
    expect(session.resume).toBeNull();
    expect(onResume).not.toHaveBeenCalled();
    const retried = session.send("Retry", "test", () => {});
    expect(vi.mocked(query).mock.calls[1]![0].options).toMatchObject({ sessionId: expect.any(String) });
    expect(vi.mocked(query).mock.calls[1]![0].options?.resume).toBeUndefined();
    second.push(init()); second.push(result());
    await expect(retried).resolves.toMatchObject({ status: "completed" });
  });

  it("does not record a late init from a query stopped before initialization", async () => {
    const first = controlledQuery();
    const second = controlledQuery();
    first.close.mockImplementation(() => first.push(init(OTHER)));
    vi.mocked(query).mockReturnValueOnce(first.q).mockReturnValueOnce(second.q);
    const onResume = vi.fn(async () => {});
    const session = await open({ onResume });
    const stopped = session.send("First prompt", "test", () => {});
    await session.interrupt();
    await expect(stopped).resolves.toEqual({ status: "interrupted" });
    expect(onResume).not.toHaveBeenCalled();
    expect(session.resume).toBeNull();
    const next = session.send("Try again", "test", () => {});
    expect(vi.mocked(query).mock.calls[1]![0].options?.resume).toBeUndefined();
    second.push(init()); second.push(result());
    await expect(next).resolves.toMatchObject({ status: "completed" });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("closes the query on persistence failure and resumes the confirmed conversation after storage recovers", async () => {
    const first = controlledQuery();
    const second = controlledQuery();
    vi.mocked(query).mockReturnValueOnce(first.q).mockReturnValueOnce(second.q);
    const onResume = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(undefined);
    const session = await open({ onResume });
    const events: ChatEvent[] = [];
    const failed = session.send("First prompt", "test", (event) => events.push(event));
    first.push(init()); first.push(assistant());
    await expect(failed).resolves.toMatchObject({ status: "failed", error: "Disk full" });
    expect(first.close).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    expect(session.resume).toEqual({ claude: { sessionId: CONFIRMED } });
    const retried = session.send("Continue", "test", () => {});
    expect(vi.mocked(query).mock.calls[1]![0].options?.resume).toBe(CONFIRMED);
    expect(vi.mocked(query).mock.calls[1]![0].options?.sessionId).toBeUndefined();
    second.push(init()); second.push(result());
    await expect(retried).resolves.toMatchObject({ status: "completed" });
  });

  it("uses the persisted confirmed ID when opening a resumed conversation", async () => {
    const stream = controlledQuery();
    vi.mocked(query).mockReturnValue(stream.q);
    const onResume = vi.fn(async () => {});
    const session = await open({ resume: { claude: { sessionId: CONFIRMED } }, onResume });
    expect(session.resume).toEqual({ claude: { sessionId: CONFIRMED } });
    const turn = session.send("Continue after restart", "test", () => {});
    expect(vi.mocked(query).mock.calls[0]![0].options?.resume).toBe(CONFIRMED);
    stream.push(init()); stream.push(result());
    await expect(turn).resolves.toMatchObject({ status: "completed" });
    expect(onResume).toHaveBeenCalledWith({ claude: { sessionId: CONFIRMED } });
  });

  it("resumes a first reply interrupted after initialization but before any result", async () => {
    const first = controlledQuery();
    const second = controlledQuery();
    vi.mocked(query).mockReturnValueOnce(first.q).mockReturnValueOnce(second.q);
    const onResume = vi.fn(async () => {});
    const session = await open({ onResume });
    const firstTurn = session.send("First prompt", "test", () => {});
    first.push(init());
    await vi.waitFor(() => expect(onResume).toHaveBeenCalledWith({ claude: { sessionId: CONFIRMED } }));
    await session.interrupt();
    await expect(firstTurn).resolves.toEqual({ status: "interrupted" });
    const continued = session.send("Continue", "test", () => {});
    expect(vi.mocked(query).mock.calls[1]![0].options?.resume).toBe(CONFIRMED);
    second.push(init()); second.push(result());
    await expect(continued).resolves.toEqual({ status: "completed" });
  });

  it("does not reopen a query when stopped during an awaited model change", async () => {
    const first = controlledQuery();
    const next = controlledQuery();
    vi.mocked(query).mockReturnValueOnce(first.q).mockReturnValueOnce(next.q);
    const session = await open();
    const initial = session.send("First prompt", "test", () => {});
    first.push(init()); first.push(result());
    await expect(initial).resolves.toEqual({ status: "completed" });

    let changed!: () => void;
    vi.mocked(first.q.setModel).mockReturnValue(new Promise<void>((resolve) => { changed = resolve; }));
    const interrupted = session.send("Next prompt", "other-model", () => {});
    expect(first.q.setModel).toHaveBeenCalledWith("other-model");
    await session.interrupt();
    changed();
    await expect(interrupted).resolves.toEqual({ status: "interrupted" });
    expect(query).toHaveBeenCalledTimes(1);

    const retried = session.send("Try again", "other-model", () => {});
    expect(query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(query).mock.calls[1]![0].options?.resume).toBe(CONFIRMED);
    next.push(init()); next.push(result());
    await expect(retried).resolves.toEqual({ status: "completed" });
  });

  it("retains no turn after query construction throws synchronously", async () => {
    const stream = controlledQuery();
    vi.mocked(query).mockImplementationOnce(() => { throw new Error("Cannot launch CLI"); }).mockReturnValueOnce(stream.q);
    const session = await open();
    await expect(session.send("First", "test", () => {})).rejects.toThrow("Cannot launch CLI");
    expect(session.resume).toBeNull();
    const retry = session.send("Retry", "test", () => {});
    stream.push(init()); stream.push(result());
    await expect(retry).resolves.toMatchObject({ status: "completed" });
  });

  it.each(["", " ", ` ${CONFIRMED}`, `${CONFIRMED} `, "session id", "session\nid"])("rejects malformed confirmed IDs without poisoning a retry: %j", async (id) => {
    const stream = controlledQuery();
    const retryStream = controlledQuery();
    vi.mocked(query).mockReturnValueOnce(stream.q).mockReturnValueOnce(retryStream.q);
    const onResume = vi.fn(async () => {});
    const session = await open({ onResume });
    const events: ChatEvent[] = [];
    const turn = session.send("First", "test", (event) => events.push(event));
    stream.push(init(id)); stream.push(assistant());
    await expect(turn).resolves.toMatchObject({ status: "failed", error: "Claude Code returned an invalid session id" });
    expect(session.resume).toBeNull();
    expect(onResume).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    const retried = session.send("Retry", "test", () => {});
    expect(vi.mocked(query).mock.calls[1]![0].options?.resume).toBeUndefined();
    retryStream.push(init()); retryStream.push(result());
    await expect(retried).resolves.toEqual({ status: "completed" });
  });
});
