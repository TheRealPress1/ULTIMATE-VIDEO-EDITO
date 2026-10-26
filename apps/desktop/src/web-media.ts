/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Web media in the main process: `web_media_search` asks Openverse and
// Wikimedia Commons, and `web_media_download` (a renderer tool, which needs
// the live library) has main fetch the file into the project. Main does the
// network because the agent's sandbox has none and the renderer's fetch is
// bound by CORS; it does the disk because only main may write the project.
//
// Every request goes through the same gate (see ./web-media-url): public
// http(s) hosts only, redirects followed by hand and checked hop by hop, and
// connections whose addresses are checked again as they are made. What comes
// back is judged by its bytes (see ./web-media-sniff), capped by kind, and
// timed out when the server stalls.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, isAbsolute, join, relative } from "node:path";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { DapiError } from "@diffusionstudio/dapi";
import { tempPathFor } from "./atomic";
import { withProjectLock } from "./project-write-transactions";
import { checkWebUrl, hostOf, resolvePublic, systemResolve } from "./web-media-url";
import { NOT_MEDIA, SNIFF_BYTES, sharedMedia, sniff } from "./web-media-sniff";
import {
  PROVIDER_NAMES, UNKNOWN_LICENSE, WIKIMEDIA_WIDTHS, attributionLine, interleave, isWikimediaRendition, openverseUrl, parseOpenverse, parseWikimedia,
  urlKey, wikimediaUrl,
} from "./web-media-providers";
import { CREDITS_FILE, itemPath, readLedger, writeCredits, writeLedger } from "./web-media-ledger";

import type { LookupAddress, LookupOptions } from "node:dns";
import type { IncomingMessage } from "node:http";
import type { ToolResult, WebMediaKind, WebMediaProvider } from "@diffusionstudio/dapi";
import type { ProviderResult, SearchArgs } from "./web-media-providers";
import type { Resolve } from "./web-media-url";
import type { Sniffed, SniffedMedia } from "./web-media-sniff";
import type {
  WebMediaCommitRequest, WebMediaCommitResult, WebMediaDownloaded, WebMediaDownloadRequest, WebMediaLedger, WebMediaLedgerItem,
} from "./web-media-types";

/** What the service fetches with: the subset of `fetch` it uses. Redirects are never followed by it; the service does that, checking each hop. */
export type WebFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

const MB = 1024 * 1024;
/** Largest download per kind, checked against content-length first and then counted as it streams. */
export const WEB_MEDIA_CAPS: Record<WebMediaKind, number> = { image: 60 * MB, audio: 500 * MB, video: 2048 * MB };

export type WebMediaTimeouts = {
  /** Until a server answers a request with its headers. */
  header: number;
  /** Without a single byte arriving, mid-download. */
  idle: number;
  /** A whole download, page resolution included. */
  overall: number;
  /** One provider's search. */
  provider: number;
  /** One thumbnail. */
  preview: number;
  /** A download the renderer neither committed nor discarded, before main records it anyway. */
  pending: number;
  /** The first wait before asking a rate-limited host again, when it doesn't say how long (doubled for the second). */
  backoff: number;
  /** All the waiting one download does for rate-limited hosts, at most. */
  retryBudget: number;
};

/** How long a provider that ran out of time sits out searches that have another provider to ask. */
const PROVIDER_REST_MS = 5 * 60_000;
const TIMEOUTS: WebMediaTimeouts = {
  header: 30_000, idle: 60_000, overall: 20 * 60_000, provider: 15_000, preview: 10_000, pending: 15 * 60_000, backoff: 2_000, retryBudget: 30_000,
};
const MAX_REDIRECTS = 5;
/** Times a download asks a rate-limited host again. */
const MAX_RETRIES = 2;
/** What a host answers when it wants to be asked again later. */
const RETRY_STATUSES = new Set([429, 503]);
/**
 * Downloads from one host at a time. Wikimedia asks for no more than two
 * (and throttles originals after about ten in a row); an agent filling a
 * timeline asks for many at once.
 */
const HOST_DOWNLOADS = 2;
/** Connection failures a required proxy would explain (with the timeouts, which a network that drops direct traffic ends in). */
const UNREACHABLE = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
/** The longest a failure waits to learn which proxy would explain it. */
const PROXY_LOOKUP_MS = 2_000;
/** A web page is read this far for the media it shares. */
const HTML_MAX = 2 * MB;
const JSON_MAX = 8 * MB;
const PREVIEW_MAX = MB;
const PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** Search results remembered (by file and page URL) so a download can carry their provenance. */
const RECENT_MAX = 500;
/** Page candidates tried before giving up on a page. */
const PAGE_CANDIDATES = 3;
const SLUG_MAX = 48;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export const NO_PAGE_MEDIA =
  "This page doesn't expose a downloadable image or video. Video platforms (YouTube, Instagram, TikTok…) stream through their players — ask the user to export or import their own copy.";
/** A search result whose file URL serves a page now: whatever that page shares is not the result, nor under its license. */
export const RESULT_MOVED =
  "This search result's file now answers with a web page instead (it may have moved or been taken down). Pick another result.";
const PROJECT_GONE = "The project moved or closed during the download. Open it again and download again.";
const PROJECT_SAVED = "The project was saved or moved during the download. Download again in the project where it is now.";

