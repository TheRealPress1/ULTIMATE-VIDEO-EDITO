/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Google's Files API, the part Cutroom needs: put one local file where Gemini
// can read it, wait until it is usable, and delete it again. The key travels
// in a request header only, and every message that leaves here is scrubbed of
// it.

import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import { redactKey } from "./store";

export const GEMINI_API = "https://generativelanguage.googleapis.com";

export type GeminiErrorKind = "auth" | "quota" | "rejected" | "service" | "network" | "response" | "upload" | "timeout" | "canceled";

/** A failed call to Google, with a message that is safe to show: it never holds the key. */
export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly status?: number;
  constructor(kind: GeminiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

const HINTS: Record<GeminiErrorKind, string> = {
  auth: "Google refused the key. Check it in Settings, or make a new one at aistudio.google.com/apikey.",
  quota: "Google says this key is rate-limited or out of quota. Wait a minute, or check its plan.",
  rejected: "Google refused the request.",
  service: "Google had a server error. Try again shortly.",
  network: "Couldn't reach Google (generativelanguage.googleapis.com). Check the connection.",
  response: "Google answered in a way this version of Blackout can't read.",
  upload: "The clip couldn't be uploaded to Google or prepared there.",
  timeout: "Google took too long to answer.",
  canceled: "The call was canceled.",
};

/** The message inside a Google error body, whatever shape it came in (an array wraps some auth errors). */
export function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as unknown;
    const first = Array.isArray(data) ? data[0] : data;
    const message = (first as { error?: { message?: unknown } } | undefined)?.error?.message;
    if (typeof message === "string") return message;
  } catch { /* Not JSON: the text itself is the best there is. */ }
  return body;
}

/** The failure a response with this status stands for. `detail` is shortened and scrubbed of the key. */
export function httpError(status: number, detail: string, key?: string | null): GeminiError {
  const text = redactKey(detail.replace(/\s+/g, " ").trim(), key).slice(0, 400);
  // The Files API answers a malformed key with 400 "API key not valid", not 401. 402 is a prepaid balance that ran out.
  const kind: GeminiErrorKind = status === 401 || status === 403 || /api key/i.test(text) ? "auth" : status === 429 || status === 402 ? "quota" : status >= 500 ? "service" : "rejected";
  if (kind === "rejected" && status === 404 && /model/i.test(text)) {
    return new GeminiError(kind, `${HINTS.rejected} Google doesn't know that model: pick another in Settings. (404: ${text})`, status);
  }
  return new GeminiError(kind, kind === "rejected" || kind === "service" ? `${HINTS[kind]} (${status}: ${text || "no detail"})` : HINTS[kind], status);
}

/**
 * What a thrown error from `fetch`, a stream or a wait stands for. An aborted
 * `signal` decides it: fetch rejects with the abort's own reason, which is a
 * GeminiError when a job was canceled and a TimeoutError when a limit ran out.
 */
export function networkError(error: unknown, key?: string | null, signal?: AbortSignal): GeminiError {
  if (error instanceof GeminiError) return error;
  const cause = signal?.aborted ? signal.reason : error;
  if (cause instanceof GeminiError) return cause;
  const name = (cause as { name?: string } | null)?.name;
  if (name === "TimeoutError") return new GeminiError("timeout", HINTS.timeout);
  if (signal?.aborted || name === "AbortError") return new GeminiError("canceled", HINTS.canceled);
  const code = error as { cause?: { code?: string }; code?: string } | null;
  const reason = code?.cause?.code ?? code?.code;
  return new GeminiError("network", `${HINTS.network}${reason ? ` (${redactKey(String(reason), key)})` : ""}`);
}

export type UploadedFile = { name: string; uri: string; mimeType: string };

/** Sends `path` to `url` as the body of one POST, with the headers given, and answers with the response. Injected so tests don't need a network. */
export type PutFile = (request: { url: string; headers: Record<string, string>; path: string; size: number; signal: AbortSignal; onProgress: (sent: number) => void }) => Promise<{ status: number; body: string }>;

/** The real thing: streams the file from disk with an exact Content-Length, so nothing is held in memory and Google never sees chunked encoding. */
export const putFile: PutFile = ({ url, headers, path, size, signal, onProgress }) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const target = new URL(url);
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(target, { method: "POST", headers: { ...headers, "Content-Length": String(size) }, signal }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 1_000_000) chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    const stream = createReadStream(path);
    let sent = 0;
    stream.on("data", (chunk) => { sent += chunk.length; onProgress(sent); });
    stream.on("error", (error) => request.destroy(error));
    stream.pipe(request);
  });

export type FilesOptions = {
  /** The saved key, or null when there is none. */
  key: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  put?: PutFile;
  base?: string;
  /** Waits `ms`, ending early with the signal's reason when it aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long a file may stay in Google's PROCESSING state before the upload is given up. */
  processingMs?: number;
};

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });

type FileInfo = { name?: unknown; uri?: unknown; state?: unknown; mimeType?: unknown; error?: { message?: unknown } };

