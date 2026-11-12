/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `media_search` in the main process: YouTube, YouTube Music and SoundCloud
// keyword searches and creator listings (YouTube, SoundCloud, Vimeo, TikTok,
// Instagram) through the managed downloader's flat listings, and MyInstants
// through its own search page. Nothing is downloaded but the leading
// results' thumbnails, which the result inlines (see dapi/present.ts).
//
// Listings change shape between downloader releases, so every field is read
// as optional: a missing one is null in the result, never a failure.

import { DapiError } from "@diffusionstudio/dapi";
import { creatorTarget, datePool, platformOf, queryTarget } from "./platform-url";
import { runRecovering } from "./media-runner";
import { searchMyInstants } from "./media-download-myinstants";
import { pinnedFetch } from "./web-media";
import { checkWebUrl, hostOf, resolvePublic, systemResolve } from "./web-media-url";
import { decodeEntities, sniff } from "./web-media-sniff";

import type { MediaPlatform, MediaProfile, MediaSearchResult, ToolArgs, ToolResult } from "@diffusionstudio/dapi";
import type { ClassifyDownloaderError, MediaDownloader } from "./media-runner";
import type { PageFetch } from "./media-download-myinstants";
import type { WebFetch } from "./web-media";
import type { Resolve } from "./web-media-url";

export type MediaSearchArgs = ToolArgs<"media_search">;
export type MediaSearchAnswer = ToolResult<"media_search">;

export type MediaSearchTimeouts = {
  /** One flat listing, update and retry not included. */
  listing: number;
  /** A listing that reads every entry's page (TikTok creators). */
  fullListing: number;
  /** One thumbnail. */
  preview: number;
  /** How long an answer is reused for the same arguments. */
  cache: number;
};

const TIMEOUTS: MediaSearchTimeouts = { listing: 45_000, fullListing: 90_000, preview: 10_000, cache: 10 * 60_000 };
const CACHE_MAX = 50;
const PREVIEW_MAX = 1024 * 1024;
const PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const PREVIEW_REDIRECTS = 3;
/** A listing reads each entry's own page at or below this many results, for what a flat listing lacks (TikTok's dates and counts, YouTube Music's channels and durations). */
const FULL_LISTING_MAX = 10;
const TEXT_MAX = 500;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_BEST_EFFORT =
  "Vimeo downloads are best effort: Vimeo lets the downloader fetch most videos only when signed in, which Blackout doesn't do, so media_download may refuse these links. Ask the user for their own copy of one it refuses.";

