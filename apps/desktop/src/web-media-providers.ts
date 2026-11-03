/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The search providers, as plain functions over their documented JSON: the
// request URL for a query, and the response read into results with one
// license vocabulary. Openverse indexes openly licensed works from many
// sources (no video); Wikimedia Commons hosts only free works.

import { decodeEntities } from "./web-media-sniff";

import type { ToolArgs, WebMediaKind, WebMediaLicense, WebMediaProvider, WebMediaResult } from "@diffusionstudio/dapi";

export type SearchArgs = ToolArgs<"web_media_search">;
/** A result before it has its place in the interleaved list. */
export type ProviderResult = Omit<WebMediaResult, "index" | "previewPath">;

export const OPENVERSE_API = "https://api.openverse.org/v1";
export const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";

/** Openverse's anonymous page size limit. */
const OPENVERSE_PAGE_MAX = 20;
/**
 * The widths Commons renders an image at (thumb.wikimedia.org): any other
 * width answers 400, so every rendition asked for is one of these.
 */
export const WIKIMEDIA_WIDTHS = [120, 250, 330, 500, 960, 1280, 1920, 3840] as const;
/** Widest rendition taken from Commons: 4K, larger than any frame the editor exports. */
const WIKIMEDIA_MAX_WIDTH = 3840;
/** The thumbnails a search inlines. */
const WIKIMEDIA_THUMB_WIDTH = 500;
const TEXT_MAX = 200;

export const PROVIDER_NAMES: Record<WebMediaProvider, string> = { openverse: "Openverse", wikimedia: "Wikimedia Commons" };

// ---------------------------------------------------------------------------
// Licenses

type Terms = { label: string; attributionRequired: boolean; shareAlike: boolean; commercialUse: boolean; modificationsAllowed: boolean };

const TERMS: Record<string, Terms> = {
  cc0: { label: "CC0", attributionRequired: false, shareAlike: false, commercialUse: true, modificationsAllowed: true },
  pdm: { label: "Public Domain Mark", attributionRequired: false, shareAlike: false, commercialUse: true, modificationsAllowed: true },
  "public-domain": { label: "Public domain", attributionRequired: false, shareAlike: false, commercialUse: true, modificationsAllowed: true },
  by: { label: "CC BY", attributionRequired: true, shareAlike: false, commercialUse: true, modificationsAllowed: true },
  "by-sa": { label: "CC BY-SA", attributionRequired: true, shareAlike: true, commercialUse: true, modificationsAllowed: true },
  "by-nd": { label: "CC BY-ND", attributionRequired: true, shareAlike: false, commercialUse: true, modificationsAllowed: false },
  "by-nc": { label: "CC BY-NC", attributionRequired: true, shareAlike: false, commercialUse: false, modificationsAllowed: true },
  "by-nc-sa": { label: "CC BY-NC-SA", attributionRequired: true, shareAlike: true, commercialUse: false, modificationsAllowed: true },
  "by-nc-nd": { label: "CC BY-NC-ND", attributionRequired: true, shareAlike: false, commercialUse: false, modificationsAllowed: false },
  // Sampling+ allows reuse in new works, but not the whole work commercially.
  "sampling+": { label: "CC Sampling+", attributionRequired: true, shareAlike: false, commercialUse: false, modificationsAllowed: true },
  "nc-sampling+": { label: "CC NC-Sampling+", attributionRequired: true, shareAlike: false, commercialUse: false, modificationsAllowed: true },
  gfdl: { label: "GFDL", attributionRequired: true, shareAlike: true, commercialUse: true, modificationsAllowed: true },
  fal: { label: "Free Art License", attributionRequired: true, shareAlike: true, commercialUse: true, modificationsAllowed: true },
  ogl: { label: "Open Government Licence", attributionRequired: true, shareAlike: false, commercialUse: true, modificationsAllowed: true },
  attribution: { label: "Attribution", attributionRequired: true, shareAlike: false, commercialUse: true, modificationsAllowed: true },
};