export type WebMediaOptions = {
  /** The app's version, for the User-Agent the providers ask for. */
  version?: string;
  fetch?: WebFetch;
  resolve?: Resolve;
  /** Claims a write the project watcher would otherwise report (projects.ts). */
  noteContent?: (path: string, text: string | null) => void;
  /** Marks a write into a project as running, so a draft save waits for it (projects.ts). */
  startWrite?: (dir: string) => () => void;
  now?: () => Date;
  timeouts?: Partial<WebMediaTimeouts>;
  caps?: Partial<Record<WebMediaKind, number>>;
  /**
   * The proxy this machine is set up to use for `url`, as a phrase for an
   * error (`HTTPS_PROXY is set`), or undefined; it may answer later, as
   * Electron's `session.resolveProxy` does. By default, from the environment
   * and then, on macOS, from the network settings (an app opened from the
   * Finder has no proxy variables). Cutroom connects directly, checking each
   * address, so a failure to connect, or a timeout, behind a required proxy
   * says so. Asked only when a request fails.
   */
  proxy?: (url: URL) => string | undefined | Promise<string | undefined>;
};

type Provenance = {
  title?: string;
  creator?: string;
  provider?: WebMediaProvider;
  pageUrl?: string;
  license: WebMediaLedgerItem["license"];
  attribution?: string;
};

/** A response whose first bytes have been read and judged. */
type Opened = {
  url: URL;
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  chunks: Uint8Array[];
  done: boolean;
  sniffed: Sniffed;
};

type Pending = { dir: string; item: WebMediaLedgerItem; created: boolean; timer: ReturnType<typeof setTimeout> };

/**
 * A download still running: what stops it, its temporary file once there is
 * one, and, once a save or move stopped it, the write that save waits on
 * until the partial file is gone.
 */
type Job = { dir: string; controller: AbortController; temp: string | null; write: (() => void) | null };

function canceled(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof DapiError ? reason : new DapiError("canceled", "The web media request was canceled.");
}

/** `promise`, or the signal's reason as soon as it aborts, whichever comes first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(canceled(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(canceled(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(signal.aborted ? canceled(signal) : error); },
    );
  });
}

/** A signal that aborts with a timeout error after `ms`, or with `parent`; `clear` stops the clock. */
function deadline(parent: AbortSignal, ms: number, message: string): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DapiError("canceled", message)), ms);
  timer.unref?.();
  return { signal: AbortSignal.any([parent, controller.signal]), clear: () => clearTimeout(timer) };
}

/** `wait` milliseconds, or the signal's reason as soon as it aborts. */
function sleep(wait: number, signal: AbortSignal): Promise<void> {
  return abortable(new Promise<void>((resolve) => setTimeout(resolve, wait).unref?.()), signal);
}

/** A `Retry-After` header (seconds, or an HTTP date) in milliseconds from `now`; undefined when absent or unreadable. */
export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Whether a host is one of the providers', which rate limit and say when to come back: a download waits for them rather than fail. */
function retriesHost(host: string): boolean {
  return /(^|\.)(wikimedia\.org|openverse\.org)$/.test(host);
}

function statusError(status: number, url: URL, wait?: number): DapiError {
  const host = hostOf(url);
  const after = wait !== undefined && wait > 0 ? `Wait ${Math.ceil(wait / 1000)} seconds` : "Wait a minute";
  if (status === 404 || status === 410) return new DapiError("not-found", `${host} says this file doesn't exist (${status}). Check the link or pick another result.`);
  if (status === 401 || status === 403) return new DapiError("invalid-input", `${host} refused the download (${status}); it may need a sign-in or block downloads. Pick another result or link.`);
  if (status === 429) return new DapiError("busy", `${host} is rate limiting requests (429). ${after} or pick another result.`);
  if (status === 400 && isWikimediaRendition(url)) {
    return new DapiError(
      "invalid-input",
      `${host} doesn't render this image at that width (400): Wikimedia Commons only serves ${WIKIMEDIA_WIDTHS.join(", ")} px wide renditions. Use a result's url from a new web_media_search, or that link at one of those widths.`,
    );
  }
  if (status >= 400 && status < 500) return new DapiError("invalid-input", `${host} refused the request (${status}). Check the link or pick another result.`);
  return new DapiError("invalid-input", `${host} answered ${status}. Try again later or pick another result.`);
}

/** The proxies the environment names, as a phrase for an error. */
export function environmentProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].find((key) => env[key]?.trim());
  return name ? `${name} is set` : undefined;
}

/**
 * The proxy macOS's network settings turn on, from `scutil --proxy`, as a
 * phrase for an error; undefined when there is none. Auto-discovery is left
 * out: on, it finds no proxy on most networks.
 */
export function scutilProxy(output: string): string | undefined {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*([A-Za-z]+) : (.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  for (const kind of ["HTTPS", "HTTP", "SOCKS"]) {
    const host = values.get(`${kind}Proxy`);
    if (values.get(`${kind}Enable`) !== "1" || !host) continue;
    const port = values.get(`${kind}Port`);
    return `${kind} proxy ${host}${port ? `:${port}` : ""} in System Settings`;
  }
  if (values.get("ProxyAutoConfigEnable") === "1") return "automatic proxy configuration in System Settings";
  return undefined;
}

/** The proxy macOS's network settings name; undefined elsewhere, or when they can't be read. */
function systemProxy(): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((settle) => {
    execFile("/usr/sbin/scutil", ["--proxy"], { timeout: PROXY_LOOKUP_MS, maxBuffer: 256 * 1024 }, (error, stdout) => settle(error ? undefined : scutilProxy(String(stdout))));
  });
}

/** The proxy this machine is set up to use: the environment's, else the system's. */
export async function machineProxy(): Promise<string | undefined> {
  return environmentProxy() ?? (await systemProxy());
}

/** The error code of a failure to connect or resolve, wherever the client put it. */
function errorCode(error: unknown): string | undefined {
  // A DapiError's own `code` is the tool's, not the system's.
  const own = error instanceof DapiError ? undefined : (error as NodeJS.ErrnoException)?.code;
  return own ?? (error as { cause?: NodeJS.ErrnoException })?.cause?.code;
}

