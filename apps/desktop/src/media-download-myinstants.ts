/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// MyInstants, the meme sound-button site, read by the app itself rather than
// the downloader (which has no extractor for it): a sound's page names its
// MP3 in the play button, and the search page lists instants by slug. Pages
// are fetched with the app's browser network stack (Electron's `net.fetch`
// in main.ts), whose requests look like a browser's, so the site's bot
// screen lets them through more often. That stack doesn't take the address
// checks Node's client does, so every request is held to an exact host list
// and resolved to public addresses first, and redirects are followed by hand
// only within that list.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { DapiError } from "@diffusionstudio/dapi";
import { decodeEntities, sniff } from "./web-media-sniff";
import { resolvePublic } from "./web-media-url";

import type { Resolve } from "./web-media-url";

/** What MyInstants pages and sounds are fetched with: the subset of `fetch` (or Electron's `net.fetch`) used. */
export type PageFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "manual" }) => Promise<Response>;

export type MyInstantsDeps = {
  fetch: PageFetch;
  resolve: Resolve;
  signal: AbortSignal;
  /** The longest one page (a sound's, or the search's) may take, redirects included. */
  pageTimeoutMs?: number;
};

/** The only hosts requests go to. */
const HOSTS = new Set(["myinstants.com", "www.myinstants.com"]);
const HTML_MAX = 2 * 1024 * 1024;
/** The largest sound taken. */
export const MYINSTANTS_SOUND_MAX = 20 * 1024 * 1024;
/** The longest a sound's download may take. */
export const MYINSTANTS_SOUND_MS = 30_000;
/** The longest a page may take: a bot screen that never answers mustn't hold a download's turn. */
export const MYINSTANTS_PAGE_MS = 20_000;
/** The longest sound kept, in seconds (checked by the caller once the file is probed). */
export const MYINSTANTS_DURATION_MAX = 600;
export const MYINSTANTS_SEARCH_MAX = 20;
const MAX_REDIRECTS = 3;

export const MYINSTANTS_REFUSED =
  "MyInstants refused the request (it may be showing a bot check). Use a sound from the audio catalog or web_media_search instead, or try again later.";

const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

