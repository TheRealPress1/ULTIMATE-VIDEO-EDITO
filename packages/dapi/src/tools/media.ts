/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Video and audio from platforms: `media_search` lists what YouTube, YouTube
// Music, SoundCloud, MyInstants or a creator's page offers without
// downloading, and `media_download` saves one source into the open project's
// library. Both run in the app with its managed downloader, so no shell, no
// sandbox network and nothing installed on the machine is involved. Nothing
// these tools return has checked rights, which is what keeps them apart from
// web_media_*, whose results carry verified open licenses.

import { z } from "zod";
import { defineTool } from "../tool";
import { Bytes } from "../schemas";

/** Search results to return, at most. */
export const MEDIA_SEARCH_LIMIT = 20;
/** Leading results whose thumbnails are inlined, at most: what an MCP result inlines. */
export const MEDIA_SEARCH_PREVIEWS = 4;
/** The caps a video download's picture may have on its shorter side. */
export const MEDIA_MAX_HEIGHTS = [360, 480, 720, 1080] as const;

export const MediaPlatform = z.enum(["youtube", "youtube_music", "soundcloud", "vimeo", "tiktok", "instagram", "x", "myinstants"]);
export const MediaKind = z.enum(["audio", "video"]);

export const MediaProfile = z.object({
  handle: z.string().nullable().describe("the account's handle, e.g. `@name`, when the site gives one"),
  name: z.string().nullable(),
  bio: z.string().nullable(),
  url: z.string().nullable().describe("the profile page"),
  followers: z.number().nonnegative().nullable(),
  following: z.number().nonnegative().nullable(),
  posts: z.number().nonnegative().nullable().describe("uploads the account has in all, when the site says"),
  verified: z.boolean().nullable(),
});

export const MediaSearchResult = z.object({
  index: z.int().positive().describe("1-based position; inline previews arrive in this order"),
  id: z.string().describe("the upload's id on its site; media_download names the file after it"),
  platform: MediaPlatform,
  title: z.string(),
  channel: z.string().nullable().describe("the uploader or artist"),
  channelUrl: z.string().nullable(),
  url: z.string().describe("the page to pass to media_download"),
  durationSeconds: z.number().nonnegative().nullable().describe("null when the site doesn't say"),
  publishedAt: z.string().nullable().describe("ISO date or date-time of the upload"),
  publishedAtApproximate: z.boolean().describe("true when the date is the site's rough age (\"3 weeks ago\"), as YouTube listings give it"),
  views: z.number().nonnegative().nullable(),
  likes: z.number().nonnegative().nullable(),
  comments: z.number().nonnegative().nullable(),
  live: z.enum(["none", "live", "upcoming", "was_live"]).describe("live and upcoming streams can't be downloaded until they end"),
  thumbnailUrl: z.string().optional(),
  previewPath: z.string().optional().describe("local copy of the thumbnail that was inlined"),
});

const searchOutput = {
  platform: MediaPlatform,
  profile: MediaProfile.nullable().describe("with `creator`: what the site says about the account; null for a query, or when the site gave nothing"),
  results: z.array(MediaSearchResult),
  warnings: z.array(z.string()).describe("best-effort platforms, empty results and other notes; the results still stand"),
};

export const mediaSearch = defineTool({
  name: "media_search",
  title: "Search video and audio platforms",
  description:
    "Find video and audio on platforms (YouTube, YouTube Music, SoundCloud, MyInstants, and creators' pages on Vimeo, TikTok and Instagram) without downloading anything; their rights are not verified, so for openly licensed stock and the images a web page shares use web_media_search instead. Give exactly one of `query`, words to search for (YouTube, YouTube Music, SoundCloud, MyInstants), or `creator`, a handle or profile link whose latest uploads are listed newest first (YouTube, SoundCloud, Vimeo, TikTok, Instagram; TikTok and Instagram are best effort, and Vimeo's videos mostly won't download, as Vimeo wants a sign-in). YouTube Music suits a song's official audio or instrumental; MyInstants suits short meme sounds. Each result has the `url` to pass to media_download, with title, channel, duration, upload date (approximate on YouTube) and view counts where the site gives them; a creator listing also returns what the site says about the profile. The first `preview` results (4 by default) carry their thumbnails inline. A result is a candidate, not proof it downloads: choose by title, channel and duration, not by rank. There is no keyword search on TikTok, Instagram, X or Vimeo: ask the user for links, or find them with your own web search, then pass each link to media_download. Runs in the app with its managed downloader, set up on first use; needs no open project and changes nothing.",
  input: z.object({
    platform: MediaPlatform.default("youtube").describe("where to look (default: youtube)"),
    query: z.string().trim().min(1).max(200).optional().describe("words to search for, e.g. an artist and a title; give this or `creator`"),
    creator: z.string().trim().min(1).max(200).optional().describe("list this account's latest uploads instead: a handle (`@name`), a YouTube channel id (`UC…`) or a profile link; give this or `query`"),
    limit: z.int().min(1).max(MEDIA_SEARCH_LIMIT).default(5).describe(`results to return, 1-${MEDIA_SEARCH_LIMIT} (default: 5)`),
    sort: z.enum(["relevance", "date"]).default("relevance").describe("YouTube query only: relevance (default), or date to put the newest of the most relevant results first"),
    tab: z.enum(["videos", "shorts", "streams"]).default("videos").describe("YouTube creator only: which of the channel's lists (default: videos)"),
    preview: z.int().min(0).max(MEDIA_SEARCH_PREVIEWS).default(MEDIA_SEARCH_PREVIEWS).describe(`leading results whose thumbnails are inlined as images, 0-${MEDIA_SEARCH_PREVIEWS} (default: ${MEDIA_SEARCH_PREVIEWS})`),
  }),
  output: z.object(searchOutput),
  /** What the handler returns: the thumbnails as bytes, which the server writes to the temp dir and inlines. */
  result: z.object({
    ...searchOutput,
    previews: z.array(z.object({ index: z.int().positive(), bytes: Bytes, mimeType: z.string() })),
  }),
  environment: "main",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
});

