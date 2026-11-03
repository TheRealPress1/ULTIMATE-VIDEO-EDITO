/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Openly licensed media from the web: search Openverse and Wikimedia Commons
// from the main process, and download a chosen result (or a link the user
// gave) into the open project's `assets/web/` (or `music/`, `sfx/`), with its
// license recorded in the project's `CREDITS.md`. The network and the disk
// are the app's, not the agent's sandbox, so both work without a shell.
// Platform uploads (YouTube, TikTok, SoundCloud…) are media_*'s.

import { z } from "zod";
import { defineTool } from "../tool";
import { Bytes } from "../schemas";

/** Search results to return, at most. */
export const WEB_MEDIA_LIMIT = 30;
/** Leading results whose thumbnails are inlined, at most: what an MCP result inlines. */
export const WEB_MEDIA_PREVIEWS = 4;

export const WebMediaKind = z.enum(["image", "video", "audio"]);
export const WebMediaProvider = z.enum(["openverse", "wikimedia"]);

export const WebMediaLicense = z.object({
  code: z.string().describe("short license code: `cc0`, `pdm`, `public-domain`, `by`, `by-sa`, `by-nd`, `by-nc`, `by-nc-sa`, `by-nc-nd`, `sampling+`, `nc-sampling+`, `gfdl`, `fal`, `ogl`, `attribution`, or `unknown`"),
  name: z.string().describe("human-readable name, e.g. `CC BY-SA 4.0`"),
  version: z.string().optional(),
  url: z.string().optional().describe("the license's legal text"),
  attributionRequired: z.boolean(),
  shareAlike: z.boolean().describe("adaptations must carry the same license"),
  commercialUse: z.boolean(),
  modificationsAllowed: z.boolean().describe("cropping, overlays and edits are allowed; false for no-derivatives (ND) licenses"),
  verified: z.boolean().describe("true when the license comes from the search provider's metadata or, for a file Cutroom's audio catalog ships, from that catalog; false for any other link, whose rights the user must confirm"),
});

export const WebMediaResult = z.object({
  index: z.int().positive().describe("1-based position; inline previews arrive in this order"),
  id: z.string().describe("the provider's id, prefixed with the provider"),
  kind: WebMediaKind,
  title: z.string(),
  provider: WebMediaProvider,
  source: z.string().optional().describe("where the provider found the work, e.g. `flickr` (Openverse only)"),
  url: z.string().describe("the media file; pass it to web_media_download"),
  thumbnailUrl: z.string().optional(),
  previewPath: z.string().optional().describe("local copy of the thumbnail that was inlined"),
  pageUrl: z.string().describe("the work's page, for attribution"),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  mimeType: z.string().optional(),
  creator: z.string().optional(),
  license: WebMediaLicense,
  attribution: z.string().describe("ready-to-paste credit line: title, creator, source and license"),
});

const searchOutput = { results: z.array(WebMediaResult), warnings: z.array(z.string()).describe("providers that failed or were rate limited; the rest still answered") };

