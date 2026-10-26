/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the host asks of a harness, and what every adapter has in common:
// the question flow, the item ids, and the truncation of tool output.
// Questions are the model asking the user; tool permissions never become
// cards (see automatic-policy.ts).

import { randomUUID } from "node:crypto";

import type {
  ChatEvent,
  HarnessId,
  HarnessInfo,
  Item,
  PendingRequest,
  Question,
  RequestResponse,
  ToolImage,
  TurnStatus,
} from "../protocol";
import type { HostEnv } from "./env";

export type ResumeCursor = { claude: { sessionId: string } } | { codex: { threadId: string } };

export type McpConfig = { name: string; url: string };

export type Emit = (event: ChatEvent) => void;

export type OpenOptions = {
  cwd: string;
  model: string;
  resume?: ResumeCursor;
  mcp: McpConfig | null;
  instructions?: string;
  env: HostEnv;
  /** The first turn's emitter: for notices about how the session came up. */
  emit: Emit;
  /** Await after the provider confirms a resumable session, before advancing its stream. */
  onResume?: (cursor: ResumeCursor) => Promise<void>;
  /**
   * The host's chat store (every project's transcripts and checkpoints).
   * Kept from the session's file tools and shell, wherever the app keeps it.
   */
  dataDir?: string;
};

/** How a turn ended. The host turns it into `turn.completed`. */
export type TurnOutcome = { status: TurnStatus; error?: string };

export interface HarnessSession {
  /** Only a provider-confirmed cursor; null before the first session acknowledgment. */
  readonly resume: ResumeCursor | null;
  /** Runs one turn. Resolves when the turn has ended, whatever the outcome. */
  send(text: string, model: string, emit: Emit): Promise<TurnOutcome>;
  /** Answers (or skips, or cancels) a pending question. */
  respond(requestId: string, response: RequestResponse): void;
  /** Ends the running turn. Resolves once `send` has. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface Harness {
  readonly id: HarnessId;
  probe(env: HostEnv, signal: AbortSignal): Promise<HarnessInfo>;
  open(options: OpenOptions): Promise<HarnessSession>;
}

/** Tool output kept per item, so a transcript never carries a whole file. */
export const DETAIL_MAX = 2048;

export function truncateDetail(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= DETAIL_MAX) return text;
  return text.slice(0, DETAIL_MAX) + "…";
}

/**
 * The largest image (as base64) kept per tool result, and how many. Images
 * ride inline in the transcript, which is replayed whenever a chat opens,
 * so a capture is fine but a wall of full-size renders is not.
 */
export const IMAGE_MAX = 512 * 1024;
export const IMAGES_MAX = 8;

/**
 * Splits a tool result's parts into the text shown and the images kept:
 * text parts join with newlines, images within the cap ride along, and
 * anything else (or an image over the cap) leaves a `[type]` marker.
 */
export function collectResult(parts: Array<{ type: string; text?: string; source?: unknown }>): { output?: string; images?: ToolImage[] } {
  const lines: string[] = [];
  const images: ToolImage[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      lines.push(part.text ?? "");
      continue;
    }
    const image = part.type === "image" ? base64Image(part.source) : null;
    if (image && image.data.length <= IMAGE_MAX && images.length < IMAGES_MAX) {
      images.push(image);
      continue;
    }
    lines.push(`[${part.type}]`);
  }
  const output = truncateDetail(lines.join("\n").trim() || undefined);
  return { ...(output ? { output } : {}), ...(images.length ? { images } : {}) };
}

function base64Image(source: unknown): ToolImage | null {
  if (!source || typeof source !== "object") return null;
  const { type, media_type: mediaType, data } = source as Record<string, unknown>;
  return type === "base64" && typeof mediaType === "string" && typeof data === "string" ? { mediaType, data } : null;
}

export function newItemId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

/** A one-line summary of a tool's input, for the tool row. */
export function summarizeInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return firstLine(input);
  if (typeof input !== "object") return String(input);
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "prompt", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return firstLine(value);
  }
  try {
    return firstLine(JSON.stringify(input));
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 160 ? line.slice(0, 159) + "…" : line;
}

/** `mcp__diffusion__capture` → "capture"; anything else stays. */
export function toolTitle(name: string): string {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return mcp ? mcp[1]! : name;
}

/**
 * The question flow every adapter shares. `open` emits the request and
 * hands back a promise the host settles through `respond`; settling emits
 * `request.resolved` and records what was decided as a `question` item.
 */
