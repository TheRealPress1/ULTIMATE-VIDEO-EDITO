/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Codex through `codex app-server`: JSON-RPC over the child's stdio. The
// protocol is hand-typed here for the dozen methods and notifications we
// use; anything else is ignored. The MCP server is injected with a `-c`
// override so nothing is written to the user's config. Approvals never reach
// the user: the policy is "never", and any approval request that still
// arrives is decided automatically. Codex declines carry no message, so the
// guidance lives in the chat instructions and the cutroom tools' errors.
// The workspace-write sandbox can read the whole disk, credential stores
// included, and has no way to hide them, so its commands get no network:
// web media comes through the cutroom tools instead.

import { spawn } from "node:child_process";

import { HARNESS_LABELS } from "../protocol";
import { compareVersions, killTree, needsShell, parseVersion, quoteArg, resolveBinary } from "./env";
import { JsonRpcPeer, RpcError } from "./jsonrpc";
import { QuestionBox, newItemId, summarizeInput, truncateDetail } from "./harness";
import { auditAutomaticApproval, decideWrite } from "./automatic-policy";

import type { ChildProcess } from "node:child_process";
import type { HarnessInfo, Item, Question, RequestResponse } from "../protocol";
import type { HostEnv } from "./env";
import type { Emit, Harness, HarnessSession, McpConfig, OpenOptions, ResumeCursor, TurnOutcome } from "./harness";

const MIN_VERSION = "0.100.0";
const PROBE_TIMEOUT_MS = 15_000;

const STATIC_MODELS = [
  { id: "gpt-6-astra", label: "GPT-6-Astra" },
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
];

const CLIENT_NAME = "cutroom";

// The slices of the app-server protocol we read. Everything is optional on
// purpose: a field a newer Codex renamed must degrade, not throw.
type ThreadItem = {
  id?: string;
  type?: string;
  text?: string;
  summary?: string[] | string;
  content?: unknown;
  command?: string | string[];
  status?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  changes?: { path?: string; kind?: string | { type?: string; move_path?: string | null; movePath?: string | null } }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string | null;
  query?: string;
  message?: string;
};

type ItemNotification = { threadId?: string; turnId?: string; item?: ThreadItem };
type DeltaNotification = { threadId?: string; turnId?: string; itemId?: string; delta?: string };
type TurnCompleted = { threadId?: string; turn?: { id?: string; status?: string; error?: { message?: string } | string | null } };
type ErrorNotification = { threadId?: string; turnId?: string; error?: { message?: string } | string; willRetry?: boolean };
type UserInputRequest = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  questions?: { id?: string; header?: string; question?: string; isOther?: boolean; isSecret?: boolean; options?: { label?: string; description?: string }[] | null }[];
};

const errorText = (error: { message?: string } | string | null | undefined): string | undefined =>
  typeof error === "string" ? error : error?.message;

function threadIdOf(result: unknown): string {
  const record = (result ?? {}) as { thread?: { id?: unknown; ephemeral?: unknown }; threadId?: unknown; id?: unknown };
  if (record.thread?.ephemeral === true) throw new Error("Codex returned a temporary thread that cannot be recovered after restart");
  // Resume uses thread.id, not the session-tree root in thread.sessionId.
  const id = record.thread?.id ?? record.threadId ?? record.id;
  if (typeof id !== "string" || !id || id.length > 1024 || /[\s\x00-\x1f\x7f]/u.test(id)) {
    throw new Error("Codex did not return a valid thread id; the previous conversation was left unchanged");
  }
  return id;
}

