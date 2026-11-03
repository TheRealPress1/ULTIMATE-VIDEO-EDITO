/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What a download really is, from its first bytes rather than what the
// server says it is, and where a web page keeps the media it shares. The
// formats accepted are the ones the editor decodes: Chromium's images, and
// the containers mediabunny reads.

import type { WebMediaKind } from "@diffusionstudio/dapi";

/** How much of a download is read before deciding what it is. */
export const SNIFF_BYTES = 4096;

export type SniffedMedia = { kind: WebMediaKind; mimeType: string; ext: string };
export type Sniffed = SniffedMedia | { kind: "html" } | { kind: "rejected"; reason: string };

export const NOT_MEDIA = "That link isn't an image, video or audio file the editor can use";
const RENDITION = "Choose a JPEG/PNG/WebP rendition of this image.";

const media = (kind: WebMediaKind, mimeType: string, ext: string): SniffedMedia => ({ kind, mimeType, ext });

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let text = "";
  for (let i = from; i < Math.min(to, bytes.length); i++) text += String.fromCharCode(bytes[i]!);
  return text;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** ISO base media (MP4, MOV, M4A, AVIF, HEIC): told apart by the `ftyp` box's brands. */
function sniffFtyp(head: Uint8Array): Sniffed {
  const size = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  const major = ascii(head, 8, 12);
  const brands = [major];
  for (let at = 16; at + 4 <= Math.min(size, head.length, 256); at += 4) brands.push(ascii(head, at, at + 4));
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return media("image", "image/avif", "avif");
  if (["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(major)) {
    return { kind: "rejected", reason: `This is a HEIC image, which the editor can't decode. ${RENDITION}` };
  }
  if (major === "qt  ") return media("video", "video/quicktime", "mov");
  if (/^M4[ABP] $/.test(major)) return media("audio", "audio/mp4", "m4a");
  if (/^M4V/.test(major)) return media("video", "video/x-m4v", "m4v");
  if (/^(jp2 |jpx |jpm |crx )$/.test(major)) return { kind: "rejected", reason: `${NOT_MEDIA} (an unsupported ${major.trim().toUpperCase()} image).` };
  return media("video", "video/mp4", "mp4");
}

function sniffText(head: Uint8Array): Sniffed | null {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(0, SNIFF_BYTES)).replace(/^\uFEFF/, "");
  // A prolog may come first: whitespace, an XML declaration, comments.
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.trimStart().replace(/^<\?xml[\s\S]*?\?>/i, "").replace(/^<!--[\s\S]*?-->/, "");
  }
  if (/^<!doctype\s+svg/i.test(text) || /^<svg[\s>]/i.test(text)) return media("image", "image/svg+xml", "svg");
  if (/^<!doctype\s+html|^<(html|head|body|meta|title|script|link|style|div|p|br|a|base|iframe|noscript|h1)[\s>/]/i.test(text)) return { kind: "html" };
  return null;
}

/**
 * What the first bytes of a download are: a supported image, video or audio
 * format (with its MIME type and the extension to save it under), a web page,
 * or something to refuse, with a reason an agent can act on.
 */
