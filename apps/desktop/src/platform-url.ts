/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which platform a link belongs to, and what can be read from the link alone:
// the upload's id (so a repeat download is found without the network), a
// creator's canonical listing page, and the address a search is run against.
// Both media_* and web_media_* ask here, so a platform link is recognized the
// same way whichever tool it was handed to.

import { DapiError } from "@diffusionstudio/dapi";

import type { MediaPlatform } from "@diffusionstudio/dapi";

/** A site media_download knows by name; any other site is `web` until the downloader names it. */
export type Site = "youtube" | "soundcloud" | "tiktok" | "instagram" | "x" | "vimeo" | "myinstants";

export const SITE_NAMES: Record<string, string> = {
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  tiktok: "TikTok",
  instagram: "Instagram",
  x: "X",
  vimeo: "Vimeo",
  myinstants: "MyInstants",
  // Not a Site, as web_media_search results link to its pages: named for the credit of a page the downloader read.
  freesound: "Freesound",
  web: "the web",
};

/** A site's display name; the downloader's own name for one Cutroom has no name for. */
export function siteName(site: string): string {
  return SITE_NAMES[site] ?? site;
}

const SITE_HOSTS: Array<[Site, RegExp]> = [
  ["youtube", /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/],
  ["soundcloud", /(^|\.)(soundcloud\.com|snd\.sc)$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
  ["instagram", /(^|\.)instagram\.com$/],
  ["x", /(^|\.)(x\.com|twitter\.com)$/],
  ["vimeo", /(^|\.)vimeo\.com$/],
  ["myinstants", /(^|\.)myinstants\.com$/],
];

/** Where Instagram serves the files themselves (the Graph API's `media_url`), not its pages. */
const INSTAGRAM_CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;

function parse(value: string | URL): URL | null {
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const host = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "");

/** The known platform a link's host belongs to; null for any other site and for Instagram's file servers. */
export function platformOf(value: string | URL): Site | null {
  const url = parse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const name = host(url);
  return SITE_HOSTS.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

/** Whether a link is a file on Instagram's CDN, as the Graph API hands out for the user's own posts. */
export function isInstagramCdn(value: string | URL): boolean {
  const url = parse(value);
  return !!url && url.protocol === "https:" && INSTAGRAM_CDN.test(host(url));
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The upload a link names, by the id the downloader will give it, when the
 * link alone says: YouTube's watch, short, live, embed and youtu.be forms
 * (YouTube Music too), TikTok and X posts, Instagram posts and reels, Vimeo
 * videos and MyInstants sounds. Null for a profile, a playlist, a short link
 * that needs resolving, or another site.
 */
export function mediaIdOf(value: string | URL): { site: Site; id: string } | null {
  const url = parse(value);
  const site = url && platformOf(url);
  if (!url || !site) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const name = host(url);
  switch (site) {
    case "youtube": {
      const v = url.searchParams.get("v");
      if (name.endsWith("youtu.be")) return parts[0] && YOUTUBE_ID.test(parts[0]) ? { site, id: parts[0] } : null;
      if (parts[0] === "watch" && v && YOUTUBE_ID.test(v)) return { site, id: v };
      if (["shorts", "live", "embed", "v", "e"].includes(parts[0] ?? "") && parts[1] && YOUTUBE_ID.test(parts[1])) return { site, id: parts[1] };
      return null;
    }
    case "tiktok": {
      const at = parts.findIndex((part) => part === "video" || part === "photo");
      return at >= 0 && /^\d{5,30}$/.test(parts[at + 1] ?? "") ? { site, id: parts[at + 1]! } : null;
    }
    case "x": {
      const at = parts.indexOf("status");
      return at >= 0 && /^\d{5,30}$/.test(parts[at + 1] ?? "") ? { site, id: parts[at + 1]! } : null;
    }
    case "instagram": {
      const at = parts.findIndex((part) => ["p", "reel", "reels", "tv"].includes(part));
      return at >= 0 && /^[A-Za-z0-9_-]{5,64}$/.test(parts[at + 1] ?? "") ? { site, id: parts[at + 1]! } : null;
    }
    case "vimeo": {
      if (name.startsWith("player.")) return parts[0] === "video" && /^\d{3,15}$/.test(parts[1] ?? "") ? { site, id: parts[1]! } : null;
      const id = parts.find((part) => /^\d{3,15}$/.test(part));
      return id ? { site, id } : null;
    }
    case "myinstants": {
      const at = parts.indexOf("instant");
      return at >= 0 && /^[a-z0-9][a-z0-9-]{0,120}$/i.test(parts[at + 1] ?? "") ? { site, id: parts[at + 1]!.toLowerCase() } : null;
    }
    default:
      return null;
  }
}

/** The site an extractor of the downloader's belongs to (`Youtube` → `youtube`, `Twitter` → `x`), `web` for its generic one. */
export function siteOfExtractor(key: string | undefined): string {
  const name = (key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!name || name === "generic") return "web";
  if (name.startsWith("youtube")) return "youtube";
  if (name.startsWith("soundcloud")) return "soundcloud";
  if (name.startsWith("tiktok")) return "tiktok";
  if (name.startsWith("instagram")) return "instagram";
  if (name.startsWith("twitter")) return "x";
  if (name.startsWith("vimeo")) return "vimeo";
  return name.slice(0, 32);
}

/**
 * A file name stem for an upload's id: letters, digits, `_` and `-` kept, the
 * rest `_`, at most 80 characters. A YouTube id stays as it is, so
 * `music/<id>.m4a` matches a catalog entry's `youtube:<id>`.
 */
export function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "media";
}

const IMAGE_FILE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|heic|heif)$/i;
const SOUND_OR_VIDEO_FILE = /\.(mp3|m4a|aac|wav|aiff?|flac|ogg|oga|opus|mp4|m4v|mov|webm|mkv)$/i;

/** Whether a link's path ends in an image file name: a still, which media_download doesn't take. */
export function looksLikeImage(value: string | URL): boolean {
  const url = parse(value);
  return !!url && IMAGE_FILE.test(url.pathname);
}

/**
 * Whether a link's path ends in an image, sound or video file name: the file
 * itself rather than a page, even on a platform's own host (MyInstants serves
 * its MP3s from `/media/sounds/`).
 */
export function looksLikeMediaFile(value: string | URL): boolean {
  const url = parse(value);
  return !!url && (IMAGE_FILE.test(url.pathname) || SOUND_OR_VIDEO_FILE.test(url.pathname));
}

// ---------------------------------------------------------------------------
// Creators

const YOUTUBE_TABS = new Set(["videos", "shorts", "streams", "featured", "about", "playlists", "community", "releases", "podcasts", "live", "posts", "courses", "store"]);

export type CreatorTarget = { url: string; handle: string | null };

function invalidCreator(platform: string, forms: string): DapiError {
  return new DapiError("invalid-input", `That isn't a creator Blackout can list on ${platform}: give ${forms}.`);
}

/** The link `creator` was given as, when it is one: http(s) only. */
function creatorUrl(creator: string): URL | null {
  if (!/^https?:\/\//i.test(creator)) return null;
  return parse(creator);
}

/**
 * The page that lists a creator's latest uploads, newest first, from a
 * handle, an id or a profile link. Throws a DapiError naming the forms a
 * platform takes, or saying it has no listing Cutroom can read.
 */
export function creatorTarget(platform: MediaPlatform, creator: string, tab: "videos" | "shorts" | "streams" = "videos"): CreatorTarget {
  const given = creator.trim();
  const link = creatorUrl(given);
  switch (platform) {
    case "youtube":
    case "youtube_music": {
      const forms = "a handle like `@name`, a channel id (`UC…`) or a channel link";
      if (link) {
        if (platformOf(link) !== "youtube") throw invalidCreator("YouTube", forms);
        const parts = link.pathname.split("/").filter(Boolean);
        if (YOUTUBE_TABS.has(parts.at(-1)?.toLowerCase() ?? "")) parts.pop();
        const [first, second] = parts;
        if (parts.length === 1 && /^@[A-Za-z0-9_.-]{3,30}$/.test(first ?? "")) return { url: `https://www.youtube.com/${first}/${tab}`, handle: first! };
        if (parts.length === 2 && ["channel", "c", "user"].includes(first ?? "") && /^[A-Za-z0-9_.-]{1,100}$/.test(second ?? "")) {
          return { url: `https://www.youtube.com/${first}/${second}/${tab}`, handle: null };
        }
        throw invalidCreator("YouTube", forms);
      }
      if (/^UC[A-Za-z0-9_-]{22}$/.test(given)) return { url: `https://www.youtube.com/channel/${given}/${tab}`, handle: null };
      const handle = given.replace(/^@/, "");
      if (/^[A-Za-z0-9_.-]{3,30}$/.test(handle)) return { url: `https://www.youtube.com/@${handle}/${tab}`, handle: `@${handle}` };
      throw invalidCreator("YouTube", forms);
    }
    case "tiktok": {
      const forms = "a handle like `@name` or a profile link";
      let handle = given;
      if (link) {
        if (platformOf(link) !== "tiktok") throw invalidCreator("TikTok", forms);
        handle = link.pathname.split("/").filter(Boolean)[0] ?? "";
        if (!handle.startsWith("@")) throw invalidCreator("TikTok", forms);
      }
      handle = handle.replace(/^@/, "");
      if (!/^[A-Za-z0-9_.]{2,24}$/.test(handle)) throw invalidCreator("TikTok", forms);
      return { url: `https://www.tiktok.com/@${handle}`, handle: `@${handle}` };
    }
    case "soundcloud": {
      const forms = "a profile name (the part after soundcloud.com/) or a profile link";
      let name = given.replace(/^@/, "");
      if (link) {
        if (platformOf(link) !== "soundcloud" || /^(on|api)\./i.test(link.hostname)) throw invalidCreator("SoundCloud", forms);
        name = link.pathname.split("/").filter(Boolean)[0] ?? "";
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || ["search", "discover", "charts", "upload", "you"].includes(name.toLowerCase())) throw invalidCreator("SoundCloud", forms);
      return { url: `https://soundcloud.com/${name.toLowerCase()}/tracks`, handle: name.toLowerCase() };
    }
    case "vimeo": {
      const forms = "a user name (the part after vimeo.com/) or a profile link";
      let name = given.replace(/^@/, "");
      if (link) {
        if (platformOf(link) !== "vimeo") throw invalidCreator("Vimeo", forms);
        name = link.pathname.split("/").filter(Boolean)[0] ?? "";
      }
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name) || /^\d+$/.test(name) || ["channels", "groups", "categories", "search", "watch"].includes(name.toLowerCase())) {
        throw invalidCreator("Vimeo", forms);
      }
      return { url: `https://vimeo.com/${name}/videos`, handle: name };
    }
    case "instagram": {
      const forms = "a handle like `@name` or a profile link";
      let handle = given;
      if (link) {
        if (platformOf(link) !== "instagram") throw invalidCreator("Instagram", forms);
        handle = link.pathname.split("/").filter(Boolean)[0] ?? "";
      }
      handle = handle.replace(/^@/, "");
      if (!/^[A-Za-z0-9._]{1,30}$/.test(handle) || ["p", "reel", "reels", "tv", "explore", "stories"].includes(handle.toLowerCase())) throw invalidCreator("Instagram", forms);
      return { url: `https://www.instagram.com/${handle}/`, handle: `@${handle}` };
    }
    case "x":
      throw new DapiError(
        "unsupported",
        "Blackout can't list an X account's posts. Ask the user for the links to the posts they want, or find them with your own web search (`site:x.com <words> video`), then pass each link to media_download.",
      );
    case "myinstants":
      throw new DapiError("unsupported", "MyInstants has no creator pages to list. Search it with `query` instead.");
  }
}

