import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/host";
import { ChatStore } from "../src/host/store";
import type { Emit, Harness, HarnessSession, OpenOptions, ResumeCursor, TurnOutcome } from "../src/host/harness";

const hosts: AgentHost[] = [];
const dirs: string[] = [];
const connection = { send() {} };
const input = { projectId: "resume-fixture", cwd: "/tmp/resume-fixture", text: "first reply", model: { harness: "claude" as const, model: "fixture" } };
const cursor = (id: string): ResumeCursor => ({ claude: { sessionId: id } });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Controlled = {
  options: OpenOptions; session: HarnessSession; emit?: Emit;
  sent: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
  finish: (outcome?: TurnOutcome) => void;
};
async function setup(ready: ResumeCursor | null = null, openGate?: Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "agent-resume-host-"));
  dirs.push(dir);
  const store = new ChatStore(dir);
  const sessions: Controlled[] = [];
  const harness: Harness = {
    id: "claude",
    probe: async () => ({ id: "claude", label: "Fixture", status: "ready", models: [{ id: "fixture", label: "Fixture" }] }),
    open: async (options) => {
      const held = deferred<TurnOutcome>();
      const sent = vi.fn(async (_text: string, _model: string, emit: Emit) => { controlled.emit = emit; return held.promise; });
      const close = vi.fn(async () => { held.resolve({ status: "interrupted" }); });
      const session: HarnessSession = { resume: ready, send: sent, respond() {}, interrupt: close, close };
      const controlled: Controlled = { options, session, sent, close, finish: (outcome = { status: "completed" }) => held.resolve(outcome) };
      sessions.push(controlled);
      await openGate;
      return session;
    },
  };
  const makeHost = () => {
    const host = new AgentHost({ store, harnesses: [harness], env: Promise.resolve({ env: {}, extraDirs: [] }), mcp: null, version: "test" });
    hosts.push(host);
    return host;
  };
  const host = makeHost();
  await host.start();
  return { host, store, sessions, makeHost };
}
async function idle(host: AgentHost, chatId: string) {
  await vi.waitFor(async () => expect((await host.handle(connection, "chats.open", { chatId })).chat.status).toBe("idle"));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("persists a ready provider cursor before the first send and resumes it after restarting", async () => {
  const { host, store, sessions, makeHost } = await setup(cursor("confirmed-before-send"));
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  expect(await store.readMeta(chatId)).toMatchObject({ status: "running", resume: cursor("confirmed-before-send") });
  // No first reply has finished when the new host reads the durable metadata.
  const restarted = makeHost();
  await restarted.start();
  await restarted.handle(connection, "turn.send", { ...input, chatId, text: "continue" });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  expect(sessions[1]!.options.resume).toEqual(cursor("confirmed-before-send"));
});

it("persists a first-reply acknowledgment immediately instead of waiting for completion", async () => {
  const { host, store, sessions } = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  expect((await store.readMeta(chatId))?.resume).toBeNull();
  await sessions[0]!.options.onResume!(cursor("provider-acknowledged"));
  expect(await store.readMeta(chatId)).toMatchObject({ status: "running", resume: cursor("provider-acknowledged") });
});

it("does not invent a resume record when startup is cancelled before acknowledgment", async () => {
  const opening = deferred();
  const { host, store, sessions } = await setup(null, opening.promise);
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions).toHaveLength(1));
  const stopped = host.handle(connection, "turn.interrupt", { chatId });
  opening.resolve();
  await stopped;
  expect(sessions[0]!.sent).not.toHaveBeenCalled();
  expect((await store.readMeta(chatId))?.resume).toBeNull();
});

it("does not start provider work when the ready cursor cannot be saved, then allows retry", async () => {
  const { host, store, sessions } = await setup(cursor("confirmed"));
  const write = store.writeMeta.bind(store);
  let failure = true;
  vi.spyOn(store, "writeMeta").mockImplementation((meta) => failure && meta.resume && meta.status === "running"
    ? Promise.reject(new Error("disk full during session save")) : write(meta));
  const { chatId } = await host.handle(connection, "turn.send", input);
  await idle(host, chatId);
  expect(sessions[0]!.sent).not.toHaveBeenCalled();
  expect(sessions[0]!.close).toHaveBeenCalled();
  expect((await host.handle(connection, "chats.open", { chatId })).items).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining("disk full during session save") }));
  failure = false;
  await host.handle(connection, "turn.send", { ...input, chatId });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  expect(sessions[1]!.options.resume).toEqual(cursor("confirmed"));
});