export function sniff(head: Uint8Array, prefer: "image" | "video" = "image"): Sniffed {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return media("image", "image/jpeg", "jpg");
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return media("image", "image/png", "png");
  if (/^GIF8[79]a$/.test(ascii(head, 0, 6))) return media("image", "image/gif", "gif");
  const riff = ascii(head, 0, 4);
  if (riff === "RIFF" || riff === "RF64") {
    const form = ascii(head, 8, 12);
    if (form === "WEBP") return media("image", "image/webp", "webp");
    if (form === "WAVE") return media("audio", "audio/wav", "wav");
    return { kind: "rejected", reason: `${NOT_MEDIA} (an unsupported ${form.trim() || "RIFF"} file).` };
  }
  if (ascii(head, 4, 8) === "ftyp") return sniffFtyp(head);
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(head, 0, 64).includes("webm") ? media("video", "video/webm", "webm") : media("video", "video/x-matroska", "mkv");
  }
  if (ascii(head, 0, 4) === "OggS") {
    const page = ascii(head, 0, 512);
    return page.includes("theora") || page.includes("OVP80") || prefer === "video" && !/vorbis|OpusHead|FLAC/.test(page)
      ? media("video", "video/ogg", "ogv")
      : media("audio", "audio/ogg", "ogg");
  }
  if (ascii(head, 0, 4) === "fLaC") return media("audio", "audio/flac", "flac");
  if (ascii(head, 0, 3) === "ID3") return media("audio", "audio/mpeg", "mp3");
  if (head.length > 188 && head[0] === 0x47 && head[188] === 0x47 && (head.length <= 376 || head[376] === 0x47)) {
    return media("video", "video/mp2t", "ts");
  }
  if (head[0] === 0xff && head.length > 2) {
    const second = head[1]!;
    if ((second & 0xf6) === 0xf0) return media("audio", "audio/aac", "aac"); // ADTS: MPEG sync with layer 0
    if ((second & 0xe0) === 0xe0 && (second & 0x06) !== 0 && head[2]! >> 4 !== 0x0f) return media("audio", "audio/mpeg", "mp3");
  }
  if (ascii(head, 0, 2) === "BM" && head.length >= 14 && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) {
    return media("image", "image/bmp", "bmp");
  }
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: "rejected", reason: `This is a TIFF image, which the editor can't decode. ${RENDITION}` };
  }
  const text = sniffText(head);
  if (text) return text;
  if (ascii(head, 0, 5) === "%PDF-") return { kind: "rejected", reason: `${NOT_MEDIA} (it is a PDF document).` };
  return { kind: "rejected", reason: `${NOT_MEDIA}.` };
}

// ---------------------------------------------------------------------------
// Web pages

export type SharedMedia = {
  /** Media the page declares for sharing, absolute, best first: its video when preferred, then its image; the first few only. */
  candidates: string[];
  title?: string;
};

/** The named references decoded: markup's own, and the quotes, dashes and signs titles are written with. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
};

/** HTML character references decoded, for attribute values and titles. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

// A page is anyone's text, read on the main process: everything below runs in
// time linear in its length, so no page can stall the app. No pattern here
// can scan past where the next one starts; a tag is cut out by the nearest
// `>` and read character by character, and one longer than `TAG_MAX` is
// skipped rather than read. A page may repeat a tag tens of thousands of
// times: only the first `VALUES_MAX` values of each key are kept, appended in
// place, and resolving them stops at `CANDIDATES_MAX` candidates.

/** The longest tag read for its attributes; no shared link needs more. */
const TAG_MAX = 32 * 1024;
/** The most of a `<title>` read. */
const TITLE_MAX = 4 * 1024;
/** The candidates a page yields: more than a download tries. */
const CANDIDATES_MAX = 8;
/** The values kept of one share key, or of `<link rel="image_src">`; a page that names more is listing a gallery, or stalling. */
const VALUES_MAX = 16;
/** The tags read, by name; `\b` as before, so `<meta/>` and `<meta-x>` count, `<metadata>` doesn't. */
const TAG = /<(meta|link|base|title)\b/iy;
const TITLE_END = /<\/title\s*>/gi;

const isSpace = (char: string): boolean => char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";

/**
 * A tag's attributes that have a value, by lowercase name, first one winning,
 * values decoded and trimmed. One pass over the tag, whatever it holds.
 */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  const end = tag.endsWith(">") ? tag.length - 1 : tag.length;
  let at = 1;
  // The tag's name.
  while (at < end && !isSpace(tag[at]!) && tag[at] !== "/") at++;
  while (at < end) {
    while (at < end && (isSpace(tag[at]!) || tag[at] === "/")) at++;
    const start = at;
    while (at < end && !isSpace(tag[at]!) && tag[at] !== "/" && tag[at] !== "=") at++;
    // A lone `=` names nothing; step over it.
    if (at === start) { at++; continue; }
    const name = tag.slice(start, at).toLowerCase();
    while (at < end && isSpace(tag[at]!)) at++;
    if (tag[at] !== "=") continue;
    at++;
    while (at < end && isSpace(tag[at]!)) at++;
    let value: string;
    const quote = tag[at];
    if (quote === "\"" || quote === "'") {
      const close = tag.indexOf(quote, at + 1);
      const stop = close < 0 || close > end ? end : close;
      value = tag.slice(at + 1, stop);
      at = stop + 1;
    } else {
      const from = at;
      while (at < end && !isSpace(tag[at]!) && tag[at] !== "\"" && tag[at] !== "'") at++;
      value = tag.slice(from, at);
    }
    if (!found.has(name)) found.set(name, decodeEntities(value).trim());
  }
  return found;
}