/** A sentence naming the proxy a request to `url` went around, for a failure it would explain; "" without one. */
function proxySentence(proxy: string | undefined, url: URL, search: boolean): string {
  if (!proxy) return "";
  return search
    ? ` This Mac is set up to use a proxy (${proxy}), which Cutroom's web media search doesn't go through: allow direct connections to ${hostOf(url)}.`
    : ` This Mac is set up to use a proxy (${proxy}), which Cutroom's downloader doesn't go through: allow direct connections to ${hostOf(url)}, or download the file in a browser and import it.`;
}

/**
 * A network failure as a sentence, without the stack of the client that had
 * it, ending with `hint` (see `proxySentence`) when there is one.
 */
function networkError(error: unknown, url: URL, hint: string): Error {
  const code = errorCode(error);
  if (error instanceof DapiError) return hint ? new DapiError(error.code, `${error.message}${hint}`, { cause: error }) : error;
  return new DapiError("invalid-input", `Couldn't reach ${hostOf(url)}${code ? ` (${code})` : ""}.${hint || " Check the link or try again."}`, { cause: error });
}

/** A short ASCII file name stem: from the name given, the title, or the URL's file name. */
export function slugFor(...names: Array<string | undefined>): string {
  for (const name of names) {
    const slug = (name ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, SLUG_MAX)
      .replace(/-+$/, "");
    if (slug) return slug;
  }
  return "web-media";
}

/** A URL's file name without its extension, decoded. */
function urlStem(url: string): string {
  const name = basename(new URL(url).pathname);
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* keep it encoded */ }
  return decoded.replace(/\.[a-z0-9]{1,5}$/i, "");
}

/** Node's response as a fetch Response, its body decoded when the server compressed it. */
function toResponse(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  const status = message.statusCode ?? 502;
  if ([101, 204, 205, 304].includes(status) || status < 200) {
    message.resume();
    return new Response(null, { status: status < 200 ? 502 : status, headers });
  }
  const encoding = (message.headers["content-encoding"] ?? "").toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
  // `pipeline` destroys both streams when either fails, so a broken encoding errors the body.
  const body: Readable = decoder ? (pipeline(message, decoder, () => {}) as unknown as Readable) : message;
  return new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, headers });
}

/**
 * Node's http(s) client, its connections made only to public addresses. The
 * service checks a URL's host before each request; this checks it again as
 * the socket connects, with the addresses actually used, so a name that
 * answers differently the second time (DNS rebinding) still cannot reach this
 * machine or the local network.
 */