export class GeminiFiles {
  private readonly options: FilesOptions;
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: FilesOptions) {
    this.options = options;
    this.base = options.base ?? GEMINI_API;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async secret(): Promise<string> {
    const key = await this.options.key();
    if (!key) throw new GeminiError("auth", "No Gemini key is saved. Add one in Settings.");
    return key;
  }

  private async call(method: string, url: string, key: string, signal: AbortSignal, init: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Headers; text: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers: { "x-goog-api-key": key, ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}), signal, redirect: "error" });
    } catch (error) {
      throw networkError(error, key, signal);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw httpError(response.status, errorDetail(text), key);
    return { status: response.status, headers: response.headers, text };
  }

  /**
   * Uploads one file with the resumable protocol and waits until Google has
   * it ready. A file that fails or stalls while processing is deleted again
   * before the error goes up.
   */
  async upload(file: { path: string; size: number; mimeType: string; displayName: string }, signal: AbortSignal, onProgress: (phase: "uploading" | "processing", fraction: number | null) => void = () => {}): Promise<UploadedFile> {
    const key = await this.secret();
    if (file.size <= 0) throw new GeminiError("upload", "The file is empty.");
    onProgress("uploading", 0);
    const started = await this.call("POST", `${this.base}/upload/v1beta/files`, key, signal, {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(file.size),
        "X-Goog-Upload-Header-Content-Type": file.mimeType,
      },
      body: JSON.stringify({ file: { display_name: file.displayName } }),
    });
    const address = started.headers.get("x-goog-upload-url");
    if (!address) throw new GeminiError("upload", "Google did not return an upload address.");
    const session = this.uploadAddress(address);
    let sent: { status: number; body: string };
    try {
      sent = await (this.options.put ?? putFile)({
        url: session.url,
        // The key goes only to the API's own host; the address carries the session, so another Google host needs none.
        headers: { ...(session.sameHost ? { "x-goog-api-key": key } : {}), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
        path: file.path,
        size: file.size,
        signal,
        onProgress: (bytes) => onProgress("uploading", Math.min(1, bytes / file.size)),
      });
    } catch (error) {
      throw networkError(error, key, signal);
    }
    if (sent.status < 200 || sent.status >= 300) throw httpError(sent.status, errorDetail(sent.body), key);
    let info: FileInfo;
    try {
      info = (JSON.parse(sent.body) as { file?: FileInfo }).file ?? {};
    } catch {
      throw new GeminiError("response", HINTS.response);
    }
    if (typeof info.name !== "string" || typeof info.uri !== "string") throw new GeminiError("response", HINTS.response);
    const name = info.name;
    try {
      info = await this.ready(name, info, key, signal, onProgress);
    } catch (error) {
      await this.delete(name).catch(() => {});
      throw networkError(error, key, signal);
    }
    return { name, uri: info.uri as string, mimeType: typeof info.mimeType === "string" ? info.mimeType : file.mimeType };
  }

  /**
   * Where the file is sent, once it is clear that is somewhere Google serves:
   * https on a googleapis.com host, or the API's own origin. The address comes
   * from a response, and the file's contents go wherever it points.
   */
  private uploadAddress(address: string): { url: string; sameHost: boolean } {
    let target: URL;
    try {
      target = new URL(address);
    } catch {
      throw new GeminiError("upload", "Google returned an upload address that isn't one, so nothing was sent.");
    }
    const sameHost = target.origin === new URL(this.base).origin;
    if (!sameHost && !(target.protocol === "https:" && /(?:^|\.)googleapis\.com$/i.test(target.hostname))) {
      throw new GeminiError("upload", "Google returned an upload address Blackout doesn't trust, so nothing was sent.");
    }
    return { url: target.href, sameHost };
  }

  /** Polls a file until Google says ACTIVE; FAILED, or a stall past `processingMs`, is an upload error. */
  private async ready(name: string, first: FileInfo, key: string, signal: AbortSignal, onProgress: (phase: "uploading" | "processing", fraction: number | null) => void): Promise<FileInfo> {
    const sleep = this.options.sleep ?? sleepFor;
    const limit = this.options.processingMs ?? 15 * 60_000;
    let info = first;
    let waited = 0;
    let pause = 1000;
    while (info.state === "PROCESSING") {
      onProgress("processing", null);
      if (waited >= limit) throw new GeminiError("upload", "Google was still preparing the clip after 15 minutes.");
      await sleep(pause, signal);
      waited += pause;
      pause = Math.min(pause * 1.5, 5000);
      const polled = await this.call("GET", `${this.base}/v1beta/${name}`, key, signal);
      try {
        info = JSON.parse(polled.text) as FileInfo;
      } catch {
        throw new GeminiError("response", HINTS.response);
      }
    }
    if (info.state !== undefined && info.state !== "ACTIVE") {
      const reason = typeof info.error?.message === "string" ? ` (${redactKey(info.error.message, key).slice(0, 200)})` : "";
      throw new GeminiError("upload", `${HINTS.upload}${reason}`);
    }
    if (typeof info.uri !== "string") throw new GeminiError("response", HINTS.response);
    return info;
  }

  /**
   * Deletes an uploaded file. Resolves with a sentence when Google could not
   * be told (the file then expires by itself within 48 hours), null when it is gone.
   * Never throws: cleanup must not hide the answer or the real error.
   */
  async delete(name: string): Promise<string | null> {
    try {
      const key = await this.secret();
      await this.call("DELETE", `${this.base}/v1beta/${name}`, key, AbortSignal.timeout(30_000));
      return null;
    } catch (error) {
      const why = error instanceof GeminiError ? error.message.split(" (")[0] : "unknown error";
      return `Google could not be asked to delete the uploaded copy (${why}). It expires on its own within 48 hours.`;
    }
  }
}