export type MediaSearchOptions = {
  /** The managed downloader; null when this build has none. */
  downloader: () => MediaDownloader | null;
  classify?: ClassifyDownloaderError;
  /** What thumbnails are fetched with; redirects are followed by the service, each hop checked. */
  fetch?: WebFetch;
  resolve?: Resolve;
  /** What MyInstants pages are fetched with (Electron's `net.fetch` in the app). */
  pageFetch?: PageFetch;
  now?: () => Date;
  timeouts?: Partial<MediaSearchTimeouts>;
  /** The wait before a listing a dropped connection ended is run again. */
  networkRetryMs?: number;
  version?: string;
};

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** A listing's text as one clean line. Some listings are read from the site's HTML (Vimeo's), so their titles arrive with character references (`What&#039;s new`). */
function text(value: unknown, max = TEXT_MAX): string | null {
  if (typeof value !== "string") return null;
  const clean = decodeEntities(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A date from a listing entry: its timestamp (seconds) as ISO, else its YYYYMMDD upload date as YYYY-MM-DD. */
export function publishedAt(entry: Json): string | null {
  for (const key of ["timestamp", "release_timestamp"]) {
    const seconds = entry[key];
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      const date = new Date(seconds * 1000);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  const day = entry.upload_date ?? entry.release_date;
  if (typeof day === "string" && /^\d{8}$/.test(day)) return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  return null;
}

function liveOf(value: unknown): MediaSearchResult["live"] {
  if (value === "is_live") return "live";
  if (value === "is_upcoming") return "upcoming";
  if (value === "was_live" || value === "post_live") return "was_live";
  return "none";
}

/** The largest thumbnail up to 720 px wide (a listing's are ordered smallest first), else the entry's own; YouTube's standard still as the last resort. */
function thumbnailOf(entry: Json, youtubeId: string | null): string | undefined {
  const list = Array.isArray(entry.thumbnails) ? entry.thumbnails.map(object).filter((item): item is Json => item !== null) : [];
  let best: { url: string; width: number } | undefined;
  for (const item of list) {
    const url = httpUrl(item.url);
    if (!url) continue;
    const width = count(item.width) ?? 0;
    if (width > 720) continue;
    if (!best || width >= best.width) best = { url, width };
  }
  return best?.url ?? httpUrl(entry.thumbnail) ?? (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : undefined);
}

/** Whether a listing entry is a channel, playlist or another listing rather than one upload. */
function isListing(entry: Json): boolean {
  if (entry._type === "playlist") return true;
  const key = typeof entry.ie_key === "string" ? entry.ie_key : "";
  if (/(Tab|Playlist|Channel|User|Search|Album)$/i.test(key)) return true;
  const url = typeof entry.url === "string" ? entry.url : "";
  return /youtube\.com\/(?:channel\/|@|c\/|user\/|playlist\?)/i.test(url);
}

/** The page an entry is downloaded from: YouTube's watch page by id; elsewhere the entry's own page, never an API address. */
function pageOf(entry: Json, platform: MediaPlatform, id: string): string | null {
  const youtube = platform === "youtube" || platform === "youtube_music" || /^youtube/i.test(String(entry.ie_key ?? entry.extractor_key ?? ""));
  if (youtube && YOUTUBE_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  const candidates = [entry.webpage_url, entry.permalink_url, entry.original_url, entry.url].map(httpUrl).filter((url): url is string => url !== null);
  const page = candidates.find((url) => !/^https?:\/\/api(?:-v2)?\.soundcloud\.com\//i.test(url) && !/^https?:\/\/api\./i.test(url));
  return page ?? candidates[0] ?? null;
}

type Fallback = { channel: string | null; channelUrl: string | null };

/** One listing entry as a result, or null for one that isn't an upload (a channel, a playlist) or has no id. */
export function mapEntry(value: unknown, platform: MediaPlatform, flat: boolean, fallback: Fallback): Omit<MediaSearchResult, "index"> | null {
  const entry = object(value);
  if (!entry || isListing(entry)) return null;
  const id = typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id) : null;
  if (!id) return null;
  const url = pageOf(entry, platform, id);
  if (!url) return null;
  const youtube = /youtube\.com\/watch/.test(url) ? id : null;
  // YouTube's listings give an upload's age ("3 weeks ago"), which the downloader turns into a rough date: a day, not a time.
  const approximate = flat && (platform === "youtube" || platform === "youtube_music");
  const exact = publishedAt(entry);
  const published = exact && approximate ? exact.slice(0, 10) : exact;
  const thumbnail = thumbnailOf(entry, youtube);
  return {
    id,
    platform,
    title: text(entry.title) ?? text(entry.fulltitle) ?? text(entry.description, 120) ?? id,
    channel: text(entry.channel, 200) ?? text(entry.uploader, 200) ?? text(entry.artist, 200) ?? fallback.channel,
    channelUrl: httpUrl(entry.channel_url) ?? httpUrl(entry.uploader_url) ?? fallback.channelUrl,
    url,
    durationSeconds: count(entry.duration),
    publishedAt: published,
    publishedAtApproximate: published !== null && approximate,
    views: count(entry.view_count),
    likes: count(entry.like_count),
    comments: count(entry.comment_count),
    live: liveOf(entry.live_status),
    ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
  };
}

/** What a creator listing says about the account. */
export function profileOf(listing: Json, platform: MediaPlatform, handle: string | null, url: string): MediaProfile {
  const named = text(listing.channel, 200) ?? text(listing.uploader, 200) ?? text(listing.title, 200)?.replace(/ - (?:Videos|Shorts|Live|Streams|Tracks)$/i, "") ?? null;
  const ownHandle = text(listing.uploader_id, 100);
  return {
    handle: ownHandle?.startsWith("@") ? ownHandle : handle,
    name: named,
    bio: text(listing.description, 2000),
    url: httpUrl(listing.channel_url) ?? httpUrl(listing.uploader_url) ?? httpUrl(listing.webpage_url) ?? url,
    followers: count(listing.channel_follower_count),
    following: null,
    posts: platform === "youtube" || platform === "youtube_music" ? count(listing.playlist_count) : null,
    verified: typeof listing.channel_is_verified === "boolean" ? listing.channel_is_verified : null,
  };
}

/** The downloader's JSON answer: one object, perhaps after lines of other output. */
export function parseListing(stdout: string): Json {
  const trimmed = stdout.trim();
  const candidates = [trimmed, ...trimmed.split("\n").reverse()].filter((line) => line.trim().startsWith("{"));
  for (const candidate of candidates) {
    try {
      const value = object(JSON.parse(candidate));
      if (value) return value;
    } catch {
      // the next candidate
    }
  }
  throw new DapiError("invalid-input", "The downloader's answer couldn't be read. Try again; if it keeps happening, describe it with the report tool.");
}

function canceled(signal: AbortSignal): DapiError {
  const reason: unknown = signal.reason;
  return reason instanceof DapiError ? reason : new DapiError("canceled", "The search was canceled.");
}

type Cached = { at: number; answer: MediaSearchAnswer };

export class MediaSearchService {
  private readonly downloader: () => MediaDownloader | null;
  private readonly classify?: ClassifyDownloaderError;
  private readonly fetch: WebFetch;
  private readonly resolve: Resolve;
  private readonly pageFetch?: PageFetch;
  private readonly now: () => Date;
  private readonly timeouts: MediaSearchTimeouts;
  private readonly networkRetryMs?: number;
  private readonly userAgent: string;
  private readonly cache = new Map<string, Cached>();

  constructor(options: MediaSearchOptions) {
    this.downloader = options.downloader;
    this.classify = options.classify;
    this.resolve = options.resolve ?? systemResolve;
    this.fetch = options.fetch ?? pinnedFetch(this.resolve);
    this.pageFetch = options.pageFetch;
    this.now = options.now ?? (() => new Date());
    this.timeouts = { ...TIMEOUTS, ...options.timeouts };
    this.networkRetryMs = options.networkRetryMs;
    this.userAgent = `Blackout/${options.version ?? "dev"} (desktop video editor)`;
  }

  async search(args: MediaSearchArgs, signal: AbortSignal): Promise<MediaSearchAnswer> {
    const { platform, query, creator, limit } = args;
    if (!query === !creator) {
      throw new DapiError("invalid-input", "Give exactly one of `query` (words to search for) or `creator` (an account whose latest uploads to list).");
    }
    const key = JSON.stringify([platform, query ?? null, creator ?? null, limit, args.sort, args.tab, args.preview]);
    const now = this.now().getTime();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.timeouts.cache) return hit.answer;

    const found = platform === "myinstants" ? await this.myInstants(args, signal) : await this.listing(args, signal);
    const results = found.results.slice(0, limit).map((result, i) => ({ ...result, index: i + 1 }));
    const warnings = [...found.warnings];
    if (!results.length) {
      warnings.push(creator
        ? "The listing came back empty: the account may have no public uploads, or the site hid them. Check the name or link."
        : "Nothing matched. Try other words, or another platform.");
    }
    const previews = await this.previews(results.slice(0, args.preview), signal);
    const answer: MediaSearchAnswer = { platform, profile: found.profile, results, warnings, previews };
    this.cache.delete(key);
    this.cache.set(key, { at: now, answer });
    for (const [stale, entry] of this.cache) if (now - entry.at >= this.timeouts.cache) this.cache.delete(stale);
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return answer;
  }

  private async listing(args: MediaSearchArgs, signal: AbortSignal): Promise<{ profile: MediaProfile | null; results: Array<Omit<MediaSearchResult, "index">>; warnings: string[] }> {
    const { platform, query, creator, limit } = args;
    const warnings: string[] = [];
    // YouTube's search no longer orders by date: the newest of a larger relevance pool go first instead.
    const byDate = !creator && platform === "youtube" && args.sort === "date";
    const count = byDate ? datePool(limit) : limit;
    const target = creator ? creatorTarget(platform, creator, args.tab) : { url: queryTarget(platform, query!, count), handle: null };
    const downloader = this.downloader();
    if (!downloader) throw new DapiError("unsupported", "This build of Blackout has no downloader, so platforms can't be searched. Use web_media_search for openly licensed media.");
    if (creator && (platform === "tiktok" || platform === "instagram")) {
      warnings.push(`${platform === "tiktok" ? "TikTok" : "Instagram"} account listings are best effort: the site often blocks them, and the results may be partial.`);
    }
    // Vimeo lists an account's videos but lets the downloader fetch them only when signed in (yt-dlp 2026.10).
    if (creator && platform === "vimeo") warnings.push(VIMEO_BEST_EFFORT);
    // A TikTok account's flat listing has little but ids, and YouTube Music's songs only titles: reading each entry's page gives the rest.
    const music = !creator && platform === "youtube_music";
    const full = count <= FULL_LISTING_MAX && ((!!creator && platform === "tiktok") || music);
    if (music && !full) warnings.push(`Above ${FULL_LISTING_MAX} results, YouTube Music's listing gives titles only, with no channel or duration; pass a \`limit\` of ${FULL_LISTING_MAX} or less for them.`);
    let listing: Json;
    let flat = !full;
    try {
      listing = await this.run(downloader, target.url, count, flat, platform, signal, warnings);
    } catch (error) {
      // One song that can't be read fails the whole full listing; the plain one still has every title.
      if (!music || flat || signal.aborted || !(error instanceof DapiError) || error.code === "canceled") throw error;
      listing = await this.run(downloader, target.url, count, true, platform, signal, warnings);
      flat = true;
      warnings.push("YouTube Music's songs couldn't each be read, so these results have titles only, with no channel or duration.");
    }
    // SoundCloud's flat search can come back without titles; its entries' own pages have them.
    if (flat && platform === "soundcloud" && count <= FULL_LISTING_MAX && entriesOf(listing).some((entry) => !text(object(entry)?.title))) {
      listing = await this.run(downloader, target.url, count, false, platform, signal, warnings);
      flat = false;
    }
    const fallback: Fallback = creator
      ? { channel: text(listing.channel, 200) ?? text(listing.uploader, 200), channelUrl: httpUrl(listing.channel_url) ?? httpUrl(listing.uploader_url) }
      : { channel: null, channelUrl: null };
    const results = entriesOf(listing).map((entry) => mapEntry(entry, platform, flat, fallback)).filter((result) => result !== null);
    if (byDate) {
      // Newest first, undated last; dates are ISO, so they order as text.
      results.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
      warnings.push(`YouTube no longer sorts a search by upload date, so these are the newest of its ${count} most relevant results; the dates are approximate.`);
    }
    return { profile: creator ? profileOf(listing, platform, target.handle, target.url) : null, results, warnings };
  }

  private async run(downloader: MediaDownloader, target: string, limit: number, flat: boolean, platform: MediaPlatform, signal: AbortSignal, warnings: string[]): Promise<Json> {
    const args = [
      ...(flat ? ["--flat-playlist"] : []),
      "-J",
      "--playlist-end", String(limit),
      "--extractor-args", "youtubetab:approximate_date",
      target,
    ];
    const site = platformOf(target) ?? (platform === "youtube_music" ? "youtube" : platform);
    const run = await runRecovering(downloader, args, {
      signal,
      purpose: "search",
      site,
      timeoutMs: flat ? this.timeouts.listing : this.timeouts.fullListing,
      ...(this.classify ? { classify: this.classify } : {}),
      ...(this.networkRetryMs !== undefined ? { networkRetryMs: this.networkRetryMs } : {}),
    });
    for (const note of run.notes) if (!warnings.includes(note)) warnings.push(note);
    return parseListing(run.stdout);
  }

  private async myInstants(args: MediaSearchArgs, signal: AbortSignal): Promise<{ profile: null; results: Array<Omit<MediaSearchResult, "index">>; warnings: string[] }> {
    if (args.creator) creatorTarget("myinstants", args.creator);
    if (!this.pageFetch) throw new DapiError("unsupported", "MyInstants can't be searched in this build. Use the audio catalog or web_media_search for sound effects.");
    const sounds = await searchMyInstants(args.query!, args.limit, { fetch: this.pageFetch, resolve: this.resolve, signal });
    return {
      profile: null,
      warnings: [],
      results: sounds.map((sound) => ({
        id: sound.slug,
        platform: "myinstants" as const,
        title: sound.title,
        channel: null,
        channelUrl: null,
        url: sound.pageUrl,
        durationSeconds: null,
        publishedAt: null,
        publishedAtApproximate: false,
        views: null,
        likes: null,
        comments: null,
        live: "none" as const,
      })),
    };
  }

  /** Thumbnails of the leading results; one that fails, is too big or isn't a picture is left out without a word. */
  private async previews(results: MediaSearchResult[], signal: AbortSignal): Promise<MediaSearchAnswer["previews"]> {
    const fetched = await Promise.all(results.map(async (result) => {
      if (!result.thumbnailUrl) return null;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.timeouts.preview)]);
      try {
        const image = await this.thumbnail(result.thumbnailUrl, bounded);
        return image ? { index: result.index, ...image } : null;
      } catch {
        if (signal.aborted) throw canceled(signal);
        return null;
      }
    }));
    return fetched.filter((preview) => preview !== null);
  }

  private async thumbnail(start: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    let url = checkWebUrl(start);
    for (let hop = 0; hop <= PREVIEW_REDIRECTS; hop++) {
      await resolvePublic(hostOf(url), this.resolve);
      const response = await this.fetch(url.href, { signal, headers: { "user-agent": this.userAgent, accept: "image/*" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) return null;
        url = checkWebUrl(new URL(location, url));
        continue;
      }
      if (!response.ok || Number(response.headers.get("content-length")) > PREVIEW_MAX) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = await readCapped(response, PREVIEW_MAX);
      if (!bytes) return null;
      const sniffed = sniff(bytes.subarray(0, 4096));
      return "mimeType" in sniffed && PREVIEW_TYPES.has(sniffed.mimeType) ? { bytes, mimeType: sniffed.mimeType } : null;
    }
    return null;
  }
}

function entriesOf(listing: Json): unknown[] {
  return Array.isArray(listing.entries) ? listing.entries : [];
}

/** A response's body, or null once it passes `max` bytes. */
export async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

let singleton: MediaSearchService | undefined;

/** The app's one search service (configured by main.ts; see `configureMediaSearch`). */
export function mediaSearchService(): MediaSearchService {
  return (singleton ??= new MediaSearchService({ downloader: () => null }));
}

/** Sets up the app's search service with what only main.ts has; call once, before any tool runs. */
export function configureMediaSearch(options: MediaSearchOptions): MediaSearchService {
  singleton = new MediaSearchService(options);
  return singleton;
}
