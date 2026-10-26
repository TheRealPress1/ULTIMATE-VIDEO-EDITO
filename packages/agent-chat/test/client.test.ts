/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatClient } from "../src/client";
import type { AgentChatClientOptions } from "../src/client";
import type { ChatSnapshot, ClientMsg, HostMsg } from "../src/protocol";

class TestSocket {
  static instances: TestSocket[] = [];
  readonly OPEN = 1;
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: ClientMsg[] = [];
  sendError: Error | null = null;

  constructor(url: string) {
    this.url = url;
    TestSocket.instances.push(this);
  }

  open(): void {
    this.readyState = this.OPEN;
    this.onopen?.();
  }

  close(): void {
    // Browsers deliver onclose later; explicit client.close() must settle
    // requests without relying on that notification.
    this.readyState = 2;
  }

  disconnected(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  send(raw: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(JSON.parse(raw) as ClientMsg);
  }

  receive(message: HostMsg): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const clients: AgentChatClient[] = [];

function client(options: Partial<AgentChatClientOptions> = {}): AgentChatClient {
  const result = new AgentChatClient({
    resolveEndpoint: async () => "ws://agent.local",
    WebSocket: TestSocket as unknown as typeof WebSocket,
    minBackoffMs: 10,
    maxBackoffMs: 40,
    ...options,
  });
  clients.push(result);
  return result;
}

async function connect(result: AgentChatClient): Promise<TestSocket> {
  result.connect();
  await Promise.resolve();
  const socket = TestSocket.instances.at(-1)!;
  socket.open();
  return socket;
}

function snapshot(seq: number): ChatSnapshot {
  return {
    chat: { id: "chat", projectId: "project", title: "Test", harness: "claude", model: "test", status: "idle", createdAt: 1, updatedAt: 1 },
    items: [],
    seq,
    pending: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  TestSocket.instances = [];
});

afterEach(() => {
  for (const result of clients.splice(0)) result.close();
  vi.useRealTimers();
});

describe("agent chat client connection lifecycle", () => {
  it("rejects every pending request immediately on explicit close and clears their deadlines", async () => {
    const result = client();
    const socket = await connect(result);
    const first = result.request("harnesses.list", {}).catch((error: unknown) => error);
    const second = result.request("chats.list", { projectId: "project" }).catch((error: unknown) => error);

    result.close();

    expect(await first).toMatchObject({ code: "disconnected" });
    expect(await second).toMatchObject({ code: "disconnected" });
    expect(vi.getTimerCount()).toBe(0);
    expect(result.state).toBe("closed");
    socket.disconnected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(TestSocket.instances).toHaveLength(1);
  });

  it("ignores a stale endpoint resolution after close and reconnect", async () => {
    const old = Promise.withResolvers<string | null>();
    const resolveEndpoint = vi.fn<AgentChatClientOptions["resolveEndpoint"]>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce("ws://new-agent.local");
    const result = client({ resolveEndpoint });
    result.connect();
    result.close();
    const current = await connect(result);

    old.resolve("ws://old-agent.local");
    await Promise.resolve();

    expect(TestSocket.instances).toEqual([current]);
    expect(current.url).toBe("ws://new-agent.local");
    expect(result.state).toBe("open");
    const pending = result.request("harnesses.list", {});
    current.receive({ t: "res", id: current.sent.at(-1)!.id, ok: true, data: [] });
    expect(await pending).toEqual([]);
  });

  it("does not schedule a stale unavailable endpoint over a new connection", async () => {
    const old = Promise.withResolvers<string | null>();
    const result = client({ resolveEndpoint: vi.fn<AgentChatClientOptions["resolveEndpoint"]>()
      .mockReturnValueOnce(old.promise).mockResolvedValueOnce("ws://new-agent.local") });
    result.connect();
    result.close();
    await connect(result);

    old.reject(new Error("old host stopped"));
    await Promise.resolve();

    expect(result.state).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a request deadline when sending throws", async () => {
    const result = client();
    const socket = await connect(result);
    socket.sendError = new Error("socket send failed");

    await expect(result.request("harnesses.list", {})).rejects.toThrow("socket send failed");

    expect(vi.getTimerCount()).toBe(0);
    socket.sendError = null;
    const next = result.request("harnesses.list", {});
    socket.receive({ t: "res", id: socket.sent.at(-1)!.id, ok: true, data: [] });
    expect(await next).toEqual([]);
  });

  it("rejects disconnected work and reopens subscriptions on the next socket", async () => {
    const result = client();
    const listener = vi.fn();
    result.open("chat", listener);
    const first = await connect(result);
    first.receive({ t: "res", id: first.sent[0]!.id, ok: true, data: snapshot(3) });
    await Promise.resolve();
    const pending = result.request("harnesses.list", {}).catch((error: unknown) => error);

    first.disconnected();
    expect(await pending).toMatchObject({ code: "disconnected" });
    await vi.advanceTimersByTimeAsync(10);
    const second = TestSocket.instances[1]!;
    second.open();
    expect(second.sent).toEqual([expect.objectContaining({ method: "chats.open", params: { chatId: "chat" } })]);
    second.receive({ t: "res", id: second.sent[0]!.id, ok: true, data: snapshot(7) });
    await Promise.resolve();
    second.receive({ t: "event", chatId: "chat", seq: 6, event: { type: "item.delta", itemId: "item", text: "old" } });
    second.receive({ t: "event", chatId: "chat", seq: 8, event: { type: "item.delta", itemId: "item", text: "new" } });

    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      { type: "snapshot", snapshot: snapshot(3) },
      { type: "snapshot", snapshot: snapshot(7) },
      { type: "event", seq: 8, event: { type: "item.delta", itemId: "item", text: "new" } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not deliver a settled snapshot after its socket closes", async () => {
    const result = client();
    const listener = vi.fn();
    result.open("chat", listener);
    const first = await connect(result);
    first.receive({ t: "res", id: first.sent[0]!.id, ok: true, data: snapshot(1) });
    result.close();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    const second = await connect(result);
    second.receive({ t: "res", id: second.sent[0]!.id, ok: true, data: snapshot(2) });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "snapshot", snapshot: snapshot(2) });
  });

  it("does not remove a replacement subscription when an old open fails", async () => {
    const result = client();
    const socket = await connect(result);
    result.open("chat", vi.fn());
    const listener = vi.fn();
    result.open("chat", listener);
    socket.receive({ t: "res", id: socket.sent[0]!.id, ok: false, error: { code: "not-found", message: "old chat unavailable" } });
    await Promise.resolve();

    expect(result.subscribed("chat")).toBe(true);
    socket.receive({ t: "res", id: socket.sent[1]!.id, ok: true, data: snapshot(1) });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "snapshot", snapshot: snapshot(1) });
  });