function spawnAppServer(binary: string, cwd: string, env: Record<string, string>, mcp: McpConfig | null): ChildProcess {
  const args = ["app-server", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false"];
  if (mcp) {
    // Codex splits override keys on dots; TOML quotes become literal name
    // characters here. Validate the segment and quote only the value.
    if (!/^[a-zA-Z0-9_-]+$/.test(mcp.name)) throw new Error("Invalid MCP server name: use letters, numbers, underscores, or hyphens");
    args.push(
      "-c", `mcp_servers.${mcp.name}.url=${JSON.stringify(mcp.url)}`,
      "-c", `mcp_servers.${mcp.name}.enabled=true`,
      "-c", `mcp_servers.${mcp.name}.required=true`,
      // Long local interviews checkpoint between sections and remain cancelable.
      "-c", `mcp_servers.${mcp.name}.tool_timeout_sec=14400`,
      // Under approval policy "never", a tool call that needs approval is
      // refused. Cutroom's tools enforce their own safety, so approve them.
      "-c", `mcp_servers.${mcp.name}.default_tools_approval_mode=${JSON.stringify("approve")}`,
    );
  }
  const shell = needsShell(binary);
  return spawn(shell ? `"${binary}"` : binary, shell ? args.map(quoteArg) : args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
}

async function initialize(peer: JsonRpcPeer, version: string): Promise<{ version?: string }> {
  const result = (await peer.request("initialize", {
    clientInfo: { name: CLIENT_NAME, title: "Cutroom", version },
    capabilities: { experimentalApi: true },
  })) as { userAgent?: string };
  peer.notify("initialized");
  return { version: parseVersion(result.userAgent ?? null) };
}

type Turn = {
  id: string | null;
  emit: Emit;
  resolve(outcome: TurnOutcome): void;
  items: Map<string, Item>;
  approvalItems: Map<string, ThreadItem>;
};

class CodexSession implements HarnessSession {
  resume: ResumeCursor;
  private readonly child: ChildProcess;
  private readonly peer: JsonRpcPeer;
  private readonly options: OpenOptions;
  private threadId: string;
  private turn: Turn | null = null;
  private questions: QuestionBox | null = null;
  private readonly pendingRequests = new Map<string | number, AbortController>();
  private interrupting = false;
  private closed = false;

  constructor(child: ChildProcess, peer: JsonRpcPeer, threadId: string, options: OpenOptions) {
    this.options = options;
    this.child = child;
    this.peer = peer;
    this.threadId = threadId;
    this.resume = { codex: { threadId } };
    peer.onNotification = (method, params) => this.onNotification(method, params);
    peer.onRequest = (method, params, requestId) => this.onRequest(method, params, requestId);
    peer.onClose = () => {
      this.closed = true;
      this.finish(this.interrupting ? { status: "interrupted" } : { status: "failed", error: "Codex exited" });
    };
  }

  static async start(options: OpenOptions, binary: string, version: string): Promise<CodexSession> {
    const child = spawnAppServer(binary, options.cwd, options.env.env, options.mcp);
    const peer = new JsonRpcPeer(child);
    try {
      await initialize(peer, version);
      const config = await CodexSession.editorConfig(peer, options);
      const resumeId = options.resume && "codex" in options.resume ? options.resume.codex.threadId : null;
      const threadId = await CodexSession.openThread(peer, options, resumeId, config);
      const session = new CodexSession(child, peer, threadId, options);
      // Thread creation/resumption has been acknowledged. Save its identity
      // before the caller can start the first turn, including after fallback.
      await options.onResume?.(session.resume);
      if (session.closed) throw new Error("Codex exited while saving its conversation. Retry to reconnect.");
      return session;
    } catch (error) {
      await killTree(child);
      throw error;
    }
  }

  private static async editorConfig(peer: JsonRpcPeer, options: OpenOptions): Promise<Record<string, unknown>> {
    const result = await peer.request<{ config?: { mcp_servers?: Record<string, unknown> } }>("config/read", {
      cwd: options.cwd, includeLayers: false,
    });
    // Codex merges MCP tables, so supplying only our server leaves global
    // connectors active. Disable those by name in this thread's overrides.
    // Auth, config files, and the user's other Codex sessions stay untouched.
    const config: Record<string, unknown> = {
      "features.apps": false,
      "features.plugins": false,
      "features.computer_use": false,
    };
    for (const name of Object.keys(result.config?.mcp_servers ?? {})) {
      if (name !== options.mcp?.name) config[`mcp_servers.${name}.enabled`] = false;
    }
    return config;
  }

  private static threadParams(options: OpenOptions, model: string, config: Record<string, unknown>) {
    return {
      cwd: options.cwd,
      model,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions: options.instructions,
      config,
    };
  }

  private static async openThread(peer: JsonRpcPeer, options: OpenOptions, resumeId: string | null, config: Record<string, unknown>): Promise<string> {
    const start = async (): Promise<string> => {
      return threadIdOf(await peer.request("thread/start", { ...CodexSession.threadParams(options, options.model, config), ephemeral: false }));
    };
    if (!resumeId) return start();
    try {
      return threadIdOf(await peer.request("thread/resume", { threadId: resumeId, ...CodexSession.threadParams(options, options.model, config) }));
    } catch (error) {
      if (!/not found|no such|unknown thread/i.test((error as Error)?.message ?? "")) throw error;
    }
    const id = await start();
    options.emit({
      type: "item.completed",
      item: { id: newItemId("n"), kind: "notice", level: "info", text: "Previous Codex session not found — started fresh" },
    });
    return id;
  }

  async send(text: string, model: string, emit: Emit): Promise<TurnOutcome> {
    if (this.turn) throw new Error("A turn is already running");
    if (this.closed) throw new Error("Codex exited");
    this.interrupting = false;
    this.questions = new QuestionBox(emit);
    return new Promise<TurnOutcome>((resolve, reject) => {
      this.turn = { id: null, emit, resolve, items: new Map(), approvalItems: new Map() };
      this.peer
        .request("turn/start", {
          threadId: this.threadId,
          input: [{ type: "text", text }],
          model,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite", writableRoots: [], networkAccess: false,
            excludeTmpdirEnvVar: false, excludeSlashTmp: false,
          },
        })
        .then((result) => {
          const record = (result ?? {}) as { turn?: { id?: string }; turnId?: string };
          if (this.turn) this.turn.id ??= record.turn?.id ?? record.turnId ?? null;
        })
        .catch((error: Error) => {
          this.turn = null;
          this.questions?.cancelAll();
          for (const controller of this.pendingRequests.values()) controller.abort();
          this.questions = null;
          reject(error);
        });
    });
  }

  private finish(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.questions?.cancelAll();
    for (const controller of this.pendingRequests.values()) controller.abort();
    this.questions = null;
    turn.resolve(outcome);
  }

  respond(requestId: string, response: RequestResponse): void {
    this.questions?.settle(requestId, response);
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    this.interrupting = true;
    this.questions?.cancelAll();
    const done = new Promise<void>((resolve) => {
      const previous = turn.resolve;
      turn.resolve = (outcome) => {
        previous(outcome);
        resolve();
      };
    });
    try {
      await this.peer.request("turn/interrupt", { threadId: this.threadId, turnId: turn.id });
    } catch {
      // The child is gone or never got the turn: finish it ourselves.
      this.finish({ status: "interrupted" });
    }
    // The server acknowledges with `turn/completed{interrupted}`; a Codex
    // that never sends it must not hang the chat.
    await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    this.finish({ status: "interrupted" });
  }

  async close(): Promise<void> {
    if (this.turn) await this.interrupt();
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // Already closed.
    }
    await killTree(this.child);
  }

  // -------------------------------------------------------------------
  // Notifications and requests from the server

  private toItem(raw: ThreadItem, completed: boolean): Item | null {
    const id = raw.id ?? newItemId("x");
    switch (raw.type) {
      case "agentMessage":
        return { id, kind: "assistant", text: raw.text ?? "" };
      case "reasoning": {
        const summary = Array.isArray(raw.summary) ? raw.summary.join("\n") : (raw.summary ?? "");
        const content = Array.isArray(raw.content) ? (raw.content as unknown[]).filter((part) => typeof part === "string").join("\n") : "";
        return { id, kind: "reasoning", text: summary || content || (raw.text ?? "") };
      }
      case "commandExecution": {
        const command = Array.isArray(raw.command) ? raw.command.join(" ") : (raw.command ?? "");
        return {
          id,
          kind: "tool",
          name: "commandExecution",
          title: "Run",
          detail: summarizeInput(command),
          ...(raw.aggregatedOutput ? { output: truncateDetail(raw.aggregatedOutput) } : {}),
          status: !completed ? "running" : raw.status === "failed" || (typeof raw.exitCode === "number" && raw.exitCode !== 0) ? "failed" : "done",
        };
      }
      case "fileChange": {
        const paths = (raw.changes ?? []).map((change) => change.path).filter((path): path is string => !!path);
        return {
          id,
          kind: "tool",
          name: "fileChange",
          title: "Edit",
          detail: paths.length ? summarizeInput(paths.join(", ")) : undefined,
          status: !completed ? "running" : raw.status === "failed" || raw.status === "declined" ? "failed" : "done",
        };
      }
      case "mcpToolCall": {
        const resultText = raw.error ? errorText(raw.error) : raw.result !== undefined ? safeStringify(raw.result) : undefined;
        return {
          id,
          kind: "tool",
          name: `mcp__${raw.server ?? "mcp"}__${raw.tool ?? "tool"}`,
          title: raw.tool ?? "tool",
          detail: summarizeInput(raw.arguments),
          ...(resultText ? { output: truncateDetail(resultText) } : {}),
          status: !completed ? "running" : raw.error || raw.status === "failed" ? "failed" : "done",
        };
      }
      case "webSearch":
        return { id, kind: "tool", name: "webSearch", title: "Search", detail: raw.query, status: completed ? "done" : "running" };
      case "error":
        return { id, kind: "notice", level: "error", text: raw.message ?? errorText(raw.error) ?? "Codex reported an error" };
      default:
        return null;
    }
  }

  private onNotification(method: string, params: unknown): void {
    const turn = this.turn;
    const context = (params ?? {}) as { threadId?: string; turnId?: string };
    if ((context.threadId !== undefined && context.threadId !== this.threadId) ||
      (context.turnId !== undefined && turn?.id && context.turnId !== turn.id)) return;
    switch (method) {
      case "item/started": {
        const raw = ((params ?? {}) as ItemNotification).item ?? {};
        const item = turn && this.toItem(raw, false);
        if (!turn || !item) return;
        if (raw.id && raw.type === "fileChange") turn.approvalItems.set(raw.id, raw);
        turn.items.set(item.id, item);
        turn.emit({ type: "item.started", item });
        return;
      }
      case "item/completed": {
        const item = turn && this.toItem(((params ?? {}) as ItemNotification).item ?? {}, true);
        if (!turn || !item) return;
        turn.approvalItems.delete(item.id);
        turn.items.delete(item.id);
        turn.emit({ type: "item.completed", item });
        return;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta } = (params ?? {}) as DeltaNotification;
        if (!turn || !itemId || !delta) return;
        if (!turn.items.has(itemId)) {
          const item: Item = method === "item/agentMessage/delta" ? { id: itemId, kind: "assistant", text: "" } : { id: itemId, kind: "reasoning", text: "" };
          turn.items.set(itemId, item);
          turn.emit({ type: "item.started", item });
        }
        turn.emit({ type: "item.delta", itemId, text: delta });
        return;
      }
      case "turn/completed": {
        const { turn: info } = (params ?? {}) as TurnCompleted;
        if (!turn) return;
        const status = info?.status;
        if (status === "interrupted" || this.interrupting) this.finish({ status: "interrupted" });
        else if (status === "failed") {
          const error = errorText(info?.error) ?? "Codex turn failed";
          turn.emit({ type: "item.completed", item: { id: newItemId("n"), kind: "notice", level: "error", text: error } });
          this.finish({ status: "failed", error });
        } else this.finish({ status: "completed" });
        return;
      }
      case "error": {
        const { error, willRetry } = (params ?? {}) as ErrorNotification;
        if (!turn || willRetry) return;
        const text = errorText(error) ?? "Codex reported an error";
        turn.emit({ type: "item.completed", item: { id: newItemId("n"), kind: "notice", level: "error", text } });
        return;
      }
      case "item/tool/requestUserInput/answered": {
        // Codex resolved the question itself: the card goes away.
        this.questions?.cancelAll();
        return;
      }
      case "serverRequest/resolved": {
        const { requestId } = (params ?? {}) as { requestId?: string | number };
        if (requestId !== undefined) this.pendingRequests.get(requestId)?.abort();
        return;
      }
      default:
        return;
    }
  }

  private async onRequest(method: string, params: unknown, requestId: string | number): Promise<unknown> {
    const controller = new AbortController();
    this.pendingRequests.set(requestId, controller);
    try {
      return await this.handleRequest(method, params, controller.signal);
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  private async handleRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const request = (params ?? {}) as Record<string, unknown>;
    // Never answer for a different thread or an already completed turn.
    const stale = !this.turn ||
      (request.threadId !== undefined && request.threadId !== this.threadId) ||
      (request.turnId !== undefined && !(method === "mcpServer/elicitation/request" && request.turnId === null) &&
        this.turn.id !== null && request.turnId !== this.turn.id);
    switch (method) {
      case "item/commandExecution/requestApproval":
        // Escalation out of the workspace-write sandbox is never granted.
        if (stale || signal.aborted) return { decision: "cancel" };
        auditAutomaticApproval("codex", "commandExecution", "deny", "project-sandbox");
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        return this.decideFileChange(request, stale, signal);
      case "item/permissions/requestApproval":
        // No network (the sandbox can read credential stores) and no file system beyond the sandbox roots.
        if (!stale) auditAutomaticApproval("codex", "permissions", "deny", "turn-permissions");
        return { permissions: {}, scope: "turn" };
      case "execCommandApproval":
      case "applyPatchApproval":
        // Legacy v1 callbacks: this client never opens v1 conversations.
        auditAutomaticApproval("codex", method, "deny", method === "execCommandApproval" ? "project-sandbox" : "project-file");
        return { decision: { denied: { rejection: "Cutroom runs commands and edits only inside the project sandbox and doesn't grant extra access." } } };
      case "item/tool/requestUserInput":
        return stale ? { answers: {} } : this.askUser((params ?? {}) as UserInputRequest, signal);
      case "mcpServer/elicitation/request":
        return stale ? { action: "cancel", content: null, _meta: null } : this.decideElicitation(request, signal);
      default:
        throw new RpcError({ code: -32601, message: `Unsupported request ${method}` });
    }
  }

  /** Accepts only additions and updates the shared write decision allows. */
  private async decideFileChange(request: Record<string, unknown>, stale: boolean, signal: AbortSignal): Promise<unknown> {
    if (stale || signal.aborted) return { decision: "cancel" };
    const turn = this.turn!;
    const item = typeof request.itemId === "string" ? turn.approvalItems.get(request.itemId) : undefined;
    const changes = item?.type === "fileChange" ? (item.changes ?? []) : [];
    const editable = changes.length > 0 && changes.every((change) => {
      const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
      const moved = typeof change.kind === "object" && (change.kind?.move_path || change.kind?.movePath);
      return (kind === "add" || kind === "update") && !moved;
    });
    const allowed = editable && (await Promise.all(changes.map((change) => decideWrite({
      cwd: this.options.cwd, path: change.path, grantRoot: request.grantRoot,
    })))).every((decision) => decision.allow);
    if (signal.aborted || this.turn !== turn || (item && turn.approvalItems.get(item.id!) !== item)) return { decision: "cancel" };
    auditAutomaticApproval("codex", "fileChange", allowed ? "allow" : "deny", "project-file");
    return { decision: allowed ? "accept" : "decline" };
  }

  /**
   * Native MCP tool-call confirmations for our server are accepted: the
   * cutroom tools enforce their own safety. Every other elicitation is
   * declined; ones that need input this chat cannot collect say so.
   */
  private async decideElicitation(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!this.turn || signal.aborted) return { action: "cancel", content: null, _meta: null };
    const schema = request.requestedSchema as { type?: unknown; properties?: unknown; required?: unknown } | undefined;
    const metadata = request._meta as { codex_approval_kind?: unknown } | null | undefined;
    const confirmation = request.mode === "form" && schema?.type === "object" &&
      schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties) &&
      (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0));
    const toolCall = metadata?.codex_approval_kind === "mcp_tool_call";
    const ours = Boolean(this.options.mcp) && request.serverName === this.options.mcp?.name;
    if (ours && (confirmation || toolCall)) {
      auditAutomaticApproval("codex", "mcpServer/elicitation", "allow", "local-editor-tool");
      return { action: "accept", content: {}, _meta: null };
    }
    auditAutomaticApproval("codex", "mcpServer/elicitation", "deny", ours ? "local-editor-tool" : "other-mcp");
    if (!confirmation && !toolCall) {
      const server = typeof request.serverName === "string" ? request.serverName : "An MCP server";
      const reason = request.mode === "url" ? "URL authorization" : "a form with unsupported required input";
      this.turn.emit({ type: "item.completed", item: {
        id: newItemId("n"), kind: "notice", level: "error",
        text: `${server} requested ${reason}. This chat cannot complete that request; the action was declined.`,
      } });
    }
    return { action: "decline", content: null, _meta: null };
  }

  private async askUser(request: UserInputRequest, signal: AbortSignal): Promise<unknown> {
    const questions: Question[] = (request.questions ?? []).map((entry, index) => ({
      id: entry.id ?? String(index),
      header: (entry.header ?? "").slice(0, 12),
      question: entry.question ?? "",
      options: (entry.options ?? []).map((option) => ({ label: option.label ?? "", description: option.description ?? "" })),
      multiSelect: false,
      allowOther: entry.isOther !== false,
      secret: entry.isSecret === true,
    }));
    const box = this.questions;
    const empty = { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [] }])) };
    if (!box || questions.length === 0) return empty;
    const response = await box.ask(questions, signal);
    if (response === "skip" || response === "cancel") return empty;
    return {
      answers: Object.fromEntries(questions.map((question) => [question.id, { answers: response.answers[question.id] ?? [] }])),
    };
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class CodexHarness implements Harness {
  readonly id = "codex" as const;
  private readonly version: string;

  constructor(version = "0.0.0") {
    this.version = version;
  }

  async probe(env: HostEnv, signal: AbortSignal): Promise<HarnessInfo> {
    const label = HARNESS_LABELS.codex;
    const binary = resolveBinary("codex", env);
    if (!binary) return { id: this.id, label, status: "not-installed", detail: "Install Codex, then reopen the picker", models: [] };

    const child = spawnAppServer(binary, process.cwd(), env.env, null);
    const peer = new JsonRpcPeer(child);
    const timer = setTimeout(() => void killTree(child), PROBE_TIMEOUT_MS);
    const onAbort = () => void killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { version } = await initialize(peer, this.version);
      const outdated = version && compareVersions(version, MIN_VERSION) < 0 ? `Update Codex (${version} is older than ${MIN_VERSION})` : undefined;
      const account = (await peer.request("account/read", { refreshToken: false })) as { account?: unknown; requiresOpenaiAuth?: boolean };
      if (!account.account && account.requiresOpenaiAuth) {
        return { id: this.id, label, status: "signed-out", detail: "Run `codex login` in a terminal", version, models: [] };
      }
      const list = (await peer.request("model/list", {})) as { data?: { id?: string; model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }[] };
      const models = (list.data ?? [])
        .filter((model) => !model.hidden && (model.id || model.model))
        .map((model) => ({ id: (model.id ?? model.model)!, label: model.displayName ?? (model.id ?? model.model)! }));
      const defaultModel = (list.data ?? []).find((model) => model.isDefault)?.id ?? models[0]?.id;
      return { id: this.id, label, status: "ready", detail: outdated, version, models: models.length ? models : STATIC_MODELS, defaultModel };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      if (/log ?in|not authenticated|unauthori[sz]ed/i.test(message)) {
        return { id: this.id, label, status: "signed-out", detail: "Run `codex login` in a terminal", models: [] };
      }
      return { id: this.id, label, status: "ready", detail: /exited/i.test(message) ? undefined : message, models: STATIC_MODELS, defaultModel: STATIC_MODELS[0]!.id };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void killTree(child);
    }
  }

  async open(options: OpenOptions): Promise<HarnessSession> {
    const binary = resolveBinary("codex", options.env);
    if (!binary) throw new Error("Codex is not installed");
    return CodexSession.start(options, binary, this.version);
  }
}