/** A link's license when it is not a search result: nothing is known, so nothing is assumed. */
export const UNKNOWN_LICENSE: WebMediaLicense = {
  code: "unknown", name: "Unknown license", attributionRequired: true, shareAlike: false, commercialUse: false, modificationsAllowed: false, verified: false,
};

/**
 * The license Cutroom's curated audio catalog records as `rights`, with the
 * version its credit line names (`CC BY 4.0`). Null for rights that name no
 * terms to check (copyrighted, royalty-free, unknown): those stay unverified.
 */
export function catalogLicense(rights: string, attribution?: string): WebMediaLicense | null {
  const version = /\bCC BY(?:-SA)?\s+(\d+\.\d+)\b/i.exec(attribution ?? "")?.[1];
  if (rights === "cc0") return license("cc0", "1.0");
  if (rights === "public-domain") return license("public-domain");
  if (rights === "cc-by") return license("by", version);
  if (rights === "cc-by-sa") return license("by-sa", version);
  return null;
}

/** Creative Commons' canonical deed for a code and version, when the provider gives none. */
function ccUrl(code: string, version: string | undefined): string | undefined {
  if (code === "cc0") return "https://creativecommons.org/publicdomain/zero/1.0/";
  if (code === "pdm") return "https://creativecommons.org/publicdomain/mark/1.0/";
  if (code === "sampling+" || code === "nc-sampling+") return `https://creativecommons.org/licenses/${code}/1.0/`;
  if (TERMS[code] && code.startsWith("by") && version) return `https://creativecommons.org/licenses/${code}/${version}/`;
  return undefined;
}

function license(code: string, version?: string, url?: string): WebMediaLicense | null {
  const terms = TERMS[code];
  if (!terms) return null;
  const { label, ...flags } = terms;
  const v = version && /^\d+(\.\d+)?$/.test(version) ? version : code === "cc0" || code === "pdm" ? "1.0" : undefined;
  const link = httpUrl(url) ?? ccUrl(code, v);
  return { code, name: v ? `${label} ${v}` : label, ...(v ? { version: v } : {}), ...(link ? { url: link } : {}), ...flags, verified: true };
}

/** Openverse's license fields as one license; null for a code it does not document. */
export function openverseLicense(code: unknown, version: unknown, url: unknown): WebMediaLicense | null {
  if (typeof code !== "string") return null;
  return license(code.toLowerCase(), typeof version === "string" ? version : undefined, typeof url === "string" ? url : undefined);
}

type ExtMetadata = Record<string, { value?: unknown } | undefined>;

/**
 * A Commons file's license, from its machine-readable `License` (`cc-by-sa-4.0`,
 * `pd`, `cc0`) or else its `LicenseShortName` (`CC BY-SA 4.0`). Null for
 * anything not recognizably free, and for files Commons marks non-free.
 */
export function wikimediaLicense(meta: ExtMetadata | undefined): WebMediaLicense | null {
  const value = (key: string) => plainText(meta?.[key]?.value);
  if (/^true$/i.test(value("NonFree"))) return null;
  const machine = value("License").toLowerCase();
  const short = value("LicenseShortName");
  const url = value("LicenseUrl") || undefined;
  const cc = /^cc-(by(?:-nc)?(?:-sa|-nd)?)(?:-(\d+(?:\.\d+)?))?/.exec(machine) ?? /^cc[- ](by(?:-nc)?(?:-sa|-nd)?)(?:[- ](\d+(?:\.\d+)?))?\b/i.exec(short);
  if (/^(cc0|cc-zero)/.test(machine) || /^cc0|^cc zero/i.test(short)) return license("cc0", "1.0", url);
  if (cc) return license(cc[1]!.toLowerCase(), cc[2], url);
  if (/^pd\b|^pd-/.test(machine) || /^public domain/i.test(short)) return license("public-domain", undefined, url);
  if (/^gfdl/.test(machine) || /^gfdl/i.test(short)) return license("gfdl", /gfdl-(\d+\.\d+)/.exec(machine)?.[1], url);
  if (/^fal/.test(machine) || /free art licen[cs]e/i.test(short)) return license("fal", undefined, url);
  if (/^ogl/.test(machine) || /^ogl\b|open government licen[cs]e/i.test(short)) return license("ogl", /ogl-?(\d+(?:\.\d+)?)/.exec(machine)?.[1], url);
  if (machine === "attribution" || /^attribution$/i.test(short)) return license("attribution", undefined, url);
  return null;
}