/**
 * The page's `<meta>`, `<link>`, `<base>` and first `<title>` tags, in order,
 * each from its `<` to the nearest `>`. The search for that `>` resumes where
 * the last one ended, so the whole page is looked through once.
 */
function* tags(html: string): Generator<{ name: string; tag: string; end: number }> {
  // The nearest `>` after the current tag's `<`, found once for every tag it ends or skips.
  let close = -1;
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", at + 1)) {
    TAG.lastIndex = at;
    const match = TAG.exec(html);
    if (!match) continue;
    if (close < at) {
      close = html.indexOf(">", at);
      // No `>` left: no tag left to read either.
      if (close < 0) return;
    }
    if (close - at > TAG_MAX) continue;
    yield { name: match[1]!.toLowerCase(), tag: html.slice(at, close + 1), end: close + 1 };
    at = close;
  }
}

const VIDEO_KEYS = ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"];
const IMAGE_KEYS = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];

/**
 * The media a web page declares for sharing (Open Graph, Twitter cards, and
 * `<link rel="image_src">`), resolved against the page (or its `<base>`).
 * Video comes first only when it is preferred; the image always follows, so
 * a page whose video is a player still yields its picture.
 */
export function sharedMedia(html: string, page: URL, prefer: "image" | "video" = "image"): SharedMedia {
  const head = html.slice(0, 2 * 1024 * 1024);
  const meta = new Map<string, string[]>();
  const imageLinks: string[] = [];
  let base = page;
  let baseSeen = false;
  let titleTag: string | undefined;
  let titleSeen = false;
  for (const { name, tag, end } of tags(head)) {
    if (name === "title") {
      // The first title only: it is the one a later `</title>` closes.
      if (titleSeen) continue;
      titleSeen = true;
      TITLE_END.lastIndex = end;
      const closing = TITLE_END.exec(head);
      if (closing) titleTag = head.slice(end, Math.min(closing.index, end + TITLE_MAX));
      continue;
    }
    const attrs = attributes(tag);
    if (name === "meta") {
      const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop") ?? "").toLowerCase();
      const content = attrs.get("content");
      if (!key || !content) continue;
      const values = meta.get(key);
      if (!values) meta.set(key, [content]);
      else if (values.length < VALUES_MAX) values.push(content);
      continue;
    }
    const href = attrs.get("href");
    if (!href) continue;
    if (name === "base") {
      // The first `<base href>` is the page's, as in a browser.
      if (baseSeen) continue;
      baseSeen = true;
      try { base = new URL(href, page); } catch { /* an unusable base leaves the page's own */ }
    } else if (imageLinks.length < VALUES_MAX && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("image_src")) {
      imageLinks.push(href);
    }
  }
  const keys = prefer === "video" ? [...VIDEO_KEYS, ...IMAGE_KEYS] : IMAGE_KEYS;
  const candidates = new Set<string>();
  found: for (const values of [...keys.map((key) => meta.get(key) ?? []), imageLinks]) {
    for (const value of values) {
      if (candidates.size >= CANDIDATES_MAX) break found;
      let url: URL;
      try { url = new URL(value, base); } catch { continue; }
      if (url.protocol === "http:" || url.protocol === "https:") candidates.add(url.href);
    }
  }
  const title = [meta.get("og:title")?.[0], meta.get("twitter:title")?.[0], titleTag && decodeEntities(titleTag)]
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .find((value) => value);
  return { candidates: [...candidates], ...(title ? { title: title.slice(0, 200) } : {}) };
}
