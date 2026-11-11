import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/host";
import { ChatStore } from "../src/host/store";
import type { Emit, Harness, HarnessSession, OpenOptions, ResumeCursor, TurnOutcome } from "../src/host/harness";
import type { HostMsg } from "../src/protocol";

// A resumed Claude session keeps the instructions and tool descriptions its conversation began with, so a chat
// that outlives an app update has to be told what changed. These tests stand in for the app being updated by
// starting a second host, over the same chats, with different instructions.

const hosts: AgentHost[] = [];
const dirs: string[] = [];
const events: HostMsg[] = [];
const connection = { send: (message: HostMsg) => { events.push(message); } };
const cursor: ResumeCursor = { claude: { sessionId: "session-1" } };
const input = { projectId: "refresh-fixture", cwd: "/tmp/refresh-fixture", text: "first", model: { harness: "claude" as const, model: "fixture" } };
const MEDIA = "Footage from YouTube is media_search then media_download with kind video.";

type Opened = { options: OpenOptions; sent: ReturnType<typeof vi.fn> };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "agent-refresh-host-"));
  dirs.push(dir);
  const store = new ChatStore(dir);
  const sessions: Opened[] = [];
  const outcomes: TurnOutcome[] = [];
  let gate: Promise<void> = Promise.resolve();
  const harness: Harness = {
    id: "claude",
    probe: async () => ({ id: "claude", label: "Fixture", status: "ready", models: [{ id: "fixture", label: "Fixture" }] }),
    open: async (options) => {
      await gate;
      const sent = vi.fn(async (_text: string, _model: string, _emit: Emit) => outcomes.shift() ?? { status: "completed" as const });
      const session: HarnessSession = { resume: cursor, send: sent, respond() {}, interrupt: async () => {}, close: async () => {} };
      sessions.push({ options, sent });
      return session;
    },
  };
  /** The app starting up: a new host over the same chats, with the instructions of the version now running. */
  const start = async (instructions: string) => {
    for (const host of hosts.splice(0)) await host.stop();
    const host = new AgentHost({ store, harnesses: [harness], env: Promise.resolve({ env: {}, extraDirs: [] }), mcp: null, version: "test", instructions });
    hosts.push(host);
    await host.start();
    return host;
  };
  return { store, sessions, outcomes, start, hold: (next: Promise<void>) => { gate = next; } };
}
const sentText = (opened: Opened | undefined, call = 0) => opened?.sent.mock.calls[call]?.[0] as string;
async function idle(host: AgentHost, chatId: string) {
  await vi.waitFor(async () => expect((await host.handle(connection, "chats.open", { chatId })).chat.status).toBe("idle"));
}
afterEach(async () => {
  vi.restoreAllMocks();
  events.length = 0;
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("sends a new chat's first message as written and records the instructions it started with", async () => {
  const { store, sessions, start } = await setup();
  const host = await start("Version one.");
  const { chatId } = await host.handle(connection, "turn.send", input);
  await vi.waitFor(() => expect(sessions[0]?.sent).toHaveBeenCalledOnce());
  expect(sentText(sessions[0])).toBe("first");
  await idle(host, chatId);
  expect((await store.readMeta(chatId))?.instructionsHash).toMatch(/^[0-9a-f]{16}$/);
});

it("adds nothing when the instructions of a resumed chat have not changed", async () => {
  const { sessions, start } = await setup();
  const first = await start("Version one.");
  const { chatId } = await first.handle(connection, "turn.send", input);
  await idle(first, chatId);

  const restarted = await start("Version one.");
  await restarted.handle(connection, "turn.send", { ...input, chatId, text: "second" });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  expect(sessions[1]!.options.resume).toEqual(cursor);
  expect(sentText(sessions[1])).toBe("second");
});

it("gives a resumed chat the current instructions with its next message once the app has changed them", async () => {
  const { sessions, start } = await setup();
  const first = await start("Version one.");
  const { chatId } = await first.handle(connection, "turn.send", input);
  await idle(first, chatId);

  const updated = await start(`Version two. ${MEDIA}`);
  await updated.handle(connection, "turn.send", { ...input, chatId, text: "grab the jump footage" });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  const text = sentText(sessions[1]);
  expect(text.startsWith("<system-reminder>")).toBe(true);
  expect(text).toContain(MEDIA);
  expect(text).toContain("ToolSearch");
  expect(text.endsWith("</system-reminder>\n\ngrab the jump footage")).toBe(true);
  // The session is opened with the current instructions too, which a provider that honours them uses.
  expect(sessions[1]!.options.instructions).toContain(MEDIA);

  // Told once: the next message in the same session, and the one after another restart, carry nothing.
  await idle(updated, chatId);
  await updated.handle(connection, "turn.send", { ...input, chatId, text: "and again" });
  await vi.waitFor(() => expect(sessions[1]!.sent).toHaveBeenCalledTimes(2));
  expect(sentText(sessions[1], 1)).toBe("and again");
  await idle(updated, chatId);

  const restarted = await start(`Version two. ${MEDIA}`);
  await restarted.handle(connection, "turn.send", { ...input, chatId, text: "after a restart" });
  await vi.waitFor(() => expect(sessions[2]?.sent).toHaveBeenCalledOnce());
  expect(sentText(sessions[2])).toBe("after a restart");
});

it("shows the user's own words in the chat, never the reminder", async () => {
  const { sessions, start } = await setup();
  const first = await start("Version one.");
  const { chatId } = await first.handle(connection, "turn.send", input);
  await idle(first, chatId);

  const updated = await start(`Version two. ${MEDIA}`);
  // Events reach the connections that have the chat open.
  await updated.handle(connection, "chats.open", { chatId });
  events.length = 0;
  await updated.handle(connection, "turn.send", { ...input, chatId, text: "grab the jump footage" });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  await idle(updated, chatId);

  const started = events.flatMap((message) => message.t === "event" && message.event.type === "turn.started" && message.event.user.kind === "user" ? [message.event.user.text] : []);
  expect(started).toEqual(["grab the jump footage"]);
  const shown = (await updated.handle(connection, "chats.open", { chatId })).items.flatMap((item) => item.kind === "user" ? [item.text] : []);
  expect(shown).toEqual(["first", "grab the jump footage"]);
});

it("treats a chat saved before the fingerprint existed as out of date, once", async () => {
  const { store, sessions, start } = await setup();
  const first = await start("Version one.");
  const { chatId } = await first.handle(connection, "turn.send", input);
  await idle(first, chatId);
  const { instructionsHash: _forgotten, ...legacy } = (await store.readMeta(chatId))!;
  await store.writeMeta(legacy);

  const restarted = await start("Version one.");
  await restarted.handle(connection, "turn.send", { ...input, chatId, text: "second" });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  expect(sentText(sessions[1])).toContain("<system-reminder>");
  await idle(restarted, chatId);

  const again = await start("Version one.");
  await again.handle(connection, "turn.send", { ...input, chatId, text: "third" });
  await vi.waitFor(() => expect(sessions[2]?.sent).toHaveBeenCalledOnce());
  expect(sentText(sessions[2])).toBe("third");
});

it("is still owed the instructions after a message that failed", async () => {
  const { sessions, outcomes, start } = await setup();
  const first = await start("Version one.");
  const { chatId } = await first.handle(connection, "turn.send", input);
  await idle(first, chatId);

  const updated = await start(`Version two. ${MEDIA}`);
  outcomes.push({ status: "failed", error: "The provider dropped the request" });
  await updated.handle(connection, "turn.send", { ...input, chatId, text: "try this" });
  await vi.waitFor(() => expect(sessions[1]?.sent).toHaveBeenCalledOnce());
  await idle(updated, chatId);
  await updated.handle(connection, "turn.send", { ...input, chatId, text: "try this again" });
  await vi.waitFor(() => expect(sessions[1]!.sent).toHaveBeenCalledTimes(2));
  expect(sentText(sessions[1], 1)).toContain(MEDIA);
  expect(sentText(sessions[1], 1).endsWith("try this again")).toBe(true);
  await idle(updated, chatId);

  await updated.handle(connection, "turn.send", { ...input, chatId, text: "and once more" });
  await vi.waitFor(() => expect(sessions[1]!.sent).toHaveBeenCalledTimes(3));
  expect(sentText(sessions[1], 2)).toBe("and once more");
});

it("is still owed the instructions when Stop comes before the message goes out", async () => {
  const { sessions, start, hold } = await setup();
  const first = await start("Version one.");
  const { chatId } = await first.handle(connection, "turn.send", input);
  await idle(first, chatId);

  const updated = await start(`Version two. ${MEDIA}`);
  let release!: () => void;
  hold(new Promise<void>((resolve) => { release = resolve; }));
  await updated.handle(connection, "turn.send", { ...input, chatId, text: "never sent" });
  const stopped = updated.handle(connection, "turn.interrupt", { chatId });
  release();
  await stopped;
  await idle(updated, chatId);
  expect(sessions[1]!.sent).not.toHaveBeenCalled();

  await updated.handle(connection, "turn.send", { ...input, chatId, text: "sent now" });
  await vi.waitFor(() => expect(sessions[1]!.sent).toHaveBeenCalledOnce());
  expect(sentText(sessions[1])).toContain(MEDIA);
  expect(sentText(sessions[1]).endsWith("sent now")).toBe(true);
});