function parse(value: string | URL): URL | null {
  if (value instanceof URL) return new URL(value.href);
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function allowed(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.port && HOSTS.has(url.hostname.toLowerCase());
}

/** A MyInstants sound page (`/<lang>/instant/<slug>/`), as its canonical https address and slug; null for anything else. */
export function myInstantsPage(value: string | URL): { slug: string; url: string } | null {
  const url = parse(value);
  if (!url || !allowed(url)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("instant");
  if (at < 0 || at > 1 || parts.length !== at + 2) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(parts[at + 1]!).toLowerCase();
  } catch {
    return null;
  }
  if (!SLUG.test(slug)) return null;
  const lang = at === 1 && /^[a-z]{2}$/i.test(parts[0]!) ? `${parts[0]!.toLowerCase()}/` : "";
  return { slug, url: `https://www.myinstants.com/${lang}instant/${slug}/` };
}

/**
 * GETs `start` on MyInstants, following up to three redirects that stay on
 * it. Every hop's host must be on the list and resolve to public addresses.
 */
async function get(start: URL, deps: MyInstantsDeps, accept: string): Promise<Response> {
  let url = start;
  for (let hop = 0; ; hop++) {
    if (!allowed(url)) throw new DapiError("invalid-input", "That link leads away from MyInstants, which media_download doesn't follow for its sounds.");
    url.protocol = "https:";
    await resolvePublic(url.hostname, deps.resolve);
    let response: Response;
    try {
      response = await deps.fetch(url.href, { signal: deps.signal, headers: { accept, "accept-language": "en" }, redirect: "manual" });
    } catch (error) {
      if (deps.signal.aborted) throw canceledError(deps.signal);
      throw new DapiError("invalid-input", `Couldn't reach MyInstants (${(error as Error).message}). Check the internet connection, then try once more.`, { cause: error });
    }
    // A client that followed a redirect itself says where it ended up.
    const landed = response.url ? parse(response.url) : null;
    if (landed && !allowed(landed)) {
      await response.body?.cancel().catch(() => {});
      throw new DapiError("invalid-input", "MyInstants redirected away from itself, which media_download doesn't follow.");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) throw new DapiError("unsupported", MYINSTANTS_REFUSED);
      url = new URL(location, url);
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      throw new DapiError("not-found", "MyInstants has no such sound (404). Search MyInstants again for its current link.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new DapiError("unsupported", MYINSTANTS_REFUSED);
    }
    return response;
  }
}

function canceledError(signal: AbortSignal): DapiError {
  const reason: unknown = signal.reason;
  return reason instanceof DapiError ? reason : new DapiError("canceled", "The request was canceled.");
}

/** A MyInstants page's HTML, within the page time limit (the caller's signal still cancels it). */
async function html(url: URL, deps: MyInstantsDeps): Promise<string> {
  const limit = deps.pageTimeoutMs ?? MYINSTANTS_PAGE_MS;
  const bounded = AbortSignal.any([deps.signal, AbortSignal.timeout(limit)]);
  const chunks: Uint8Array[] = [];
  try {
    const response = await get(url, { ...deps, signal: bounded }, "text/html,application/xhtml+xml");
    const reader = response.body?.getReader();
    if (!reader) return "";
    // A client whose body doesn't follow the signal is stopped by hand.
    const stop = () => void reader.cancel().catch(() => {});
    bounded.addEventListener("abort", stop, { once: true });
    let size = 0;
    try {
      while (size <= HTML_MAX) {
        const next = await reader.read();
        if (bounded.aborted) throw bounded.reason;
        if (next.done) break;
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    } finally {
      bounded.removeEventListener("abort", stop);
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (deps.signal.aborted) throw canceledError(deps.signal);
    if (bounded.aborted) throw new DapiError("canceled", `MyInstants took longer than ${Math.round(limit / 1000)} seconds to answer (it may be showing a bot check). Try again later, or use a sound from the audio catalog or web_media_search.`);
    throw error;
  }
  const page = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, HTML_MAX));
  // A bot screen answers 200 with a challenge page.
  if (/cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required!/i.test(page) && !/\/media\/sounds\//i.test(page)) {
    throw new DapiError("unsupported", MYINSTANTS_REFUSED);
  }
  return page;
}

/** A sound file address found on a page, when it is one: on MyInstants, under `/media/sounds/`, an MP3. */
function soundAddress(raw: string, base: URL): string | null {
  const url = parse(new URL(decodeEntities(raw), base));
  if (!url || !allowed(url) || !/^\/media\/sounds\/[^/]+\.mp3$/i.test(url.pathname)) return null;
  url.protocol = "https:";
  url.hash = "";
  url.search = "";
  return url.href;
}

function cleanTitle(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").replace(/\s*[-|]\s*(?:Instant Sound Button\s*\|\s*)?Myinstants\s*$/i, "").trim().slice(0, 200);
}

/** The sound a MyInstants page plays, and its title; throws when the page names none. */
export function parseInstantPage(page: string, pageUrl: string): { title: string; soundUrl: string } {
  const base = new URL(pageUrl);
  const candidates = [
    ...[...page.matchAll(/play\(\s*['"]([^'"]+\.mp3)['"]/gi)].map((match) => match[1]!),
    ...[...page.matchAll(/href\s*=\s*["']([^"']*\/media\/sounds\/[^"']+\.mp3)["']/gi)].map((match) => match[1]!),
  ];
  const soundUrl = candidates.map((raw) => soundAddress(raw, base)).find((url) => url !== null);
  if (!soundUrl) throw new DapiError("not-found", "This MyInstants page doesn't name a sound file. Search MyInstants again and pick another result.");
  const heading = /<h1[^>]*id\s*=\s*["']instant-page-title["'][^>]*>([\s\S]*?)<\/h1>/i.exec(page)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1] ?? "";
  const slug = myInstantsPage(pageUrl)?.slug ?? "";
  return { title: cleanTitle(heading) || slug.replace(/-\d+$/, "").replace(/-/g, " ") || "MyInstants sound", soundUrl };
}

export type MyInstantsSound = { slug: string; title: string; pageUrl: string };

/** The instants a MyInstants search page lists, in order, at most `limit`. */
export function parseSearchPage(page: string, pageUrl: string, limit: number): MyInstantsSound[] {
  const base = new URL(pageUrl);
  const found = new Map<string, MyInstantsSound>();
  for (const match of page.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']*\/instant\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (found.size >= limit) break;
    const link = parse(new URL(decodeEntities(match[1]!), base));
    const sound = link && myInstantsPage(link);
    if (!sound || found.has(sound.slug)) continue;
    const title = cleanTitle(match[2]!) || sound.slug.replace(/-\d+$/, "").replace(/-/g, " ");
    found.set(sound.slug, { slug: sound.slug, title, pageUrl: sound.url });
  }
  return [...found.values()];
}

/** Searches MyInstants for `query`. */
export async function searchMyInstants(query: string, limit: number, deps: MyInstantsDeps): Promise<MyInstantsSound[]> {
  const url = new URL(`https://www.myinstants.com/en/search/?name=${encodeURIComponent(query.trim())}`);
  return parseSearchPage(await html(url, deps), url.href, Math.min(limit, MYINSTANTS_SEARCH_MAX));
}

export type FetchedSound = { slug: string; title: string; pageUrl: string; soundUrl: string; bytes: number; sha256: string };

/**
 * Downloads the sound a MyInstants page plays into `temp` (created; it must
 * not exist): at most 20 MB within 30 seconds, and it must be an MP3.
 */
export async function fetchMyInstantsSound(page: string, temp: string, deps: MyInstantsDeps & { cap?: number; timeoutMs?: number }): Promise<FetchedSound> {
  const target = myInstantsPage(page);
  if (!target) throw new DapiError("invalid-input", "That isn't a MyInstants sound page (https://www.myinstants.com/<lang>/instant/<name>/).");
  const { title, soundUrl } = parseInstantPage(await html(new URL(target.url), deps), target.url);
  const cap = deps.cap ?? MYINSTANTS_SOUND_MAX;
  const bounded = AbortSignal.any([deps.signal, AbortSignal.timeout(deps.timeoutMs ?? MYINSTANTS_SOUND_MS)]);
  const sub = { ...deps, signal: bounded };
  try {
    const response = await get(new URL(soundUrl), sub, "audio/mpeg,audio/*;q=0.9,*/*;q=0.5");
    if (Number(response.headers.get("content-length")) > cap) {
      await response.body?.cancel().catch(() => {});
      throw new DapiError("invalid-input", `This MyInstants sound is larger than ${Math.round(cap / (1024 * 1024))} MB, more than a sound effect should be. Pick another one.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DapiError("invalid-input", "MyInstants sent no file.");
    const hash = createHash("sha256");
    const file = await open(temp, "wx", 0o644);
    let bytes = 0;
    let head = new Uint8Array(0);
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > cap) throw new DapiError("invalid-input", `This MyInstants sound is larger than ${Math.round(cap / (1024 * 1024))} MB, more than a sound effect should be. Pick another one.`);
        if (head.byteLength < 4096) head = Buffer.concat([head, next.value]).subarray(0, 4096);
        hash.update(next.value);
        await file.write(next.value);
      }
      await file.sync();
    } finally {
      await reader.cancel().catch(() => {});
      await file.close().catch(() => {});
    }
    const sniffed = sniff(head);
    if (!bytes || sniffed.kind !== "audio") {
      throw new DapiError("unsupported", "MyInstants answered with something other than a sound file (it may be showing a bot check). Use a sound from the audio catalog or web_media_search instead.");
    }
    return { slug: target.slug, title, pageUrl: target.url, soundUrl, bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (deps.signal.aborted) throw canceledError(deps.signal);
    if (bounded.aborted) throw new DapiError("canceled", "MyInstants took longer than 30 seconds to send the sound. Try again later or pick another one.");
    throw error;
  }
}