export function pinnedFetch(resolve: Resolve = systemResolve): WebFetch {
  const lookup = (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolvePublic(hostname, resolve).then(
      (addresses) => (options.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family)),
      (error: Error) => callback(error, ""),
    );
  };
  return (url, init) => new Promise<Response>((settle, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(target, {
      method: "GET",
      headers: { ...init.headers, "accept-encoding": "gzip, deflate, br" },
      lookup: lookup as never,
      signal: init.signal,
    }, (message) => {
      // Inside Node's event: a throw here would be the main process's, uncaught.
      try {
        settle(toResponse(message));
      } catch (error) {
        message.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    request.end();
  });
}

export class WebMediaService {
  private readonly fetch: WebFetch;
  private readonly resolve: Resolve;
  private readonly userAgent: string;
  private readonly noteContent: (path: string, text: string | null) => void;
  private readonly startWrite: (dir: string) => () => void;
  private readonly now: () => Date;
  private readonly timeouts: WebMediaTimeouts;
  private readonly caps: Record<WebMediaKind, number>;
  private readonly proxy: (url: URL) => string | undefined | Promise<string | undefined>;
  /** Search results by file and page URL, least recently seen first. */
  private readonly recent = new Map<string, ProviderResult>();
  /** Downloads the renderer is importing, by request id. */
  private readonly pending = new Map<string, Pending>();
  /** Downloads still fetching, for a save or a quit to stop. */
  private readonly jobs = new Set<Job>();
  /** When a provider that ran out of time may be asked again: each slow search would otherwise wait it out anew. */
  private readonly resting = new Map<WebMediaProvider, number>();
  /** Downloads fetching from each host, and those waiting their turn (see `HOST_DOWNLOADS`). */
  private readonly hosts = new Map<string, { running: number; waiting: Array<() => void> }>();

  constructor(options: WebMediaOptions = {}) {
    this.resolve = options.resolve ?? systemResolve;
    this.fetch = options.fetch ?? pinnedFetch(this.resolve);
    this.userAgent = `Cutroom/${options.version ?? "dev"} (desktop video editor; https://github.com/diffusionstudio/editor)`;
    this.noteContent = options.noteContent ?? (() => {});
    this.startWrite = options.startWrite ?? (() => () => {});
    this.now = options.now ?? (() => new Date());
    this.timeouts = { ...TIMEOUTS, ...options.timeouts };
    this.caps = { ...WEB_MEDIA_CAPS, ...options.caps };
    this.proxy = options.proxy ?? machineProxy;
  }

  // -------------------------------------------------------------------------
  // Requests

  /**
   * GETs `start`, following redirects by hand: every hop's URL and every
   * address its host resolves to are checked before it is requested. Answers
   * with the final response once its headers are in, and fails a non-2xx.
   * With `retry`, a provider's host that is rate limiting (429, 503) is asked
   * again after the wait it names (or a short backoff), at most twice and
   * within `retryBudget` in all. A `search` failure's advice is for a search.
   */
  private async get(start: URL, signal: AbortSignal, accept: string, retry = false, search = false): Promise<{ url: URL; response: Response }> {
    let url = start;
    let retries = 0;
    let waited = 0;
    for (let hop = 0; ;) {
      try {
        await abortable(resolvePublic(hostOf(url), this.resolve), signal);
      } catch (error) {
        throw signal.aborted ? canceled(signal) : await this.networkError(error, url, signal, search);
      }
      const silent = `${hostOf(url)} didn't answer within ${Math.round(this.timeouts.header / 1000)} seconds.`;
      const headers = deadline(signal, this.timeouts.header, `${silent} Try again later or pick another result.`);
      let response: Response;
      try {
        response = await abortable(this.fetch(url.href, { signal: headers.signal, headers: { "user-agent": this.userAgent, accept } }), headers.signal);
      } catch (error) {
        if (signal.aborted) throw canceled(signal);
        if (headers.signal.aborted) {
          // A network that drops direct connections looks like this, never refusing them: a configured proxy is named here too.
          const hint = await this.proxyHint(url, signal, search);
          throw hint ? new DapiError("canceled", `${silent}${hint}`) : canceled(headers.signal);
        }
        throw await this.networkError(error, url, signal, search);
      } finally {
        headers.clear();
      }
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) throw new DapiError("invalid-input", `${hostOf(url)} redirected without saying where.`);
        if (hop >= MAX_REDIRECTS) throw new DapiError("invalid-input", `That link redirects more than ${MAX_REDIRECTS} times.`);
        url = checkWebUrl(new URL(location, url));
        hop++;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const named = retryAfter(response.headers.get("retry-after"), this.now().getTime());
        if (retry && RETRY_STATUSES.has(response.status) && retriesHost(hostOf(url)) && retries < MAX_RETRIES) {
          const wait = named ?? this.timeouts.backoff * 2 ** retries;
          if (waited + wait <= this.timeouts.retryBudget) {
            retries++;
            waited += wait;
            await sleep(wait, signal);
            continue;
          }
        }
        throw statusError(response.status, url, named);
      }
      return { url, response };
    }
  }

  /**
   * When a proxy is set up for `url`, a sentence naming it (see `proxySentence`);
   * "" without one, or when finding out fails or takes too long. The abort
   * of `signal` while it is asked wins over any answer.
   */
  private async proxyHint(url: URL, signal: AbortSignal, search: boolean): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const proxy = await Promise.race([
      Promise.resolve().then(() => this.proxy(url)),
      new Promise<undefined>((settle) => { timer = setTimeout(settle, PROXY_LOOKUP_MS, undefined); timer.unref?.(); }),
    ]).catch(() => undefined).finally(() => clearTimeout(timer));
    if (signal.aborted) throw canceled(signal);
    return proxySentence(proxy, url, search);
  }

  /** A failure to reach `url` as a sentence (see `networkError`), naming a configured proxy when one would explain it. */
  private async networkError(error: unknown, url: URL, signal: AbortSignal, search: boolean): Promise<Error> {
    const code = errorCode(error);
    return networkError(error, url, code && UNREACHABLE.has(code) ? await this.proxyHint(url, signal, search) : "");
  }

  /** The next chunk, or a timeout when none comes for `idle`, or the abort. */
  private async read(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, host: string): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
    const idle = deadline(signal, this.timeouts.idle, `${host} stopped sending data for ${Math.round(this.timeouts.idle / 1000)} seconds. Try again later.`);
    try {
      return await abortable(reader.read(), idle.signal);
    } catch (error) {
      if (error instanceof DapiError) throw error;
      throw new DapiError("invalid-input", `The connection to ${host} broke off mid-download. Try again.`, { cause: error });
    } finally {
      idle.clear();
    }
  }

  /** Requests `url` and judges what it is from its first bytes; `retry` and `search` as for `get`. */
  private async open(url: URL, signal: AbortSignal, prefer: "image" | "video", options: { accept?: string; retry?: boolean; search?: boolean } = {}): Promise<Opened> {
    const { url: final, response } = await this.get(url, signal, options.accept ?? "*/*", options.retry, options.search);
    const reader = response.body?.getReader();
    if (!reader) throw new DapiError("invalid-input", `${hostOf(final)} sent no file.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    try {
      while (size < SNIFF_BYTES) {
        const next = await this.read(reader, signal, hostOf(final));
        if (next.done) { done = true; break; }
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const head = concat(chunks, SNIFF_BYTES);
    let sniffed = sniff(head, prefer);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    // The bytes decide; the declared type only breaks a tie for a page that starts unusually.
    if (sniffed.kind === "rejected" && /^(text\/html|application\/xhtml\+xml)/.test(type)) sniffed = { kind: "html" };
    return { url: final, response, reader, chunks, done, sniffed };
  }

  /** The rest of a response as text, up to `max` bytes (a page) or failing past it (an API answer). */
  private async text(opened: Opened, signal: AbortSignal, max: number, truncate: boolean): Promise<string> {
    const { reader, chunks } = opened;
    let size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    try {
      while (!opened.done && size <= max) {
        const next = await this.read(reader, signal, hostOf(opened.url));
        if (next.done) { opened.done = true; break; }
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    } finally {
      if (!opened.done) await reader.cancel().catch(() => {});
    }
    if (size > max && !truncate) throw new DapiError("invalid-input", `${hostOf(opened.url)} sent more than ${Math.round(max / MB)} MB.`);
    return new TextDecoder().decode(concat(chunks, max));
  }

  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    const opened = await this.open(checkWebUrl(url), signal, "image", { accept: "application/json", search: true });
    const text = await this.text(opened, signal, JSON_MAX, false);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("answered with something other than JSON");
    }
  }

  // -------------------------------------------------------------------------
  // Search

  async search(args: SearchArgs, signal: AbortSignal): Promise<ToolResult<"web_media_search">> {
    const providers = [...new Set(args.sources)];
    if (args.kind === "video" && providers.every((provider) => provider === "openverse")) {
      throw new DapiError("invalid-input", "Openverse has no video. Search Wikimedia Commons for video (`sources: [\"wikimedia\"]`).");
    }
    const warnings: string[] = [];
    const failures: string[] = [];
    const now = this.now().getTime();
    // A provider asked alone is always tried; next to another, one that just timed out sits out a while.
    const skipped = new Set(providers.filter((provider) => providers.length > 1 && (this.resting.get(provider) ?? 0) > now));
    const lists = await Promise.all(providers.map(async (provider): Promise<ProviderResult[]> => {
      if (provider === "openverse" && args.kind === "video") {
        warnings.push("Openverse has no video; these results are from Wikimedia Commons only.");
        return [];
      }
      if (skipped.has(provider)) {
        warnings.push(`${PROVIDER_NAMES[provider]} was too slow a moment ago, so it is skipped for a few minutes; ask it alone with \`sources\` to try it now.`);
        return [];
      }
      const bounded = deadline(signal, this.timeouts.provider, `didn't answer within ${Math.round(this.timeouts.provider / 1000)} seconds.`);
      const url = provider === "openverse" ? openverseUrl(args)! : wikimediaUrl(args);
      try {
        const body = await this.json(url, bounded.signal);
        return provider === "openverse" ? parseOpenverse(body, args) : parseWikimedia(body, args);
      } catch (error) {
        if (signal.aborted) throw canceled(signal);
        let reason = (error as Error).message;
        if (bounded.signal.aborted) {
          this.resting.set(provider, now + PROVIDER_REST_MS);
          reason = `${(bounded.signal.reason as Error).message}${await this.proxyHint(new URL(url), signal, true)}`;
        }
        failures.push(`${PROVIDER_NAMES[provider]}: ${reason}`);
        return [];
      } finally {
        bounded.clear();
      }
    }));
    if (!failures.length) for (const provider of providers) if (!skipped.has(provider)) this.resting.delete(provider);
    const answered = providers.filter((provider) => !(provider === "openverse" && args.kind === "video") && !skipped.has(provider)).length;
    if (failures.length && failures.length === answered) {
      throw new DapiError("unsupported", `Web media search failed. ${failures.join(" ")}`);
    }
    warnings.push(...failures);
    const results = interleave(lists, args.limit);
    this.remember(results);
    const previews = await this.previews(results.slice(0, args.preview), signal);
    return { results, warnings, previews };
  }

  private remember(results: ProviderResult[]): void {
    for (const result of results) {
      for (const key of [result.url, result.pageUrl, result.thumbnailUrl].map((url) => url && urlKey(url))) {
        if (!key) continue;
        this.recent.delete(key);
        this.recent.set(key, result);
      }
    }
    while (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value!);
  }

  /** The search result a URL was, by its file, page or thumbnail; undefined for any other link. */
  recall(url: string): ProviderResult | undefined {
    const key = urlKey(url);
    return key ? this.recent.get(key) : undefined;
  }

  /** Thumbnails of the leading results, for an agent to look at; one that fails is left out without a word. */
  private async previews(results: Array<ProviderResult & { index: number }>, signal: AbortSignal): Promise<ToolResult<"web_media_search">["previews"]> {
    const fetched = await Promise.all(results.map(async (result) => {
      if (!result.thumbnailUrl) return null;
      const bounded = deadline(signal, this.timeouts.preview, "The preview timed out.");
      try {
        // Never retried: a preview that isn't there at once is left out.
        const opened = await this.open(checkWebUrl(result.thumbnailUrl), bounded.signal, "image", { accept: "image/*" });
        const sniffed = opened.sniffed;
        const declared = Number(opened.response.headers.get("content-length"));
        if (!("mimeType" in sniffed) || !PREVIEW_TYPES.has(sniffed.mimeType) || declared > PREVIEW_MAX) {
          await opened.reader.cancel().catch(() => {});
          return null;
        }
        const bytes = await this.bytes(opened, bounded.signal, PREVIEW_MAX);
        return { index: result.index, bytes, mimeType: sniffed.mimeType };
      } catch {
        if (signal.aborted) throw canceled(signal);
        return null;
      } finally {
        bounded.clear();
      }
    }));
    return fetched.filter((preview) => preview !== null);
  }

  /** The whole (small) body, or a failure past `max`. */
  private async bytes(opened: Opened, signal: AbortSignal, max: number): Promise<Uint8Array> {
    const { reader, chunks } = opened;
    let size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    try {
      while (!opened.done) {
        if (size > max) throw new Error("too large");
        const next = await this.read(reader, signal, hostOf(opened.url));
        if (next.done) { opened.done = true; break; }
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    } finally {
      if (!opened.done) await reader.cancel().catch(() => {});
    }
    if (size > max) throw new Error("too large");
    return concat(chunks, size);
  }

  // -------------------------------------------------------------------------
  // Download

  /**
   * Downloads `request.url` into `<dir>/assets/web/` and holds it for the
   * renderer, which imports it and then commits or discards it. A search
   * result's page URL downloads the result's file, with its provenance; a web
   * page downloads the media it shares; the same bytes already downloaded
   * into the project are reused rather than written again.
   */
  async download(request: WebMediaDownloadRequest, signal: AbortSignal): Promise<WebMediaDownloaded> {
    // Not a write into the project while it fetches, which can take minutes:
    // a duplicate goes ahead without it (leaving its partial file behind,
    // as it does every temp file), and a save or move stops it first (see
    // `cancelDownloads`). Only landing the file counts as a write (see
    // `fetchInto`).
    const job: Job = { dir: request.dir, controller: new AbortController(), temp: null, write: null };
    this.jobs.add(job);
    try {
      return await this.fetchInto(request, AbortSignal.any([signal, job.controller.signal]), job);
    } finally {
      this.jobs.delete(job);
      job.write?.();
    }
  }

  /**
   * Stops the downloads running into `dir`, whose folder is about to move:
   * the renderer that asked for them has let go of the project already, so
   * their files would only land in a folder nobody has open. Each counts as
   * a write into the project until it has stopped and its partial file is
   * gone, so the move, which waits for writes, takes a clean folder.
   */
  cancelDownloads(dir: string): void {
    for (const job of this.jobs) {
      if (job.dir !== dir) continue;
      job.write ??= this.startWrite(dir);
      job.controller.abort(new DapiError("no-project", PROJECT_SAVED));
    }
  }

  /**
   * A turn to download from `host`: at most `HOST_DOWNLOADS` at once, the
   * rest waiting in order. Resolves with what gives the turn back (once,
   * however often it is called).
   */
  private async turn(host: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw canceled(signal);
    let queue = this.hosts.get(host);
    if (!queue) this.hosts.set(host, (queue = { running: 0, waiting: [] }));
    const line = queue;
    if (line.running < HOST_DOWNLOADS) {
      line.running++;
    } else {
      // A turn handed on keeps `running` as it is: the one leaving gives its place to the next.
      await new Promise<void>((resolve, reject) => {
        const go = () => { signal.removeEventListener("abort", leave); resolve(); };
        const leave = () => { line.waiting.splice(line.waiting.indexOf(go), 1); reject(canceled(signal)); };
        line.waiting.push(go);
        signal.addEventListener("abort", leave, { once: true });
      });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = line.waiting.shift();
      if (next) return next();
      line.running--;
      if (!line.running && this.hosts.get(host) === line) this.hosts.delete(host);
    };
  }

  /** Stops every download as the app quits, removing their partial files at once: nothing waits for the cleanup that would follow. */
  dispose(): void {
    for (const job of this.jobs) {
      job.controller.abort(new DapiError("canceled", "Cutroom quit during the download."));
      if (job.temp) rmSync(job.temp, { force: true });
    }
  }

  private async fetchInto(request: WebMediaDownloadRequest, signal: AbortSignal, job: Job): Promise<WebMediaDownloaded> {
    const dir = request.dir;
    const root = await this.projectRoot(dir);
    const requested = checkWebUrl(request.url);
    const known = this.recall(requested.href);
    // A search result's own file, or nothing: the page its URL may serve now is some other picture, not under the result's license.
    const source = checkWebUrl(known?.url ?? requested.href);
    // Waiting for a turn with the host is not downloading: the clock starts once it has one.
    const release = await this.turn(hostOf(source), signal);
    const bounded = deadline(signal, this.timeouts.overall, `The download took longer than ${Math.round(this.timeouts.overall / 60_000)} minutes and was stopped.`);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const { opened, media, page } = await this.resolveMedia(source, bounded.signal, request.prefer, !known);
      reader = opened.reader;
      const cap = this.caps[media.kind];
      const declared = Number(opened.response.headers.get("content-length"));
      if (declared > cap) {
        await opened.reader.cancel().catch(() => {});
        throw tooLarge(media.kind, cap);
      }
      const webDir = await this.webDir(dir, root);
      const temp = (job.temp = tempPathFor(join(webDir, "download")));
      const { sha256, bytes } = await this.stream(opened, temp, cap, media.kind, bounded.signal);
      // Done with the network: the host's next download goes ahead while this one lands.
      release();
      const result = known ?? this.recall(opened.url.href);
      const title = result?.title ?? page?.title;
      const provenance: Provenance = result
        ? { title: result.title, creator: result.creator, provider: result.provider, pageUrl: result.pageUrl, license: result.license, attribution: result.attribution }
        : {
          ...(title ? { title } : {}),
          ...(page ? { pageUrl: page.url } : {}),
          license: UNKNOWN_LICENSE,
          attribution: attributionLine({ title: title || urlStem(opened.url.href) || hostOf(opened.url), pageUrl: page?.url, fileUrl: opened.url.href, license: UNKNOWN_LICENSE }),
        };
      const slug = slugFor(request.name, title, urlStem(opened.url.href));
      // Landing is a write into the project, which a save, move or duplicate waits for; claimed before the first await.
      const landing = this.startWrite(dir);
      let landed: Awaited<ReturnType<WebMediaService["land"]>>;
      try {
        landed = await this.land(dir, webDir, temp, { slug, ext: media.ext, sha256, bytes, provenance }, (file, kept, deduplicated) => {
          const item: WebMediaLedgerItem = {
            file,
            sha256,
            bytes,
            kind: media.kind,
            mimeType: media.mimeType,
            ...withoutUndefined(kept),
            fileUrl: opened.url.href,
            requestedUrl: requested.href,
            downloadedAt: this.now().toISOString(),
          };
          this.hold(request.id, dir, item, !deduplicated);
        });
        job.temp = null;
        // Stopped while landing (a save of the project): what landed goes again before the save is let through.
        if (signal.aborted) {
          await this.discard(request.id).catch(() => {});
          throw canceled(signal);
        }
      } finally {
        landing();
      }
      return {
        id: request.id,
        source: landed.file,
        path: itemPath(dir, landed.file),
        kind: media.kind,
        mimeType: media.mimeType,
        bytes,
        sha256,
        ...withoutUndefined(landed.provenance),
        fileUrl: opened.url.href,
        requestedUrl: requested.href,
        deduplicated: landed.deduplicated,
        creditsFile: join(dir, CREDITS_FILE),
      };
    } catch (error) {
      // A response given up on before its end lets go of its connection.
      await reader?.cancel().catch(() => {});
      if (signal.aborted) throw canceled(signal);
      if (bounded.signal.aborted) throw canceled(bounded.signal);
      // A file operation that failed because the folder left (moved outside the app, or deleted) is about the project, not the file.
      if (!(error instanceof DapiError) && !(await stat(dir).catch(() => null))?.isDirectory()) {
        throw new DapiError("no-project", PROJECT_GONE, { cause: error });
      }
      throw error;
    } finally {
      release();
      bounded.clear();
      if (job.temp) await rm(job.temp, { force: true }).catch(() => {});
      job.temp = null;
    }
  }

  /**
   * The media at `url`: the file itself, or, for a web page (unless `pages`
   * is false), the first media it shares that downloads.
   */
  private async resolveMedia(
    url: URL, signal: AbortSignal, prefer: "image" | "video", pages: boolean,
  ): Promise<{ opened: Opened; media: SniffedMedia; page?: { url: string; title?: string } }> {
    const first = await this.open(url, signal, prefer, { retry: true });
    if (first.sniffed.kind === "rejected") {
      await first.reader.cancel().catch(() => {});
      throw new DapiError("unsupported", first.sniffed.reason);
    }
    if (first.sniffed.kind !== "html") return { opened: first, media: first.sniffed };
    if (!pages) {
      await first.reader.cancel().catch(() => {});
      throw new DapiError("not-found", RESULT_MOVED);
    }

    const html = await this.text(first, signal, HTML_MAX, true);
    const shared = sharedMedia(html, first.url, prefer);
    const page = { url: first.url.href, ...(shared.title ? { title: shared.title } : {}) };
    let reason: string | undefined;
    let failure: { url: string; error: unknown } | undefined;
    for (const candidate of shared.candidates.slice(0, PAGE_CANDIDATES)) {
      try {
        const opened = await this.open(checkWebUrl(candidate), signal, prefer, { retry: true });
        if (opened.sniffed.kind !== "html" && opened.sniffed.kind !== "rejected") return { opened, media: opened.sniffed, page };
        await opened.reader.cancel().catch(() => {});
        if (opened.sniffed.kind === "rejected") reason = opened.sniffed.reason;
      } catch (error) {
        // A candidate that fails (gone, private, refused) leaves the next one to try; the most preferred one's failure is the story if none works.
        if (signal.aborted) throw canceled(signal);
        failure ??= { url: candidate, error };
      }
    }
    if (reason && !reason.startsWith(NOT_MEDIA)) throw new DapiError("unsupported", reason);
    if (failure) {
      const { error } = failure;
      const code = error instanceof DapiError ? error.code : "invalid-input";
      const message = error instanceof Error ? error.message : String(error);
      throw new DapiError(code, `The page shares media at ${hostOf(new URL(failure.url))}, but downloading it failed: ${message}`, { cause: error });
    }
    throw new DapiError("unsupported", NO_PAGE_MEDIA);
  }

  /** The project folder's real path; refuses anything but an existing folder. */
  private async projectRoot(dir: string): Promise<string> {
    if (!isAbsolute(dir)) throw new DapiError("no-project", "No project open — open one first.");
    const root = await realpath(dir).catch(() => null);
    if (!root || !(await stat(root)).isDirectory()) throw new DapiError("no-project", "The open project's folder is missing. Open the project again.");
    return root;
  }

  /** `assets/web` in the project, created when missing, as its real path, which must stay inside the project. */
  private async webDir(dir: string, root: string): Promise<string> {
    const web = join(dir, "assets", "web");
    // A level at a time below the project, never the project itself: a folder that moved away must not come back empty where it was.
    for (const folder of [join(dir, "assets"), web]) {
      await mkdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    const real = await realpath(web);
    const rel = relative(root, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new DapiError("invalid-input", "The project's assets/web folder leads outside the project. Remove that link and try again.");
    }
    return real;
  }

  /** Streams the rest of the response into `temp`, hashing and counting; past `cap` it stops and fails. */
  private async stream(opened: Opened, temp: string, cap: number, kind: WebMediaKind, signal: AbortSignal): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash("sha256");
    let bytes = 0;
    const file = await open(temp, "wx", 0o644);
    try {
      const write = async (chunk: Uint8Array) => {
        bytes += chunk.byteLength;
        if (bytes > cap) throw tooLarge(kind, cap);
        hash.update(chunk);
        await file.write(chunk);
      };
      for (const chunk of opened.chunks) await write(chunk);
      while (!opened.done) {
        signal.throwIfAborted();
        const next = await this.read(opened.reader, signal, hostOf(opened.url));
        if (next.done) { opened.done = true; break; }
        await write(next.value);
      }
      if (!bytes) throw new DapiError("invalid-input", `${hostOf(opened.url)} sent an empty file.`);
      await file.sync();
      return { sha256: hash.digest("hex"), bytes };
    } finally {
      if (!opened.done) await opened.reader.cancel().catch(() => {});
      await file.close().catch(() => {});
    }
  }

  /**
   * Moves a finished download to `<slug>-<sha8>.<ext>`, or, when the project
   * already holds these bytes (a recorded download, or one still pending),
   * drops it for that file. Under the project lock, and registered as
   * pending (`register`) before the lock is let go, so a second download of
   * the same bytes finds this one rather than landing a copy. The download
   * holds a write into the project open around it (see `fetchInto`).
   */
  private async land(
    dir: string, webDir: string, temp: string,
    file: { slug: string; ext: string; sha256: string; bytes: number; provenance: Provenance },
    register: (file: string, provenance: Provenance, deduplicated: boolean) => void,
  ): Promise<{ file: string; deduplicated: boolean; provenance: Provenance }> {
    const landed = (result: { file: string; deduplicated: boolean; provenance: Provenance }) => {
      register(result.file, result.provenance, result.deduplicated);
      return result;
    };
    return withProjectLock(dir, async () => {
      const ledger = await readLedger(dir);
      const existing = await this.existing(dir, ledger, file.sha256);
      if (existing) {
        await rm(temp, { force: true });
        // A search result's license is worth more than an unverified one recorded earlier.
        const provenance = existing.license.verified || !file.provenance.license.verified ? provenanceOf(existing) : file.provenance;
        return landed({ file: existing.file, deduplicated: true, provenance });
      }
      // `<slug>-<sha8>`; a different file already under that name (not these bytes) moves this one to `-2`, `-3`, …
      for (let attempt = 1; ; attempt++) {
        const name = `${file.slug}-${file.sha256.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ""}.${file.ext}`;
        const target = join(webDir, name);
        // The library's `source`: through `assets/`, as its scan finds the file, even when a link leads elsewhere in the project.
        const source = `assets/web/${name}`;
        if (await holds(target, file.bytes, file.sha256)) {
          await rm(temp, { force: true });
          return landed({ file: source, deduplicated: true, provenance: file.provenance });
        }
        if (await stat(target).catch(() => null)) continue;
        await rename(temp, target);
        return landed({ file: source, deduplicated: false, provenance: file.provenance });
      }
    });
  }

  /**
   * A recorded or pending download of the same bytes whose file still holds
   * them, by size and hash: a file edited in place since (a crop, a
   * conversion) keeps its record but is not these bytes any more.
   */
  private async existing(dir: string, ledger: WebMediaLedger, sha256: string): Promise<WebMediaLedgerItem | null> {
    const candidates = [
      ...ledger.items.filter((item) => item.sha256 === sha256),
      ...[...this.pending.values()].filter((entry) => entry.dir === dir && entry.item.sha256 === sha256).map((entry) => entry.item),
    ];
    for (const item of candidates) if (await holds(itemPath(dir, item.file), item.bytes, sha256)) return item;
    return null;
  }

  private hold(id: string, dir: string, item: WebMediaLedgerItem, created: boolean): void {
    // A renderer that went away mid-import never answers; the file stays, so its credit does too.
    const timer = setTimeout(() => {
      void this.commit({ id, assetId: "", src: "", source: item.file }).catch((error: Error) =>
        console.warn(`[web-media] could not record ${item.file}: ${error.message}`));
    }, this.timeouts.pending);
    timer.unref?.();
    this.pending.set(id, { dir, item, created, timer });
  }

  private take(id: string): Pending {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("This web media download is no longer pending. Download it again.");
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry;
  }

  /**
   * Whether a file this download created can go now that the download no
   * longer needs it: not while the ledger records it, and not while another
   * pending download reuses it, which then owns it (so the last one out still
   * cleans up).
   */
  private releasable(dir: string, file: string, ledger: WebMediaLedger): boolean {
    if (ledger.items.some((item) => item.file === file)) return false;
    const heir = [...this.pending.values()].find((entry) => entry.dir === dir && entry.item.file === file);
    if (heir) heir.created = true;
    return !heir;
  }

  /**
   * Records an imported download in the ledger and rewrites CREDITS.md. When
   * the library answered with an asset it already had for the same bytes
   * (`source` is not the download's file), the download's own file goes and
   * the credit points at that asset.
   */
  async commit(request: WebMediaCommitRequest): Promise<WebMediaCommitResult> {
    const { dir, item, created } = this.take(request.id);
    const source = request.source.replace(/\\/g, "/");
    if (!isAbsolute(source) && source.split("/").some((part) => part === ".." || part === "")) {
      throw new Error("The imported file must be inside the project.");
    }
    const finish = this.startWrite(dir);
    try {
      const creditsFile = await withProjectLock(dir, async () => {
        const ledger = await readLedger(dir);
        if (source !== item.file && created && this.releasable(dir, item.file, ledger)) {
          await rm(itemPath(dir, item.file), { force: true });
        }
        const recorded: WebMediaLedgerItem = {
          ...item,
          file: source,
          ...(request.assetId ? { assetId: request.assetId } : {}),
          ...(request.src ? { src: request.src } : {}),
        };
        const at = ledger.items.findIndex((other) => other.file === source);
        if (at < 0) ledger.items.push(recorded);
        else if (!ledger.items[at]!.license.verified && recorded.license.verified) ledger.items[at] = recorded;
        else ledger.items[at] = { ...ledger.items[at]!, ...(request.assetId ? { assetId: request.assetId } : {}), ...(request.src ? { src: request.src } : {}) };
        await writeLedger(dir, ledger);
        return writeCredits(dir, ledger, this.noteContent);
      });
      return { creditsFile };
    } finally {
      finish();
    }
  }

  /** Takes back a download the renderer could not import: its file goes, unless it was one the project already had. */
  async discard(id: string): Promise<void> {
    const { dir, item, created } = this.take(id);
    if (!created) return;
    await withProjectLock(dir, async () => {
      if (this.releasable(dir, item.file, await readLedger(dir))) await rm(itemPath(dir, item.file), { force: true });
    });
  }
}