it("does not restore an old running status after a cursor save resolves during a question", async () => {
  const { host, store, sessions } = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  const write = store.writeMeta.bind(store);
  const held = deferred();
  vi.spyOn(store, "writeMeta").mockImplementation(async (meta) => {
    await write(meta);
    if (meta.status === "running" && meta.resume) await held.promise;
  });
  const saving = sessions[0]!.options.onResume!(cursor("confirmed"));
  sessions[0]!.emit!({ type: "request.opened", request: { id: "question", type: "question", questions: [] } });
  held.resolve();
  await saving;
  await vi.waitFor(async () => expect(await store.readMeta(chatId)).toMatchObject({ status: "waiting", resume: cursor("confirmed") }));
  expect((await host.handle(connection, "chats.open", { chatId })).chat.status).toBe("waiting");
});

it("keeps a newer acknowledgment and idle status while final metadata is being saved", async () => {
  const { host, store, sessions } = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  await sessions[0]!.options.onResume!(cursor("first"));
  const write = store.writeMeta.bind(store);
  const finalWrite = deferred();
  const finalStarted = deferred();
  vi.spyOn(store, "writeMeta").mockImplementation(async (meta) => {
    await write(meta);
    if (meta.status === "idle" && "claude" in (meta.resume ?? {}) && (meta.resume as { claude: { sessionId: string } }).claude.sessionId === "first") {
      finalStarted.resolve();
      await finalWrite.promise;
    }
  });
  sessions[0]!.finish();
  await finalStarted.promise;
  await sessions[0]!.options.onResume!(cursor("newer"));
  expect((await host.handle(connection, "chats.open", { chatId })).chat.status).toBe("running");
  await expect(host.handle(connection, "turn.send", { ...input, chatId })).rejects.toMatchObject({ code: "busy" });
  finalWrite.resolve();
  await idle(host, chatId);
  expect(await store.readMeta(chatId)).toMatchObject({ status: "idle", resume: cursor("newer") });
  // Moving the project closes this session; the new open must use the newer cursor.
  await host.handle(connection, "turn.send", { ...input, chatId, cwd: "/tmp/moved-resume-fixture" });
  await vi.waitFor(() => expect(sessions).toHaveLength(2));
  expect(sessions[1]!.options.resume).toEqual(cursor("newer"));
});

it("rejects callbacks from a closed session without changing the replacement's cursor", async () => {
  const { host, store, sessions } = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  await sessions[0]!.options.onResume!(cursor("first"));
  sessions[0]!.finish();
  await idle(host, chatId);
  await host.handle(connection, "turn.send", { ...input, chatId, cwd: "/tmp/moved-resume-fixture" });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  await sessions[1]!.options.onResume!(cursor("replacement"));
  await expect(sessions[0]!.options.onResume!(cursor("stale"))).rejects.toThrow("no longer active");
  expect((await store.readMeta(chatId))?.resume).toEqual(cursor("replacement"));
});

it.each([null, { codex: { threadId: "wrong-provider" } }, { claude: { sessionId: "" } }, { claude: { sessionId: "bad\nidentifier" } }])("refuses malformed provider acknowledgment %j without replacing a saved cursor", async (invalid) => {
  const { host, store, sessions } = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  await sessions[0]!.options.onResume!(cursor("keep"));
  await expect(sessions[0]!.options.onResume!(invalid as ResumeCursor)).rejects.toThrow("invalid session");
  expect((await store.readMeta(chatId))?.resume).toEqual(cursor("keep"));
});

it("shows a failed provider outcome even when the adapter did not emit a notice", async () => {
  const { host, sessions } = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  sessions[0]!.finish({ status: "failed", error: "Provider did not acknowledge its session" });
  await idle(host, chatId);
  expect((await host.handle(connection, "chats.open", { chatId })).items).toContainEqual(expect.objectContaining({ kind: "notice", level: "error", text: "Provider did not acknowledge its session" }));
});

it("does not repeat an adapter's visible failure notice", async () => {
  const { host, sessions } = await setup();
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  sessions[0]!.emit!({ type: "item.completed", item: { id: "provider-failure", kind: "notice", level: "error", text: "Provider session expired" } });
  sessions[0]!.finish({ status: "failed", error: "Provider session expired" });
  await idle(host, chatId);
  const notices = (await host.handle(connection, "chats.open", { chatId })).items.filter((item) => item.kind === "notice" && item.level === "error");
  expect(notices).toHaveLength(1);
});
