/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One question about one media item, asked through Google's Interactions API
// (`POST /v1beta/interactions`), the interface Google recommends for new work.
// Every request carries `store: false`, so Google keeps no copy of the
// question or the answer once it has replied (by default it holds them for a
// day on a free key and 55 days on a paid one). The call is synchronous: a
// stored interaction is what background execution needs, and none is wanted.

import { redactKey } from "./store";
import { GEMINI_API, GeminiError, errorDetail, httpError, networkError } from "./files";

/** The media item a question is about: a video or audio file Google holds, or a public YouTube link. */
export type GeminiMediaPart =
  | { type: "video"; uri: string; mimeType?: string; processing?: GeminiProcessing }
  | { type: "audio"; uri: string; mimeType: string };

/** How Google looks at a video: `agentic` lets the model choose where to look; static samples a frame a second, optionally within a window. */
export type GeminiProcessing = "agentic" | { type: "static"; startOffset?: number; endOffset?: number };

export type AskRequest = {
  model: string;
  media: GeminiMediaPart;
  /** The question and the rules for the answer; placed after the media, as Google advises. */
  text: string;
};

export type AskResult = {
  text: string;
  totalTokens?: number;
  /** Google stopped before the answer was whole (its output limit). */
  incomplete: boolean;
};

export type InteractionsOptions = {
  key: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  base?: string;
  /** How long Google may take to answer. */
  timeoutMs?: number;
};

/** The default wait for an answer: long videos think for minutes. */
export const ASK_TIMEOUT_MS = 10 * 60_000;

/** Seconds as Google writes an offset: `90s`, `10.5s`. */
export function offsetString(seconds: number): string {
  const value = Math.max(0, seconds);
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))}s`;
}

type Part = { type: string; text?: unknown };
type Step = { type?: unknown; content?: unknown };
type Interaction = { status?: unknown; steps?: unknown; usage?: { total_tokens?: unknown }; error?: { code?: unknown; message?: unknown } };

/** The request body for a call: media first, then the text. */
export function requestBody(request: AskRequest): Record<string, unknown> {
  const media = request.media;
  const part: Record<string, unknown> = { type: media.type, uri: media.uri };
  if (media.mimeType) part.mime_type = media.mimeType;
  if (media.type === "video" && media.processing !== undefined) {
    const processing = media.processing;
    part.processing = processing === "agentic" ? "agentic" : {
      type: "static",
      ...(processing.startOffset !== undefined ? { start_offset: offsetString(processing.startOffset) } : {}),
      ...(processing.endOffset !== undefined ? { end_offset: offsetString(processing.endOffset) } : {}),
    };
  }
  return { model: request.model, store: false, input: [part, { type: "text", text: request.text }] };
}

/** The answer text in a finished interaction: every text part of every `model_output` step, in order. */
export function answerText(interaction: Interaction): string {
  const steps = Array.isArray(interaction.steps) ? (interaction.steps as Step[]) : [];
  const out: string[] = [];
  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const part of step.content as Part[]) if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) out.push(part.text);
  }
  return out.join("\n").trim();
}

export class GeminiInteractions {
  private readonly options: InteractionsOptions;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: InteractionsOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async ask(request: AskRequest, signal: AbortSignal): Promise<AskResult> {
    const key = await this.options.key();
    if (!key) throw new GeminiError("auth", "No Gemini key is saved. Add one in Settings.");
    const limit = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? ASK_TIMEOUT_MS)]);
    // Nothing is sent for a call that was canceled while it waited.
    if (limit.aborted) throw networkError(limit.reason, key, limit);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.options.base ?? GEMINI_API}/v1beta/interactions`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(requestBody(request)),
        signal: limit,
        redirect: "error",
      });
      text = await response.text();
    } catch (error) {
      throw networkError(error, key, limit);
    }
    if (!response.ok) throw httpError(response.status, errorDetail(text), key);
    let interaction: Interaction;
    try {
      interaction = JSON.parse(text) as Interaction;
    } catch {
      throw new GeminiError("response", "Google answered in a way this version of Blackout can't read.");
    }
    const status = typeof interaction.status === "string" ? interaction.status : undefined;
    if (interaction.error || status === "failed" || status === "cancelled") {
      const detail = typeof interaction.error?.message === "string" ? interaction.error.message : typeof interaction.error?.code === "string" ? interaction.error.code : status;
      throw new GeminiError("rejected", `Google could not answer this one (${redactKey(String(detail), key).slice(0, 300)}).`);
    }
    const answer = answerText(interaction);
    if (!answer) throw new GeminiError("response", `Google sent no answer text${status ? ` (status ${status})` : ""}.`);
    const total = interaction.usage?.total_tokens;
    return { text: answer, ...(typeof total === "number" ? { totalTokens: total } : {}), incomplete: status === "incomplete" };
  }
}