export const mediaDownload = defineTool({
  name: "media_download",
  title: "Download platform video or audio",
  description:
    "Download the sound or the video behind a platform link (YouTube, YouTube Music, SoundCloud, TikTok, Instagram, X, MyInstants and most other video or audio sites; Vimeo is best effort, as it wants a sign-in for most videos) into the open project's library, with its rights not verified and its source credited in `CREDITS.md`; openly licensed stock and the images a web page shares go through web_media_download instead. Use the returned `src` in JSX. `kind` is `audio` by default: the site's own sound saved without re-encoding (AAC `.m4a` where the site has it, else its MP3 or Opus file); pass `kind: \"video\"` for picture and sound: the largest picture whose shorter side is within `maxHeight` (default 1080, so a vertical 1080x1920 too), H.264 first at the same size. Files land in `assets/<folder>/` (default `music` for audio, `footage` for video, `sfx` for MyInstants) named after the source's id, e.g. `music/<id>.m4a`, so asking for the same source again reuses the file; the whole source is kept, so trim with sourceIn/sourceOut. For a post holding several videos, pass `item`. The user's own Instagram posts download from instagram_posts' `mediaUrl`, or from their permalink once instagram_posts has synced them (a carousel's permalink with `item`). Without an open project, pass an absolute `folder`. The file is checked to play before the call returns. Caps: audio 6 h and 1 GB, video 3 h and 4 GB. Updating the downloader and one retry happen inside the call, so an error is final: follow its message instead of retrying the same link, and never swap in a different song or video without telling the user.",
  input: z.object({
    url: z.string().trim().min(1).max(4096).regex(/^https?:\/\//i, "use an http or https URL").describe("the page or media link, e.g. a media_search result's `url`"),
    kind: MediaKind.default("audio").describe("audio (default) keeps only the sound; video keeps picture and sound"),
    folder: z.string().trim().min(1).max(1024).optional().describe("library folder under `assets/` to save into, e.g. `music`, `sfx` or `b-roll/city` (needs a project), or an absolute folder path (default: `music` for audio, `footage` for video)"),
    maxHeight: z.literal(MEDIA_MAX_HEIGHTS).default(1080).describe("video only: the cap on the picture's shorter side, 360, 480, 720 or 1080 (default: 1080), so 1080 takes 1920x1080 and a vertical 1080x1920 alike; a source with nothing that small gives its smallest picture, with a warning"),
    item: z.int().min(1).max(100).optional().describe("which video of a post that holds several (an Instagram carousel, an X post), 1-based"),
  }),
  output: z.object({
    src: z.string().nullable().describe("library path to use as `src` in JSX, e.g. `music/XajaJYraODs.m4a`; null when saved to an absolute folder outside the library"),
    libraryPath: z.string().nullable().describe("the same as `src`"),
    assetId: z.string().nullable(),
    path: z.string().describe("absolute path of the file"),
    id: z.string().describe("the source's id on its site; the file is named after it"),
    site: z.string().describe("where it came from: `youtube`, `soundcloud`, `tiktok`, `instagram`, `x`, `vimeo`, `myinstants`, or the downloader's name for another site"),
    kind: MediaKind,
    title: z.string(),
    channel: z.string().optional().describe("the uploader or artist"),
    channelUrl: z.string().optional(),
    uploadDate: z.string().optional().describe("YYYY-MM-DD"),
    durationSeconds: z.number().nonnegative(),
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
    videoCodec: z.string().optional(),
    audioCodec: z.string().optional(),
    hasAudio: z.boolean().describe("false for a silent video"),
    mimeType: z.string(),
    bytes: z.int().nonnegative(),
    sourceUrl: z.string().describe("the page the media came from"),
    reused: z.boolean().describe("true when the file was already there and nothing new was saved"),
    reencoded: z.boolean().describe("true when the sound or picture had to be converted rather than saved as the site served it"),
    rights: z.literal("unverified").describe("Blackout doesn't know who may use this; ask the user before publishing"),
    downloader: z.string().describe("what fetched it, e.g. `yt-dlp 2026.10.26`"),
    creditsFile: z.string().nullable().describe("absolute path of the project's CREDITS.md; null outside a project"),
    warnings: z.array(z.string()),
  }),
  environment: "renderer",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
});