  it("ignores a late close notification from an old socket after reconnect", async () => {
    const result = client();
    const first = await connect(result);
    result.close();
    const second = await connect(result);
    const pending = result.request("harnesses.list", {});

    first.disconnected();
    second.receive({ t: "res", id: second.sent[0]!.id, ok: true, data: [] });

    expect(await pending).toEqual([]);
    expect(result.state).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replays newer events that arrive before the snapshot continuation runs", async () => {
    const result = client();
    const socket = await connect(result);
    const listener = vi.fn();
    result.open("chat", listener);
    socket.receive({ t: "event", chatId: "chat", seq: 3, event: { type: "item.delta", itemId: "item", text: "already in snapshot" } });
    socket.receive({ t: "res", id: socket.sent[0]!.id, ok: true, data: snapshot(3) });
    // Same read/stack: the request resolves, but openOne has not resumed yet.
    socket.receive({ t: "event", chatId: "chat", seq: 4, event: { type: "item.delta", itemId: "item", text: "new" } });
    socket.receive({ t: "event", chatId: "chat", seq: 5, event: { type: "turn.completed", turnId: "turn", status: "completed" } });
    await Promise.resolve();
    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      { type: "snapshot", snapshot: snapshot(3) },
      { type: "event", seq: 4, event: { type: "item.delta", itemId: "item", text: "new" } },
      { type: "event", seq: 5, event: { type: "turn.completed", turnId: "turn", status: "completed" } },
    ]);
  });

  it("drops buffered events from a disconnected socket and a replaced subscription", async () => {
    const result = client();
    const first = await connect(result);
    const removed = vi.fn();
    result.open("chat", removed);
    first.receive({ t: "event", chatId: "chat", seq: 9, event: { type: "item.delta", itemId: "item", text: "stale" } });
    const listener = vi.fn();
    result.open("chat", listener);
    first.receive({ t: "event", chatId: "chat", seq: 10, event: { type: "item.delta", itemId: "item", text: "old socket" } });
    first.disconnected();
    await vi.advanceTimersByTimeAsync(10);
    const second = TestSocket.instances.at(-1)!;
    second.open();
    second.receive({ t: "res", id: second.sent[0]!.id, ok: true, data: snapshot(3) });
    await Promise.resolve();
    expect(removed).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "snapshot", snapshot: snapshot(3) });
  });

  it.each(["events", "bytes"])("resynchronizes instead of retaining an oversized %s buffer", async (limit) => {
    const result = client();
    const socket = await connect(result);
    const listener = vi.fn();
    result.open("chat", listener);
    if (limit === "events") {
      for (let seq = 1; seq <= 257; seq++) socket.receive({ t: "event", chatId: "chat", seq, event: { type: "item.delta", itemId: "item", text: "x" } });
    } else {
      socket.receive({ t: "event", chatId: "chat", seq: 257, event: { type: "item.delta", itemId: "item", text: "x".repeat(1024 * 1024) } });
    }
    socket.receive({ t: "res", id: socket.sent[0]!.id, ok: true, data: snapshot(0) });
    await Promise.resolve();
    expect(socket.sent).toHaveLength(2);
    socket.receive({ t: "res", id: socket.sent[1]!.id, ok: true, data: snapshot(257) });
    socket.receive({ t: "event", chatId: "chat", seq: 258, event: { type: "turn.completed", turnId: "turn", status: "completed" } });
    await Promise.resolve();
    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      { type: "snapshot", snapshot: snapshot(0) },
      { type: "snapshot", snapshot: snapshot(257) },
      { type: "event", seq: 258, event: { type: "turn.completed", turnId: "turn", status: "completed" } },
    ]);
  });
});