// ---------------------------------------------------------------------------
// Queries

/**
 * How many results a YouTube search reads to put `limit` of them newest
 * first. YouTube's results page no longer takes a date order (its old `sp`
 * values come back in relevance order), so the newest are picked from a
 * larger relevance pool instead.
 */
export function datePool(limit: number): number {
  return Math.min(50, Math.max(20, limit * 3));
}

/**
 * `query` on `platform` as the downloader's search address, reading `count`
 * results. Throws `unsupported`, with what to do instead, where there is no
 * keyword search.
 */
export function queryTarget(platform: MediaPlatform, query: string, count: number): string {
  const words = query.trim();
  switch (platform) {
    case "youtube":
      return `ytsearch${count}:${words}`;
    case "youtube_music":
      return `https://music.youtube.com/search?q=${encodeURIComponent(words)}#songs`;
    case "soundcloud":
      return `scsearch${count}:${words}`;
    case "myinstants":
      return `https://www.myinstants.com/en/search/?name=${encodeURIComponent(words)}`;
    case "instagram":
      throw new DapiError(
        "unsupported",
        "Blackout can't search Instagram by keyword. Ask the user for reel or post links, or find them with your own web search (`site:instagram.com/reel <words>`), then pass each link to media_download; to list one account's latest posts, pass `creator` instead. For music or general video, search YouTube.",
      );
    case "x":
      throw new DapiError(
        "unsupported",
        "Blackout can't search X. Ask the user for the links to the posts they want, or find them with your own web search (`site:x.com <words> video`), then pass each link to media_download. For music or general video, search YouTube.",
      );
    case "tiktok":
      throw new DapiError(
        "unsupported",
        "Blackout can't search TikTok by keyword. Ask the user for video links, or find them with your own web search (`site:tiktok.com <words>`), then pass each link to media_download; to list one account's latest videos, pass `creator` instead.",
      );
    case "vimeo":
      throw new DapiError(
        "unsupported",
        "Blackout can't search Vimeo by keyword. Pass a Vimeo user as `creator` to list their videos, find links with your own web search (`site:vimeo.com <words>`), or search YouTube.",
      );
  }
}