/** Whether a license fits the search's `license` filter. */
export function licenseAllowed(terms: WebMediaLicense, filter: SearchArgs["license"]): boolean {
  if (filter === "any") return true;
  if (filter === "editable") return terms.modificationsAllowed;
  return terms.commercialUse && terms.modificationsAllowed;
}

/** A credit in the TASL form: title, author, source, license. */
export function attributionLine(work: { title: string; creator?: string; pageUrl?: string; fileUrl?: string; license: WebMediaLicense }): string {
  const { license: terms } = work;
  const where = work.pageUrl ?? work.fileUrl;
  const subject = `"${work.title}"${work.creator ? ` by ${work.creator}` : ""}${where ? ` (${where})` : ""}`;
  if (terms.code === "unknown") return `${subject}, license not verified: confirm the rights before publishing.`;
  if (terms.code === "cc0") return `${subject}, dedicated to the public domain under ${terms.name}${terms.url ? ` (${terms.url})` : ""}.`;
  if (terms.code === "pdm" || terms.code === "public-domain") return `${subject}, in the public domain${terms.code === "pdm" ? ` (${terms.name})` : ""}.`;
  return `${subject}, licensed under ${terms.name}${terms.url ? ` (${terms.url})` : ""}.`;
}

// ---------------------------------------------------------------------------
// Shared helpers

/** HTML (Commons' artist and title fields hold links and spans) as one line of plain text. */
export function plainText(value: unknown, max = TEXT_MAX): string {
  if (typeof value !== "string") return "";
  // `[^<>]`, not `[^>]`: a run of unclosed `<` costs one pass, not one per `<`.
  const text = decodeEntities(value.replace(/<[^<>]*>/g, " ")).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An absolute http(s) URL, normalized; undefined for anything else. */
export function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.round(value) : undefined;

const seconds = (value: unknown, scale = 1): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round((value / scale) * 1000) / 1000 : undefined;

function orientationFits(width: number | undefined, height: number | undefined, orientation: SearchArgs["orientation"]): boolean {
  if (orientation === "any" || !width || !height) return true;
  const ratio = width / height;
  if (orientation === "square") return ratio >= 0.9 && ratio <= 1.1;
  return orientation === "landscape" ? ratio > 1.1 : ratio < 0.9;
}

/**
 * A URL as two spellings of one link compare: normalized, without its
 * fragment or its `utm_*` tracking parameters (Commons adds those to the
 * URLs its API returns; Openverse's copies of them have none). Null for
 * anything that is not a URL. Only for comparing: the link fetched is the
 * one given.
 */
export function urlKey(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  url.hash = "";
  const tracking = [...url.searchParams.keys()].filter((key) => /^utm_/i.test(key));
  for (const key of tracking) url.searchParams.delete(key);
  return url.href;
}

const COMMONS_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);
/** `/wikipedia/commons/[thumb/]x/xy/<file>[/<rendition>]`: a Commons file, or one of its renditions. */
const COMMONS_FILE = /^\/([^/]+\/[^/]+)\/(?:thumb\/)?([0-9a-f]\/[0-9a-f]{2}\/[^/]+)(?:\/[^/]+)?$/;

/**
 * What identifies the file a result downloads, across providers: its URL's
 * key, and for a Commons file the file itself, whichever host or rendition
 * serves it (Commons' own result may be a rendition of the original
 * Openverse links to).
 */