export class QuestionBox {
  private readonly emit: Emit;
  private readonly open = new Map<string, { request: PendingRequest; resolve(response: RequestResponse): void; cleanup(): void }>();
  private activeId: string | null = null;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  get size(): number {
    return this.open.size;
  }

  ask(questions: Question[], signal?: AbortSignal): Promise<RequestResponse> {
    if (signal?.aborted) return Promise.resolve("cancel");
    const request: PendingRequest = { id: newItemId("q"), type: "question", questions };
    return new Promise<RequestResponse>((resolve) => {
      const abort = () => this.settle(request.id, "cancel");
      this.open.set(request.id, { request, resolve, cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      this.showNext();
    });
  }

  /** The UI has one pending card. Keep concurrent tool requests in order. */
  private showNext(): void {
    if (this.activeId !== null) return;
    const next = this.open.values().next().value;
    if (!next) return;
    this.activeId = next.request.id;
    this.emit({ type: "request.opened", request: next.request });
  }

  settle(requestId: string, response: RequestResponse): boolean {
    const entry = this.open.get(requestId);
    if (!entry) return false;
    this.open.delete(requestId);
    entry.cleanup();
    const visible = this.activeId === requestId;
    if (visible) {
      this.activeId = null;
      const outcome = response === "cancel" ? "cancel" : response === "skip" ? "skipped" : "answered";
      this.emit({ type: "request.resolved", requestId, outcome });
    }
    if (visible && response !== "cancel") {
      const item: Item = {
        id: requestId,
        kind: "question",
        questions: entry.request.questions,
        answers: response === "skip" ? null : response.answers,
      };
      this.emit({ type: "item.completed", item });
    }
    entry.resolve(response);
    this.showNext();
    return true;
  }

  cancelAll(): void {
    const entries = [...this.open.values()];
    this.open.clear();
    if (this.activeId !== null) this.emit({ type: "request.resolved", requestId: this.activeId, outcome: "cancel" });
    this.activeId = null;
    for (const entry of entries) {
      entry.cleanup();
      entry.resolve("cancel");
    }
  }
}

/** The instructions every chat appends, with the project folder filled in. */
export function chatInstructions(cwd: string, custom?: string, harness?: HarnessId): string {
  // Codex's command sandbox has no network (it cannot hide credential stores); Claude's can reach public hosts.
  // Codex's workspace-write sandbox cannot exclude subpaths or forbid
  // commands (app-server 0.162 offers no stable way), so inside the project
  // its delete and protected-name rules rest on these instructions alone:
  // Codex is declined only what its sandbox enforces, while Claude's hooks
  // also refuse shell deletes and credential reads.
  const automatic = harness === "codex"
    ? "Cutroom never shows permission prompts: project edits, cutroom tools and sandboxed commands run automatically; sandboxed commands have no network access. " +
      "Never delete files: no `rm`, `find -delete`, `unlink` or scripted deletes in commands, and no Delete File hunks in patches. " +
      "Never create, change or delete anything in `.cutroom`, `.git`, `.claude`, `.codex` or `.mcp.json`: `.cutroom` holds the project's version history and web-media ledger. " +
      "Leave unused files in place; media in `assets/` and `exports/` may be the only copy. " +
      "Writes outside the project and temporary folders, network access from commands and requests for extra permissions are declined automatically. "
    : "Cutroom never shows permission prompts: project edits, cutroom tools, web search/fetch and sandboxed commands (including network downloads) run automatically. " +
      "Actions outside that boundary are refused automatically with a reason — deleting files or running system commands from the shell, replacing files outside the project, reading credential stores. ";
  const base =
    `You are running in Cutroom's chat panel. The open project is at \`${cwd}\`. ` +
    "The `cutroom` MCP tools act on it live — use `capture`/`check` to verify edits. " +
    "For substantial editing, call `skills` to select and read the relevant UVE workflows; load only the guides needed. " +
    "Read `editing_style` for user-approved preferences; the current brief takes precedence. " +
    "Skills are guidance, not proof a service is configured or permission for paid/external actions. " +
    automatic +
    "Adapt (new file name, work inside the project) instead of retrying or asking for permission. " +
    "For images, video or audio from the web use `web_media_search` and `web_media_download`. " +
    "Ask the user only when the creative brief itself is ambiguous; never ask before publishing externally — publishing happens only through Cutroom's own approval queue, which agents cannot use.";
  return custom ? `${base}\n\n${custom}` : base;
}

/** The text a harness gets: the message, then the attached paths, one per line. */
export function withAttachments(text: string, attachments: string[] | undefined): string {
  if (!attachments || attachments.length === 0) return text;
  return `${text}\n\nAttached files and folders:\n${attachments.join("\n")}`;
}