function tooLarge(kind: WebMediaKind, cap: number): DapiError {
  return new DapiError("invalid-input", `This ${kind} is larger than ${Math.round(cap / MB)} MB, the most web_media_download takes for ${kind === "image" ? "an image" : kind}. Pick a smaller rendition.`);
}

function provenanceOf(item: WebMediaLedgerItem): Provenance {
  return { title: item.title, creator: item.creator, provider: item.provider, pageUrl: item.pageUrl, license: item.license, attribution: item.attribution };
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function concat(chunks: Uint8Array[], max: number): Uint8Array {
  const total = Math.min(max, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    if (at >= total) break;
    const part = chunk.subarray(0, total - at);
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Whether the file at `path` is exactly these bytes: by its size, and then by its hash. */
async function holds(path: string, bytes: number, sha256: string): Promise<boolean> {
  const there = await stat(path).catch(() => null);
  return !!there?.isFile() && there.size === bytes && (await sha256Of(path).catch(() => null)) === sha256;
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

let singleton: WebMediaService | undefined;

/** The app's one service: one memory of recent search results for the tools and the download channel alike. */
export function webMediaService(): WebMediaService {
  return (singleton ??= new WebMediaService());
}

/** Sets up the app's service with what only main.ts has; call once, before any tool runs. */
export function configureWebMediaService(options: WebMediaOptions): WebMediaService {
  singleton = new WebMediaService(options);
  return singleton;
}