export function fileKey(value: string): string {
  const key = urlKey(value) ?? value;
  const url = new URL(key);
  const file = COMMONS_HOSTS.has(url.hostname) ? COMMONS_FILE.exec(url.pathname) : null;
  if (!file) return key;
  let path = `${file[1]}/${file[2]}`;
  try { path = decodeURIComponent(path); } catch { /* compared as spelled */ }
  return `commons:${path}`;
}

/**
 * Results from several providers, alternating so the first screen shows each,
 * without repeating a file (Openverse indexes Commons too), numbered from 1.
 * A file both list takes the place of whichever comes first, but as Commons
 * gives it: Openverse links a Commons file's original, which may be a TIFF
 * the editor can't decode or wider than 4K, where Commons' own result is the
 * rendition to download.
 */
export function interleave(lists: ProviderResult[][], limit: number): WebMediaResult[] {
  const order: Array<{ key: string; result: ProviderResult }> = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const result = list[i];
      if (result) order.push({ key: fileKey(result.url), result });
    }
  }
  // Each file as given first, or as Commons gives it.
  const chosen = new Map<string, ProviderResult>();
  for (const { key, result } of order) {
    const held = chosen.get(key);
    if (!held || (held.provider !== "wikimedia" && result.provider === "wikimedia")) chosen.set(key, result);
  }
  const results: WebMediaResult[] = [];
  for (const { key } of order) {
    if (results.length >= limit) break;
    const result = chosen.get(key);
    // Placed already, where the file first came.
    if (!result) continue;
    chosen.delete(key);
    results.push({ index: results.length + 1, ...result });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Openverse

const OPENVERSE_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", mp4: "audio/mp4",
};

/** The search URL; null for video, which Openverse does not index. */
export function openverseUrl(args: SearchArgs): string | null {
  if (args.kind === "video") return null;
  const params = new URLSearchParams({ q: args.query, page_size: String(Math.min(OPENVERSE_PAGE_MAX, args.limit)), mature: "false" });
  if (args.license === "editable") params.set("license_type", "modification");
  if (args.license === "commercial") params.set("license_type", "commercial,modification");
  if (args.kind === "image" && args.orientation !== "any") {
    params.set("aspect_ratio", { landscape: "wide", portrait: "tall", square: "square" }[args.orientation]);
  }
  return `${OPENVERSE_API}/${args.kind === "audio" ? "audio" : "images"}/?${params}`;
}