export const webMediaSearch = defineTool({
  name: "web_media_search",
  title: "Search web media",
  description:
    "Openly licensed stock with verified licenses: search images, video and audio on Openverse and Wikimedia Commons, for B-roll, script illustrations, music and sound; for uploads on YouTube, SoundCloud and other platforms, whose rights aren't checked, use media_search instead. Returns results interleaved across providers with each work's file URL, page, creator, size, normalized license terms and a ready-to-paste attribution line; the first `preview` results (4 by default) carry their thumbnails inline so you can look before choosing. `license: \"editable\"` (default) leaves out no-derivatives works, `\"commercial\"` keeps only works that allow commercial use and modification, `\"any\"` returns every openly licensed work. Write concrete queries (subject, place, era, shot type). Openverse has no video. Download a chosen result with web_media_download, passing its `url`; that keeps the provenance. Does not need an open project and changes nothing.",
  input: z.object({
    query: z.string().trim().min(1).max(200).describe("what to look for: subject, place, era, shot type"),
    kind: WebMediaKind.default("image").describe("image, video or audio (default: image)"),
    orientation: z.enum(["any", "landscape", "portrait", "square"]).default("any").describe("images only: landscape for 16:9, portrait for 9:16 (default: any)"),
    license: z.enum(["editable", "commercial", "any"]).default("editable").describe("editable: excludes no-derivatives licenses (default); commercial: commercial use and modification allowed; any: every openly licensed work"),
    sources: z.array(WebMediaProvider).min(1).max(2).default(["openverse", "wikimedia"]).describe("providers to search (default: both)"),
    limit: z.int().min(1).max(WEB_MEDIA_LIMIT).default(12).describe(`results to return, 1-${WEB_MEDIA_LIMIT} (default: 12)`),
    preview: z.int().min(0).max(WEB_MEDIA_PREVIEWS).default(WEB_MEDIA_PREVIEWS).describe(`leading results whose thumbnails are inlined as images, 0-${WEB_MEDIA_PREVIEWS} (default: ${WEB_MEDIA_PREVIEWS})`),
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

export const webMediaDownload = defineTool({
  name: "web_media_download",
  title: "Download web media",
  description:
    "Openly licensed stock and the images a web page shares: download an image, video or audio file into the open project's `assets/web/` folder (or `music/` or `sfx/` with `folder`) and import it into the asset library; use the returned `src` in JSX. Pages on YouTube, TikTok, Instagram, X, Vimeo, SoundCloud or MyInstants are media_download's, and this call refuses them, saying so; a file on those sites, such as a MyInstants MP3 link, downloads here. Pass a web_media_search result's `url` (its license and attribution come along) or a link the user gave: a direct file, or a web page, which resolves to the image it declares for sharing (or its video with `prefer: \"video\"`). The file is checked to be a real image (JPEG, PNG, GIF, WebP, AVIF, BMP, SVG), video (MP4, MOV, WebM, MKV, MPEG-TS) or audio file (MP3, WAV, FLAC, AAC, M4A, Ogg), up to 60 MB for images, 500 MB for audio and 2 GB for video. Downloading the same bytes again reuses the existing file, even one in another folder, so `src` can differ from the folder asked for. Every download is credited in `CREDITS.md` at the project root; a link that was not a search result has an unverified license, so leave its rights to the user. Needs an open project.",
  input: z.object({
    url: z.string().trim().min(1).max(4096).regex(/^https?:\/\//i, "use an http or https URL").describe("a web_media_search result's `url`, or a link to a media file or web page"),
    name: z.string().trim().min(1).max(80).optional().describe("short descriptive base name for the file, e.g. `apollo launch` (default: the result's title or the URL's file name)"),
    prefer: z.enum(["image", "video"]).default("image").describe("which of a web page's shared media to take when it declares both (default: image)"),
    folder: z.enum(["web", "music", "sfx"]).default("web").describe("library folder under `assets/` to save into: web (default), music for a music bed, sfx for a sound effect, as audio_catalog entries say; music and sfx refuse an image"),
  }),
  output: z.object({
    src: z.string().describe("library path to use as `src` in JSX, e.g. `web/apollo-launch-3f2a9c1d.jpg` or `sfx/deep-whoosh-1a2b3c4d.mp3`"),
    assetId: z.string(),
    path: z.string().describe("absolute path of the file"),
    kind: WebMediaKind,
    mimeType: z.string(),
    bytes: z.int().nonnegative(),
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
    durationSeconds: z.number().nonnegative().optional(),
    title: z.string().optional(),
    creator: z.string().optional(),
    provider: WebMediaProvider.optional(),
    pageUrl: z.string().optional(),
    fileUrl: z.string().describe("the URL the bytes came from, after redirects and page resolution"),
    license: WebMediaLicense,
    attribution: z.string().optional(),
    creditsFile: z.string().describe("absolute path of the project's CREDITS.md"),
    deduplicated: z.boolean().describe("true when the same bytes were already in the project and that file was reused"),
  }),
  environment: "renderer",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
});
