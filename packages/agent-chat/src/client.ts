/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The browser side of the wire: one WebSocket, request/response by id,
// per-chat subscriptions, and reconnection with backoff. The endpoint is
// re-resolved on every attempt, which covers a host that came back on a
// new port. On reconnect every subscribed chat is re-opened, and its
// listener gets the fresh snapshot — there is no replay protocol.

import type {
  ChatEvent,
  ChatSnapshot,
  ChatSummary,
  ChatFoldersState,
  ClientMsg,
  HarnessInfo,
  HostError,
  HostMsg,
  Method,
  MethodParams,
  MethodResult,
} from "./protocol";

export type ConnectionState = "connecting" | "open" | "closed" | "unavailable";

export type ChatListener = (message: { type: "snapshot"; snapshot: ChatSnapshot } | { type: "event"; seq: number; event: ChatEvent }) => void;

export class AgentChatError extends Error {
  readonly code: HostError["code"] | "disconnected";

  constructor(code: AgentChatError["code"], message: string) {
    super(message);
    this.name = "AgentChatError";
    this.code = code;
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

type Subscription = {
  listener: ChatListener;
  /** Seq of the last snapshot delivered; events at or below it are skipped. */
  seq: number;
  /** Set once the snapshot has been delivered for the current socket. */
  opened: boolean;
  attempt: number;
  buffered: Extract<HostMsg, { t: "event" }>[];
  bufferedBytes: number;
  resnapshot: boolean;
};

export type AgentChatClientOptions = {
  /** Where the host is right now; null when there is none (web build without a host). */
  resolveEndpoint(): Promise<string | null>;
  /** For tests and Node: defaults to the global WebSocket. */
  WebSocket?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

const REQUEST_TIMEOUT_MS = 60_000;
const SNAPSHOT_BUFFER_EVENTS = 256;
const SNAPSHOT_BUFFER_BYTES = 1024 * 1024;

export class AgentChatClient {
  private readonly options: AgentChatClientOptions;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private subscriptions = new Map<string, Subscription>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private harnessListeners = new Set<(harnesses: HarnessInfo[]) => void>();
  private chatChangedListeners = new Set<(chat: ChatSummary) => void>();
  private chatFoldersListeners = new Set<(state: ChatFoldersState) => void>();
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionAttempt = 0;
  private stopped = true;
  private nextId = 0;
  private _state: ConnectionState = "closed";
  private _harnesses: HarnessInfo[] = [];

  constructor(options: AgentChatClientOptions) {
    this.options = options;
    this.backoff = options.minBackoffMs ?? 500;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get harnesses(): HarnessInfo[] {
    return this._harnesses;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }

  onHarnesses(listener: (harnesses: HarnessInfo[]) => void): () => void {
    this.harnessListeners.add(listener);
    return () => void this.harnessListeners.delete(listener);
  }

  onChatChanged(listener: (chat: ChatSummary) => void): () => void {
    this.chatChangedListeners.add(listener);
    return () => void this.chatChangedListeners.delete(listener);
  }

  onChatFoldersChanged(listener: (state: ChatFoldersState) => void): () => void {
    this.chatFoldersListeners.add(listener);
    return () => void this.chatFoldersListeners.delete(listener);
  }

  /** Starts connecting; idempotent. */
  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.attempt();
  }

  /** Closes the socket and stops reconnecting. Subscriptions are kept for a later `connect()`. */
  close(): void {
    this.stopped = true;
    this.connectionAttempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.failPending(new AgentChatError("disconnected", "Agent host connection closed"));
    for (const subscription of this.subscriptions.values()) this.resetSubscription(subscription);
    socket?.close();
    this.setState("closed");
  }

  /** Subscribes to a chat. The listener gets a snapshot first, then events; on reconnect, a snapshot again. */
  open(chatId: string, listener: ChatListener): () => void {
    const subscription: Subscription = { listener, seq: -1, opened: false, attempt: 0, buffered: [], bufferedBytes: 0, resnapshot: false };
    this.subscriptions.set(chatId, subscription);
    if (this._state === "open") void this.openOne(chatId, subscription);
    return () => {
      if (this.subscriptions.get(chatId) !== subscription) return;
      this.resetSubscription(subscription);
      this.subscriptions.delete(chatId);
      if (this._state === "open") void this.request("chats.close", { chatId }).catch(() => {});
    };
  }

  /** A subscription's listener applies the snapshot; this is what lets `turn.send` auto-subscribe a new chat. */
  subscribed(chatId: string): boolean {
    return this.subscriptions.has(chatId);
  }

  request<M extends Method>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.reject(new AgentChatError("disconnected", "Agent host is not connected"));
    }
    const id = String(++this.nextId);
    const message: ClientMsg = { t: "req", id, method, params };
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new AgentChatError("internal", `${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as MethodResult<M>);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    const attempt = ++this.connectionAttempt;
    this.setState("connecting");
    let url: string | null = null;
    try {
      url = await this.options.resolveEndpoint();
    } catch {
      url = null;
    }
    if (this.stopped || attempt !== this.connectionAttempt) return;
    if (!url) {
      this.setState("unavailable");
      this.scheduleReconnect();
      return;
    }
    const WS = this.options.WebSocket ?? globalThis.WebSocket;
    let socket: WebSocket;
    try {
      socket = new WS(url);
    } catch {
      this.setState("closed");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.backoff = this.options.minBackoffMs ?? 500;
      this.setState("open");
      for (const [chatId, subscription] of this.subscriptions) {
        void this.openOne(chatId, subscription);
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handle(String(event.data));
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending(new AgentChatError("disconnected", "Agent host disconnected"));
      for (const subscription of this.subscriptions.values()) this.resetSubscription(subscription);
      this.setState("closed");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // `onclose` follows and does the work.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attempt();
    }, delay);
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }

  private resetSubscription(subscription: Subscription): void {
    subscription.attempt += 1;
    subscription.opened = false;
    subscription.buffered = [];
    subscription.bufferedBytes = 0;
    subscription.resnapshot = false;
  }

  private async openOne(chatId: string, subscription: Subscription): Promise<void> {
    const socket = this.socket;
    this.resetSubscription(subscription);
    const attempt = subscription.attempt;
    const current = () => this.socket === socket && this.subscriptions.get(chatId) === subscription && subscription.attempt === attempt;
    try {
      const snapshot = await this.request("chats.open", { chatId });
      if (!current()) return;
      subscription.seq = snapshot.seq;
      subscription.listener({ type: "snapshot", snapshot });
      // The socket can deliver newer events before this awaited continuation,
      // even when its snapshot response arrived first on the wire. Replay only
      // those not already represented by the snapshot, preserving wire order.
      while (current() && !subscription.resnapshot && subscription.buffered.length) {
        const message = subscription.buffered.shift()!;
        if (message.seq <= subscription.seq) continue;
        subscription.seq = message.seq;
        subscription.listener({ type: "event", seq: message.seq, event: message.event });
      }
      if (!current()) return;
      if (subscription.resnapshot) {
        // A slow/large snapshot must not create an unbounded event queue.
        // Publish the valid snapshot, then request one covering the overflow.
        void this.openOne(chatId, subscription);
        return;
      }
      subscription.bufferedBytes = 0;
      subscription.opened = true;
    } catch (error) {
      // A deleted chat, or a socket that went away: the next reconnect retries, a
      // `not-found` means the subscription is dead.
      if (current()) {
        this.resetSubscription(subscription);
        if (error instanceof AgentChatError && error.code === "not-found") this.subscriptions.delete(chatId);
      }
    }
  }

  private handle(raw: string): void {
    let message: HostMsg;
    try {
      message = JSON.parse(raw) as HostMsg;
    } catch {
      return;
    }
    switch (message.t) {
      case "res": {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.data);
        else entry.reject(new AgentChatError(message.error.code, message.error.message));
        return;
      }
      case "event": {
        const subscription = this.subscriptions.get(message.chatId);
        if (!subscription) return;
        if (!subscription.opened) {
          if (subscription.resnapshot) return;
          if (subscription.buffered.length >= SNAPSHOT_BUFFER_EVENTS || subscription.bufferedBytes + raw.length > SNAPSHOT_BUFFER_BYTES) {
            subscription.buffered = [];
            subscription.bufferedBytes = 0;
            subscription.resnapshot = true;
          } else {
            subscription.buffered.push(message);
            subscription.bufferedBytes += raw.length;
          }
          return;
        }
        if (message.seq <= subscription.seq) return;
        subscription.seq = message.seq;
        subscription.listener({ type: "event", seq: message.seq, event: message.event });
        return;
      }
      case "harnesses": {
        this._harnesses = message.harnesses;
        for (const listener of this.harnessListeners) listener(message.harnesses);
        return;
      }
      case "chat.changed": {
        for (const listener of this.chatChangedListeners) listener(message.chat);
        return;
      }
      case "chatFolders.changed": {
        for (const listener of this.chatFoldersListeners) listener(message.state);
        return;
      }
    }
  }
}