/** Openverse's `{ results: [...] }` as results, leaving out what has no usable file or license. */
export function parseOpenverse(json: unknown, args: SearchArgs): ProviderResult[] {
  const rows = (json as { results?: unknown })?.results;
  if (!Array.isArray(rows)) throw new Error("Openverse answered with an unexpected response.");
  const kind: WebMediaKind = args.kind === "audio" ? "audio" : "image";
  const results: ProviderResult[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    if (!row || typeof row !== "object" || row.mature === true) continue;
    const url = httpUrl(row.url);
    const terms = openverseLicense(row.license, row.license_version, row.license_url);
    if (!url || !terms || !licenseAllowed(terms, args.license)) continue;
    const width = positiveInt(row.width);
    const height = positiveInt(row.height);
    const title = plainText(row.title) || "Untitled";
    const creator = plainText(row.creator) || undefined;
    const pageUrl = httpUrl(row.foreign_landing_url) ?? httpUrl(row.detail_url) ?? url;
    const filetype = typeof row.filetype === "string" ? row.filetype.toLowerCase() : "";
    const mimeType = OPENVERSE_TYPES[filetype];
    const source = plainText(row.source ?? row.provider, 60) || undefined;
    results.push({
      id: `openverse:${String(row.id ?? url)}`,
      kind,
      title,
      provider: "openverse",
      ...(source ? { source } : {}),
      url,
      ...(httpUrl(row.thumbnail) ? { thumbnailUrl: httpUrl(row.thumbnail) } : {}),
      pageUrl,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      // Openverse reports audio duration in milliseconds.
      ...(kind === "audio" && seconds(row.duration, 1000) ? { durationSeconds: seconds(row.duration, 1000) } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(creator ? { creator } : {}),
      license: terms,
      attribution: attributionLine({ title, creator, pageUrl, license: terms }),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Wikimedia Commons

const COMMONS_FILETYPE: Record<WebMediaKind, string> = { image: "bitmap", video: "video", audio: "audio" };
/** Formats served as they are; anything else (TIFF, XCF, very large originals) comes as a rendered JPEG or PNG. */
const WEB_IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** What the editor decodes: WebM (VP8/VP9/AV1); Theora .ogv and MPEG-1 are not. */
const COMMONS_VIDEO = new Set(["video/webm", "video/mp4"]);
const COMMONS_AUDIO = new Set(["audio/mpeg", "audio/ogg", "application/ogg", "audio/wav", "audio/x-wav", "audio/flac", "audio/x-flac", "audio/webm", "audio/mp4"]);

export function wikimediaUrl(args: SearchArgs): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: `${args.query} filetype:${COMMONS_FILETYPE[args.kind]}`,
    // Some results are filtered out here (license, format, orientation): ask for more.
    gsrlimit: String(Math.min(50, args.limit * 2 + 4)),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(WIKIMEDIA_THUMB_WIDTH),
    iiextmetadatafilter: "Artist|ObjectName|License|LicenseShortName|LicenseUrl|NonFree",
  });
  return `${WIKIMEDIA_API}?${params}`;
}

/** A rendition's path: `…/[lossy-|lossless-][pageN-]<width>px-<name>`. */
const RENDITION = /^(.*\/)((?:lossy-|lossless-)?(?:page\d+-)?)(\d+)px-([^/]+)$/;

/** The widest width Commons renders that is no wider than `width`; never under its narrowest. */
export function wikimediaWidth(width: number): number {
  let fit: number = WIKIMEDIA_WIDTHS[0];
  for (const standard of WIKIMEDIA_WIDTHS) if (standard <= width) fit = standard;
  return fit;
}

/** The width of a Commons rendition URL (`…/500px-Name.jpg`); null when it is not one. */
export function renditionWidth(value: string): number | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const match = RENDITION.exec(url.pathname);
  return match ? Number(match[3]) : null;
}

/** Whether `url` is a Commons rendition, which Commons serves at its standard widths only. */
export function isWikimediaRendition(url: URL): boolean {
  return COMMONS_HOSTS.has(url.hostname) && /\/thumb\//.test(url.pathname) && RENDITION.test(url.pathname);
}

/**
 * A Commons rendition URL (`…/500px-Name.jpg`) at another width, its query
 * kept; null when it is not one. The width should be a standard one (see
 * `wikimediaWidth`): Commons refuses any other.
 */
export function wikimediaRendition(thumbUrl: string, width: number): string | null {
  let url: URL;
  try { url = new URL(thumbUrl); } catch { return null; }
  const match = RENDITION.exec(url.pathname);
  if (!match) return null;
  url.pathname = `${match[1]}${match[2]}${width}px-${match[4]}`;
  return url.href;
}

/**
 * The API's thumbnail as Commons serves it: at its own width when that is a
 * standard one, else at the standard width below. An image narrower than the
 * width asked for has the original as its thumbnail, kept as it is, whatever
 * its name (`220px-Name.jpg` is a file's name too).
 */
function standardThumbnail(thumbUrl: string): string {
  if (!isWikimediaRendition(new URL(thumbUrl))) return thumbUrl;
  const width = renditionWidth(thumbUrl);
  if (width === null || width < WIKIMEDIA_WIDTHS[0] || (WIKIMEDIA_WIDTHS as readonly number[]).includes(width)) return thumbUrl;
  return wikimediaRendition(thumbUrl, wikimediaWidth(width)) ?? thumbUrl;
}

const extensionType = (url: string): string | undefined => {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : undefined;
};

type CommonsPage = { pageid?: number; title?: string; index?: number; imageinfo?: Array<Record<string, unknown>> };

/**
 * The API's `query.pages` (an array in format version 2, an object keyed by
 * page id in version 1), in search order, as results. Images point at a
 * rendition no wider than 4K, at a width Commons renders, in a format the
 * editor decodes; files without a recognizable free license are left out.
 */
export function parseWikimedia(json: unknown, args: SearchArgs): ProviderResult[] {
  const body = json as { query?: { pages?: unknown }; error?: { info?: string } };
  if (body?.error) throw new Error(`Wikimedia Commons refused the search: ${plainText(body.error.info) || "unknown error"}`);
  const raw = body?.query?.pages;
  // No matches come back as no `query` at all.
  if (raw === undefined) return [];
  const pages = (Array.isArray(raw) ? raw : Object.values(raw as object)) as CommonsPage[];
  pages.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  const results: ProviderResult[] = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (!info) continue;
    const mime = typeof info.mime === "string" ? info.mime.toLowerCase() : "";
    const original = httpUrl(info.url);
    const apiThumb = httpUrl(info.thumburl);
    const thumb = apiThumb && standardThumbnail(apiThumb);
    const width = positiveInt(info.width);
    const height = positiveInt(info.height);
    if (!original) continue;
    let url = original;
    let mimeType = mime || undefined;
    if (args.kind === "image") {
      if (!mime.startsWith("image/") || !orientationFits(width, height, args.orientation)) continue;
      if (!WEB_IMAGES.has(mime) || (width ?? 0) > WIKIMEDIA_MAX_WIDTH) {
        // As wide as the original, up to 4K, rounded down to a width Commons renders (it refuses a 1237 px one).
        const rendition = thumb && isWikimediaRendition(new URL(thumb))
          && wikimediaRendition(thumb, wikimediaWidth(Math.min(width ?? WIKIMEDIA_MAX_WIDTH, WIKIMEDIA_MAX_WIDTH)));
        if (!rendition) continue;
        url = rendition;
        mimeType = extensionType(rendition) ?? mimeType;
      }
    } else if (!(args.kind === "video" ? COMMONS_VIDEO : COMMONS_AUDIO).has(mime)) {
      continue;
    }
    const terms = wikimediaLicense(info.extmetadata as ExtMetadata | undefined);
    if (!terms || !licenseAllowed(terms, args.license)) continue;
    const meta = info.extmetadata as ExtMetadata | undefined;
    const fileName = (page.title ?? "").replace(/^File:/i, "");
    const title = plainText(meta?.ObjectName?.value) || plainText(fileName.replace(/\.[a-z0-9]+$/i, "")) || "Untitled";
    const creator = plainText(meta?.Artist?.value) || undefined;
    const pageUrl = httpUrl(info.descriptionurl) ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent((page.title ?? "").replace(/ /g, "_"))}`;
    const rendered = url !== original ? renditionWidth(url) : null;
    const scaled = rendered && width && height && width > rendered
      ? { width: rendered, height: Math.round((height * rendered) / width) }
      : { ...(width ? { width } : {}), ...(height ? { height } : {}) };
    results.push({
      id: `wikimedia:${page.pageid ?? fileName}`,
      kind: args.kind,
      title,
      provider: "wikimedia",
      url,
      ...(thumb && args.kind !== "audio" ? { thumbnailUrl: thumb } : {}),
      pageUrl,
      ...(args.kind === "audio" ? {} : scaled),
      ...(args.kind !== "image" && seconds(info.duration) ? { durationSeconds: seconds(info.duration) } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(creator ? { creator } : {}),
      license: terms,
      attribution: attributionLine({ title, creator, pageUrl, license: terms }),
    });
  }
  return results;
}
