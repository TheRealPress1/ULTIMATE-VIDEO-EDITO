/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `media_download` in the main process: the sound or the video behind a
// platform link, saved whole into the open project's `assets/<folder>/` as
// `<id>.<ext>` (or into an absolute folder when no project is open). It is a
// renderer tool, as `web_media_download` is: main downloads, the renderer
// imports the file into the live library, then main records it in the
// project's ledger and CREDITS.md, or takes it back out.
//
// Three ways in, one way out:
// - most links go through the managed downloader (yt-dlp): its metadata is
//   read first (playlists, live streams and the caps are refused before a
//   byte of media moves), then the chosen formats are downloaded into a work
//   folder in the project's `.cutroom/` (the same volume, so landing the
//   file is one rename, and out of the agents' reach);
// - the user's own Instagram files (the Graph API's `media_url`, from
//   instagram_posts) are fetched directly, which needs no sign-in;
// - MyInstants sound pages are read by the app (see
//   ./media-download-myinstants).
// Every file is probed before it is kept: it must play, have the picture or
// sound asked for, and stay within the caps. The same upload asked for again
// is found by its id before anything is fetched.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DapiError, MEDIA_MAX_HEIGHTS } from "@diffusionstudio/dapi";
import { TEMP_PREFIX } from "./atomic";
import { libraryFolderRefusal } from "./dapi/output-policy";
import { withProjectLock } from "./project-write-transactions";
import { CREDITS_FILE, LEDGER_DIR, itemPath, readLedger, writeCredits, writeLedger } from "./web-media-ledger";
import { UNKNOWN_LICENSE } from "./web-media-providers";
import { pinnedFetch } from "./web-media";
import { checkWebUrl, hostOf, resolvePublic, systemResolve } from "./web-media-url";
import { sniff } from "./web-media-sniff";
import { fileStem, isInstagramCdn, looksLikeImage, looksLikeMediaFile, mediaIdOf, platformOf, siteName, siteOfExtractor } from "./platform-url";
import { MYINSTANTS_DURATION_MAX, fetchMyInstantsSound, myInstantsPage } from "./media-download-myinstants";
import { runRecovering } from "./media-runner";
import { parseListing } from "./media-search";

import type { MediaKind } from "@diffusionstudio/dapi";
import type { ClassifyDownloaderError, MediaDownloader } from "./media-runner";
import type { PageFetch } from "./media-download-myinstants";
import type { WebFetch } from "./web-media";
import type { Resolve } from "./web-media-url";
import type { WebMediaLedger } from "./web-media-types";
import type {
  MediaCommitRequest, MediaCommitResult, MediaDownloaded, MediaDownloadRequest, MediaLedgerItem, MediaMaxHeight, PlatformProvenance,
} from "./media-download-types";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The longest and largest download per kind. */
export type MediaCaps = Record<MediaKind, { seconds: number; bytes: number }>;
export const MEDIA_CAPS: MediaCaps = { audio: { seconds: 6 * 3600, bytes: GB }, video: { seconds: 3 * 3600, bytes: 4 * GB } };

export type MediaDownloadTimeouts = {
  /** Reading a link's metadata, once. */
  metadata: number;
  /** Downloading the media, once. */
  download: number;
  /** Without a progress line from the downloader, mid-download. */
  idle: number;
  /** Probing the file. */
  verify: number;
  /** A download the renderer neither committed nor discarded, before main records it anyway. */
  pending: number;
  /** A direct file (an Instagram `media_url`) in all. */
  direct: number;
};

const TIMEOUTS: MediaDownloadTimeouts = { metadata: 90_000, download: 60 * 60_000, idle: 120_000, verify: 10 * 60_000, pending: 15 * 60_000, direct: 20 * 60_000 };
/** Downloads running at once; the rest wait their turn. */
const DOWNLOADS = 2;
/** A work folder left behind (by a crash) is cleared after this long. */
const STALE_WORK_MS = 60 * 60_000;
const DOWNLOADS_DIR = "downloads";
/** What every work folder's name starts with: the app's temp prefix, which the watcher ignores and a duplicate of the project leaves out. */
const WORK_PREFIX = `${TEMP_PREFIX}media-`;
const MAX_REDIRECTS = 5;
/** The most uploads a list is counted to: `item` goes up to this. */
export const LIST_MAX = 100;
/** Where a saved video without a recorded cap sorts among the ones with: after them. */
const UNCAPPED = 100_000;

/** A library folder under `assets/`: up to four plain names, nothing hidden. */
export const LIBRARY_FOLDER = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}(\/[A-Za-z0-9][A-Za-z0-9 _-]{0,40}){0,3}$/;

/** Codecs a video's picture may have: what the editor decodes inside MP4. */
const VIDEO_CODECS = new Set(["h264", "hevc", "av1", "vp9"]);
/** Codecs a sound may have, kept as the site served them. */
const AUDIO_CODECS = /^(aac|mp3|opus|vorbis|flac|alac|pcm_[a-z0-9]+)$/;
/** Where an untracked file named after the id is looked for. */
const EXTENSIONS: Record<MediaKind, string[]> = { audio: ["m4a", "mp3", "opus", "ogg", "aac", "flac", "wav", "webm"], video: ["mp4"] };
const MIME_TYPES: Record<string, string> = {
  m4a: "audio/mp4", mp3: "audio/mpeg", opus: "audio/ogg", ogg: "audio/ogg", oga: "audio/ogg", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
};

/**
 * The best sound: AAC where the site has it (kept as is; sites call it `mp4a`
 * or plain `aac`), otherwise its own codec; from a combined file when there
 * is no audio-only one.
 */
export const AUDIO_FORMAT = "ba[acodec~='^(mp4a|aac)']/ba/b";

/** A picture in a codec the editor plays (VIDEO_CODECS), by the names sites give them. */
const PLAYABLE_PICTURE = "[vcodec~='^(avc|h26[45]|hvc|hev|vp0?9|av0?1)']";

/** Which formats a video may be: a playable picture with the best sound for it, else anything with sound. `videoSort` ranks them. */
export const VIDEO_FORMAT = `bv*${PLAYABLE_PICTURE}+ba/b${PLAYABLE_PICTURE}/bv*+ba/b`;

/**
 * How a video's formats are ranked. The cap is on the picture's shorter
 * side, so 1080 takes a landscape 1920x1080 and a vertical 1080x1920 alike:
 * the largest picture within it, or the smallest there is when the site
 * offers nothing that small. At the same size, H.264 comes first (hardware
 * decode, smooth scrubbing), then HEVC; AAC sound comes first.
 */
export function videoSort(maxHeight: number): string {
  return `res:${maxHeight},+vcodec:avc,+acodec:m4a`;
}

/** The downloader's format arguments for a kind, the same for reading the metadata and for the download. */
export function formatArgs(kind: MediaKind, maxHeight: number): string[] {
  return kind === "audio" ? ["-f", AUDIO_FORMAT] : ["-f", VIDEO_FORMAT, "-S", videoSort(maxHeight)];
}

/** A picture's shorter side, which `maxHeight` caps. */
function shortSide(video: MediaStreams["video"]): number | undefined {
  return video?.width && video.height ? Math.min(video.width, video.height) : video?.height;
}

/**
 * The cap a video file answers, as its record keeps it: the one asked for,
 * or, for a picture larger than that (nothing smaller was offered, or the
 * file was already there), every cap up to its shorter side, since a
 * download under any of them would be no larger.
 */
function answeredCap(asked: MediaMaxHeight | undefined, side: number | undefined): MediaMaxHeight | undefined {
  if (asked === undefined || side === undefined || side <= asked) return asked;
  return MEDIA_MAX_HEIGHTS.filter((cap) => cap <= side).at(-1) ?? asked;
}

const PROGRESS_TEMPLATE = "download:[cutroom] %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s";

export const WEB_MEDIA_REDIRECT =
  "This is an image or a web_media_search result, whose license web_media_download keeps. Download it with web_media_download instead.";
const NO_DOWNLOADER = "This build of Blackout has no downloader, so platform links can't be downloaded. Ask the user for the file, or use web_media_download for openly licensed media.";
const PROJECT_GONE = "The project moved or closed during the download. Open it again and download again.";
const PROJECT_SAVED = "The project was saved or moved during the download. Download again in the project where it is now.";
const MYINSTANTS_LINK = "That isn't a MyInstants sound page (https://www.myinstants.com/<lang>/instant/<name>/). Search MyInstants with media_search for a sound's link.";
const MYINSTANTS_FILE =
  "That is a MyInstants sound file, not its page. Download the file with web_media_download (folder \"sfx\"), or pass the sound's page (https://www.myinstants.com/<lang>/instant/<name>/) here.";
const LIBRARY_FOLDER_RULE = "`folder` is a library folder under `assets/`, such as `music`, `sfx` or `b-roll/city`: up to four names of letters, digits, spaces, `_` and `-`.";

// ---------------------------------------------------------------------------
// Probing

/** What a media file holds, as the probe read it. */
export type MediaStreams = {
  durationSeconds: number;
  video?: { codec: string; width?: number; height?: number };
  audio?: { codec: string };
};

export type Probe = (path: string, signal: AbortSignal) => Promise<MediaStreams>;
/** Copies the first sound of `input` into `output` (an `.m4a`), without re-encoding. */
export type ExtractAudio = (input: string, output: string, signal: AbortSignal) => Promise<void>;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const positive = (value: unknown): number | undefined => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
};

/** ffprobe's `-show_format -show_streams -of json` as streams; the first picture (not cover art) and the first sound. */
export function parseFfprobe(output: string): MediaStreams {
  const data = object(JSON.parse(output)) ?? {};
  const streams = Array.isArray(data.streams) ? data.streams.map(object).filter((stream): stream is Json => stream !== null) : [];
  const picture = streams.find((stream) => stream.codec_type === "video" && object(stream.disposition)?.attached_pic !== 1);
  const sound = streams.find((stream) => stream.codec_type === "audio");
  const duration = positive(object(data.format)?.duration) ?? positive(picture?.duration) ?? positive(sound?.duration) ?? 0;
  return {
    durationSeconds: duration,
    ...(picture ? { video: { codec: String(picture.codec_name ?? "unknown"), ...(positive(picture.width) ? { width: Math.round(positive(picture.width)!) } : {}), ...(positive(picture.height) ? { height: Math.round(positive(picture.height)!) } : {}) } } : {}),
    ...(sound ? { audio: { codec: String(sound.codec_name ?? "unknown") } } : {}),
  };
}

/** What `ffmpeg -i` prints about a file, as streams: for a build without ffprobe. */
export function parseFfmpegInfo(stderr: string): MediaStreams {
  const time = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  const duration = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0;
  const lines = stderr.split("\n");
  const pictureLine = lines.find((line) => /Stream #\d+:\d+[^:]*: Video: /.test(line) && !/attached pic/.test(line));
  const soundLine = lines.find((line) => /Stream #\d+:\d+[^:]*: Audio: /.test(line));
  const picture = pictureLine && /: Video: ([a-z0-9_]+)/.exec(pictureLine);
  const size = pictureLine && /, (\d{2,5})x(\d{2,5})/.exec(pictureLine);
  const sound = soundLine && /: Audio: ([a-z0-9_]+)/.exec(soundLine);
  return {
    durationSeconds: duration,
    ...(picture ? { video: { codec: picture[1]!, ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}) } } : {}),
    ...(sound ? { audio: { codec: sound[1]! } } : {}),
  };
}

function exec(binary: string, args: string[], signal: AbortSignal, timeout: number): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((settle, reject) => {
    execFile(binary, args, { signal, timeout, maxBuffer: 8 * MB, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (signal.aborted || (error as NodeJS.ErrnoException).code === "ENOENT")) return reject(error);
      settle({ stdout: String(stdout), stderr: String(stderr), failed: !!error });
    });
  });
}

/** The probe and the audio copy the app runs, with ffprobe when the build has it and its ffmpeg otherwise. */
export function mediaTools(tools: { ffprobe?: string | null; ffmpeg?: string | null; timeoutMs?: number }): { probe: Probe; extractAudio?: ExtractAudio } {
  const timeout = tools.timeoutMs ?? TIMEOUTS.verify;
  const probe: Probe = async (path, signal) => {
    if (tools.ffprobe) {
      const { stdout, stderr, failed } = await exec(tools.ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], signal, timeout);
      if (failed) throw new Error(stderr.trim().split("\n").pop() || "ffprobe could not read the file");
      return parseFfprobe(stdout);
    }
    if (!tools.ffmpeg) throw new Error("no media probe is available");
    const { stderr } = await exec(tools.ffmpeg, ["-hide_banner", "-nostdin", "-i", path], signal, timeout);
    const streams = parseFfmpegInfo(stderr);
    if (!streams.video && !streams.audio) throw new Error(stderr.trim().split("\n").pop() || "ffmpeg could not read the file");
    return streams;
  };
  const ffmpeg = tools.ffmpeg;
  const extractAudio: ExtractAudio | undefined = ffmpeg
    ? async (input, output, signal) => {
      const { stderr, failed } = await exec(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", input, "-map", "0:a:0", "-vn", "-c:a", "copy", "-movflags", "+faststart", "-y", output], signal, timeout);
      if (failed) throw new Error(stderr.trim().split("\n").pop() || "ffmpeg could not copy the sound");
    }
    : undefined;
  return { probe, ...(extractAudio ? { extractAudio } : {}) };
}

// ---------------------------------------------------------------------------
// The service

/** One of the user's own Instagram posts as the local analytics cache knows it. */
export type InstagramMedia = { id: string; permalink: string | null; mediaUrl: string | null; mediaType?: string; caption?: string | null; username?: string | null };

/** The Graph API's type for a post holding several files, whose own `media_url` is only its first. */
const CAROUSEL = "CAROUSEL_ALBUM";

/** A link's address without its query, hash or trailing slash: how a permalink or a CDN file is compared. */
function bare(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** The post among the user's own Instagram posts a link names, by its permalink or its file's address. */
export function findInstagramMedia(
  snapshot: { account: { username: string } | null; posts: Array<{ id: string; caption: string; permalink: string | null; mediaUrl?: string | null; mediaType?: string }> },
  url: string,
): InstagramMedia | null {
  const wanted = bare(url);
  if (!wanted) return null;
  const post = snapshot.posts.find((candidate) => [candidate.permalink, candidate.mediaUrl].some((link) => link && bare(link) === wanted));
  return post
    ? { id: post.id, permalink: post.permalink, mediaUrl: post.mediaUrl ?? null, ...(post.mediaType ? { mediaType: post.mediaType } : {}), caption: post.caption, username: snapshot.account?.username ?? null }
    : null;
}

export type MediaDownloadOptions = {
  /** The managed downloader; null when this build has none. */
  downloader: () => MediaDownloader | null;
  classify?: ClassifyDownloaderError;
  probe: Probe;
  extractAudio?: ExtractAudio;
  /** What direct files are fetched with (Node's, each connection's address checked); redirects are followed by the service. */
  fetch?: WebFetch;
  /** What MyInstants pages are fetched with (Electron's `net.fetch` in the app). */
  pageFetch?: PageFetch;
  resolve?: Resolve;
  /** Claims a write the project watcher would otherwise report (projects.ts). */
  noteContent?: (path: string, text: string | null) => void;
  /** Marks a write into a project as running, so a save waits for it (projects.ts). */
  startWrite?: (dir: string) => () => void;
  /** Whether a URL is a web_media_search result, which web_media_download keeps the license of. */
  isWebResult?: (url: string) => boolean;
  /** The user's own Instagram post a link names (by its permalink or its `media_url`), from the analytics cache. */
  instagramMedia?: (url: string) => Promise<InstagramMedia | null>;
  now?: () => Date;
  timeouts?: Partial<MediaDownloadTimeouts>;
  caps?: Partial<MediaCaps>;
  networkRetryMs?: number;
  version?: string;
};

type Destination =
  | { project: true; dir: string; root: string; folder: string; real: string }
  | { project: false; folder: string; real: string };

/** A file ready to be checked and landed: in the work folder, or (`inPlace`) already where it belongs. */
type Fetched = {
  file: string;
  inPlace?: boolean;
  site: string;
  mediaId: string;
  title: string;
  channel?: string;
  channelUrl?: string;
  uploadDate?: string;
  pageUrl: string;
  downloader: string;
  formats?: string[];
  reencoded: boolean;
  /** The longest the file may run, when tighter than the kind's cap. */
  maxSeconds?: number;
  /** The cap on the picture's shorter side the download asked for (a video through the downloader). */
  maxHeight?: MediaMaxHeight;
};

type Verified = { streams: MediaStreams; ext: string; mimeType: string; bytes: number; sha256: string };

type Pending = { dir: string; item: MediaLedgerItem; created: boolean; timer: ReturnType<typeof setTimeout> };

/** A download still running: what stops it, its work folder once there is one, and the write a save waits on until that is gone. */
type Job = { id: string; dir: string | null; controller: AbortController; work: string | null; write: (() => void) | null };

function canceled(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof DapiError ? reason : new DapiError("canceled", "The download was canceled.");
}

function text(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : m ? `${m} min ${String(s).padStart(2, "0")} s` : `${s} s`;
}

const size = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`);

function tooLong(kind: MediaKind, seconds: number, cap: number): DapiError {
  return new DapiError("invalid-input", `This ${kind} runs ${clock(seconds)}, longer than the ${clock(cap)} media_download takes for ${kind}. ${kind === "video" ? "Pass `kind: \"audio\"` for its sound only, or choose a shorter source." : "Choose a shorter source."}`);
}

function tooLarge(kind: MediaKind, bytes: number | null, cap: number): DapiError {
  const advice = kind === "video" ? "Pass a lower `maxHeight`, `kind: \"audio\"` for its sound only, or choose a shorter source." : "Choose a shorter source.";
  return new DapiError("invalid-input", bytes === null
    ? `The downloader skipped this ${kind}: it is larger than the ${size(cap)} media_download takes for ${kind}. ${advice}`
    : `This ${kind} would be about ${size(bytes)}, more than the ${size(cap)} media_download takes for ${kind}. ${advice}`);
}

/** A `YYYYMMDD` date as `YYYY-MM-DD`. */
function day(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : undefined;
}

/** The credit line a platform download carries into CREDITS.md. */
export function platformAttribution(work: { title: string; channel?: string; site: string; pageUrl: string }): string {
  return `"${work.title}"${work.channel ? ` by ${work.channel}` : ""} on ${siteName(work.site)} (${work.pageUrl})`;
}

/** The size the chosen formats are expected to have, when the metadata says. */
export function estimatedBytes(info: Json): number | null {
  const parts = Array.isArray(info.requested_formats) ? info.requested_formats.map(object).filter((part): part is Json => part !== null) : [info];
  let total = 0;
  let known = false;
  for (const part of parts) {
    const bytes = count(part.filesize) ?? count(part.filesize_approx);
    if (bytes !== null) {
      total += bytes;
      known = true;
    }
  }
  return known ? total : null;
}

/** The one upload a link's metadata is about: a list's only entry, or the `item` asked for. */
export function selectEntry(info: Json, item: number | undefined): { entry: Json; complete: boolean } {
  if (info._type !== "playlist" && !Array.isArray(info.entries)) return { entry: info, complete: true };
  const entries = (Array.isArray(info.entries) ? info.entries : []).map(object).filter((entry): entry is Json => entry !== null);
  if (!entries.length) {
    throw new DapiError("not-found", item ? `This link has no item ${item}. Pass a smaller \`item\`, or leave it out.` : "This link lists nothing that can be downloaded. Pass the upload's own link.");
  }
  if (entries.length > LIST_MAX && !item) {
    throw new DapiError("invalid-input", `This link holds more than ${LIST_MAX} uploads. Pass the upload's own link, or \`item\` (1-${LIST_MAX}) for one of the first ${LIST_MAX}.`);
  }
  if (entries.length > 1 && !item) {
    throw new DapiError("invalid-input", `This link holds ${entries.length} uploads. Pass \`item\` (1-${entries.length}) to choose one, or pass the upload's own link.`);
  }
  const entry = { ...entries[0]! };
  // A post's entries leave out what the post says about itself.
  for (const key of ["channel", "uploader", "channel_url", "uploader_url", "upload_date", "timestamp", "title", "extractor_key", "webpage_url"]) {
    if (entry[key] === undefined && info[key] !== undefined) entry[key] = info[key];
  }
  const complete = entry._type !== "url" && entry._type !== "url_transparent" && (Array.isArray(entry.formats) || typeof entry.url === "string");
  return { entry, complete };
}

/** Refuses `path` unless it is a folder itself, not a link to one. */
async function realFolder(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`The project's ${label} folder must be a real folder.`);
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether the file at `path` is exactly these bytes: by its size, then by its hash. */
async function holds(path: string, bytes: number, sha256: string): Promise<boolean> {
  const there = await stat(path).catch(() => null);
  return !!there?.isFile() && there.size === bytes && (await sha256Of(path).catch(() => null)) === sha256;
}

function sha256Of(path: string): Promise<string> {
  return new Promise((settle, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => settle(hash.digest("hex")));
  });
}

async function head(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** The library folder a project file is in: `assets/music/x.m4a` → `music`; null for one outside `assets/`. */
function folderOf(source: string): string | null {
  const parts = source.split("/");
  return parts[0] === "assets" && parts.length > 2 ? parts.slice(1, -1).join("/") : parts[0] === "assets" ? "" : null;
}

export class MediaDownloadService {
  private readonly downloader: () => MediaDownloader | null;
  private readonly classify?: ClassifyDownloaderError;
  private readonly probe: Probe;
  private readonly extractAudio?: ExtractAudio;
  private readonly resolve: Resolve;
  private readonly fetch: WebFetch;
  private readonly pageFetch?: PageFetch;
  private readonly noteContent: (path: string, text: string | null) => void;
  private readonly startWrite: (dir: string) => () => void;
  private readonly isWebResult: (url: string) => boolean;
  private readonly instagramMedia: (url: string) => Promise<InstagramMedia | null>;
  private readonly now: () => Date;
  private readonly timeouts: MediaDownloadTimeouts;
  private readonly caps: MediaCaps;
  private readonly networkRetryMs?: number;
  private readonly userAgent: string;
  private readonly pending = new Map<string, Pending>();
  private readonly jobs = new Set<Job>();
  /** The download of each upload (and each link) running now: a second ask waits for it, then reuses its file. */
  private readonly flights = new Map<string, Promise<unknown>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: MediaDownloadOptions) {
    this.downloader = options.downloader;
    this.classify = options.classify;
    this.probe = options.probe;
    this.extractAudio = options.extractAudio;
    this.resolve = options.resolve ?? systemResolve;
    this.fetch = options.fetch ?? pinnedFetch(this.resolve);
    this.pageFetch = options.pageFetch;
    this.noteContent = options.noteContent ?? (() => {});
    this.startWrite = options.startWrite ?? (() => () => {});
    this.isWebResult = options.isWebResult ?? (() => false);
    this.instagramMedia = options.instagramMedia ?? (async () => null);
    this.now = options.now ?? (() => new Date());
    this.timeouts = { ...TIMEOUTS, ...options.timeouts };
    this.caps = { ...MEDIA_CAPS, ...options.caps };
    this.networkRetryMs = options.networkRetryMs;
    this.userAgent = `Blackout/${options.version ?? "dev"} (desktop video editor)`;
  }

  /**
   * Downloads `request.url` and holds the file for the renderer, which
   * imports it and then commits or discards it. A file outside a project
   * (an absolute `folder`) is final as it is returned.
   */
  async download(request: MediaDownloadRequest, signal: AbortSignal): Promise<MediaDownloaded> {
    const job: Job = { id: request.id, dir: request.dir, controller: new AbortController(), work: null, write: null };
    const known = myInstantsPage(request.url) ? { site: "myinstants", id: myInstantsPage(request.url)!.slug } : mediaIdOf(request.url);
    const kind = myInstantsPage(request.url) ? "audio" : request.kind;
    const key = JSON.stringify([request.dir ?? request.folder ?? "", known ? `${known.site}:${known.id}` : request.url, kind]);
    const before = this.flights.get(key);
    this.jobs.add(job);
    const mine = (async () => {
      if (before) await before.catch(() => {});
      return this.run(request, AbortSignal.any([signal, job.controller.signal]), job);
    })();
    this.flights.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.flights.get(key) === mine) this.flights.delete(key);
      this.jobs.delete(job);
      job.write?.();
    }
  }

  /**
   * Stops the downloads running into `dir`, whose folder is about to be
   * saved or moved. Each counts as a write into the project until it has
   * stopped and its work folder is gone, so whatever waits for writes takes
   * a clean folder. (A duplicate needs none of this: work folders carry the
   * temp prefix its copy leaves out, and landing takes the project's lock.)
   */
  cancelDownloads(dir: string): void {
    for (const job of this.jobs) {
      if (job.dir !== dir) continue;
      job.write ??= this.startWrite(dir);
      job.controller.abort(new DapiError("no-project", PROJECT_SAVED));
    }
  }

  /** Stops every download as the app quits, removing their work folders at once. */
  dispose(): void {
    for (const job of this.jobs) {
      job.controller.abort(new DapiError("canceled", "Blackout quit during the download."));
      if (job.work) rmSync(job.work, { recursive: true, force: true });
    }
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
  }

  /** A turn to download: at most `DOWNLOADS` at once. Resolves with what gives it back (once, however often it is called). */
  private async slot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw canceled(signal);
    if (this.running < DOWNLOADS) {
      this.running++;
    } else {
      await new Promise<void>((settle, reject) => {
        const go = () => { signal.removeEventListener("abort", leave); settle(); };
        const leave = () => { this.waiting.splice(this.waiting.indexOf(go), 1); reject(canceled(signal)); };
        this.waiting.push(go);
        signal.addEventListener("abort", leave, { once: true });
      });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) return next();
      this.running--;
    };
  }

  private async run(request: MediaDownloadRequest, signal: AbortSignal, job: Job): Promise<MediaDownloaded> {
    if (signal.aborted) throw canceled(signal);
    const requested = checkWebUrl(request.url);
    if (this.isWebResult(requested.href) || looksLikeImage(requested)) throw new DapiError("invalid-input", WEB_MEDIA_REDIRECT);
    const instant = myInstantsPage(requested);
    if (!instant && platformOf(requested) === "myinstants") throw new DapiError("invalid-input", looksLikeMediaFile(requested) ? MYINSTANTS_FILE : MYINSTANTS_LINK);
    const kind: MediaKind = instant ? "audio" : request.kind;
    const warnings = instant && request.kind === "video" ? ["MyInstants only has sounds, so this was saved as audio."] : [];
    const destination = await this.destination(request, instant ? "sfx" : kind === "audio" ? "music" : "footage");
    // A file server's signed link carries its access tokens in the query: never kept.
    const requestedUrl = isInstagramCdn(requested) ? `${requested.origin}${requested.pathname}` : requested.href;

    try {
      // The user's own Instagram post, from the local analytics cache: fetched directly unless the downloader must pick one file of several.
      const own = instant ? null : await this.ownInstagram(requested);
      const direct = isInstagramCdn(requested) || (!!own && this.directPost(own, request.item));
      if (direct && request.item && isInstagramCdn(requested)) warnings.push("`item` was ignored: a file link is one file. Pass the post's permalink to choose one of several.");

      // The same upload saved before, found by the link's id (or the post's, for the user's own) without the network.
      const ids = [
        ...(instant ? [{ site: "myinstants", id: instant.slug }] : []),
        ...(own && direct ? [{ site: "instagram", id: own.id }] : []),
        ...(!instant && mediaIdOf(requested) ? [mediaIdOf(requested)!] : []),
      ];
      for (const known of ids) {
        const hit = await this.recorded(destination, known.site, known.id, kind, request.maxHeight);
        if (hit) return await this.reuse(request, destination, hit, requestedUrl, kind, warnings, signal);
      }

      // Only something that will be fetched needs the host to resolve.
      await this.reachable(requested);
      const release = await this.slot(signal);
      try {
        const work = (job.work = await this.workDir(destination, request.id));
        const fetched = instant
          ? await this.fromMyInstants(requested, work, signal)
          : direct
            ? await this.fromInstagram(requested, own, kind, work, signal, warnings)
            : await this.fromDownloader(request, requested, kind, destination, work, signal, warnings);
        release();
        if ("recorded" in fetched) return await this.reuse(request, destination, fetched.recorded, requestedUrl, kind, warnings, signal);
        const verified = await this.verify(fetched, kind, signal, warnings);
        return await this.land(request, destination, fetched, verified, kind, requestedUrl, warnings, signal);
      } finally {
        release();
        if (job.work) await rm(job.work, { recursive: true, force: true }).catch(() => {});
        job.work = null;
      }
    } catch (error) {
      if (signal.aborted) throw canceled(signal);
      // A file operation that failed because the project left (moved outside the app, or deleted) is about the project, not the media.
      if (destination.project && !(error instanceof DapiError) && !(await stat(destination.dir).catch(() => null))?.isDirectory()) {
        throw new DapiError("no-project", PROJECT_GONE, { cause: error });
      }
      throw error;
    }
  }

  /** The link's host resolves to public addresses; a known platform's that doesn't resolve means the network is down, not that the link is wrong. */
  private async reachable(url: URL): Promise<void> {
    try {
      await resolvePublic(hostOf(url), this.resolve);
    } catch (error) {
      const site = platformOf(url) ?? (isInstagramCdn(url) ? "instagram" : null);
      if (!site || !(error instanceof DapiError) || error.code !== "not-found") throw error;
      const code = ((error as Error & { cause?: NodeJS.ErrnoException }).cause)?.code;
      throw new DapiError("invalid-input", `Couldn't reach ${siteName(site)}${code ? ` (${code})` : ""}. Check the internet connection, then try once more.`, { cause: error });
    }
  }

  /**
   * Whether one of the user's own posts, named by its permalink, is fetched
   * from its file link: not a carousel, whose file link is only its first
   * file (the downloader picks `item` from the post instead).
   */
  private directPost(post: InstagramMedia, item: number | undefined): boolean {
    if (post.mediaType === CAROUSEL) return false;
    if (item && item > 1) throw new DapiError("not-found", `This post holds one file, so it has no item ${item}. Leave \`item\` out.`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Where the file goes

  /**
   * The folder the file lands in, made when missing, by its real path. In a
   * project: a library folder under `assets/` (an absolute folder inside it
   * counts as that), which must stay inside the project. Without one: an
   * absolute folder (judged by the output policy before the call came here).
   */
  private async destination(request: MediaDownloadRequest, fallback: string): Promise<Destination> {
    const given = request.folder?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!request.dir) {
      if (!given || !isAbsolute(given)) {
        throw new DapiError("no-project", "No project is open. Open one first, or pass an absolute `folder` to save the file there without a project.");
      }
      if (given.split("/").some((part) => part.startsWith("."))) throw new DapiError("invalid-input", "`folder` can't be or go through a hidden folder.");
      await mkdir(given, { recursive: true });
      return { project: false, folder: given, real: await realpath(given) };
    }
    if (!isAbsolute(request.dir)) throw new DapiError("no-project", "No project is open. Open one first.");
    const root = await realpath(request.dir).catch(() => null);
    if (!root || !(await stat(root)).isDirectory()) throw new DapiError("no-project", "The open project's folder is missing. Open the project again.");
    let folder = given ?? fallback;
    if (isAbsolute(folder)) {
      const assets = join(request.dir, "assets");
      const inside = [assets, join(root, "assets")].map((base) => relative(base, folder)).find((rel) => rel && !rel.startsWith("..") && !isAbsolute(rel));
      if (!inside) throw new DapiError("invalid-input", `With a project open, ${LIBRARY_FOLDER_RULE}`);
      folder = inside.split(sep).join("/");
    }
    if (!LIBRARY_FOLDER.test(folder)) throw new DapiError("invalid-input", `That folder isn't one media_download can use: ${LIBRARY_FOLDER_RULE}`);
    // A level at a time below the project, never the project itself: a folder that moved away must not come back empty where it was.
    let current = request.dir;
    for (const part of ["assets", ...folder.split("/")]) {
      current = join(current, part);
      await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    const real = await realpath(current);
    const refusal = libraryFolderRefusal(root, real, `assets/${folder}`);
    if (refusal) throw new DapiError("invalid-input", refusal);
    return { project: true, dir: request.dir, root, folder, real };
  }

  /**
   * A folder of the job's own next to where the file lands: in the project's
   * `.cutroom/` (agent-protected), or hidden in the absolute folder. Its name
   * carries the app's temp prefix, which the project watcher ignores and a
   * duplicate of the project leaves out.
   */
  private async workDir(destination: Destination, id: string): Promise<string> {
    const safe = `${WORK_PREFIX}${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID()}`;
    if (!destination.project) {
      const work = join(destination.real, safe);
      await mkdir(work);
      return work;
    }
    // Both folders must be real ones where they stand: a link in place of either (a project copied
    // from elsewhere, or an agent's shell) would carry the work folder, and the sweep, out of the project.
    const app = join(destination.root, LEDGER_DIR);
    await mkdir(app, { recursive: true });
    await realFolder(app, LEDGER_DIR);
    const downloads = join(app, DOWNLOADS_DIR);
    await mkdir(downloads, { recursive: true });
    await realFolder(downloads, `${LEDGER_DIR}/${DOWNLOADS_DIR}`);
    if (dirname(await realpath(downloads)) !== (await realpath(app))) throw new Error(`The project's ${LEDGER_DIR}/${DOWNLOADS_DIR} folder must be a real folder.`);
    await this.sweep(downloads);
    const work = join(downloads, safe);
    await mkdir(work);
    return work;
  }

  /**
   * Clears work folders a crash left behind: only folders named as
   * `workDir` names them, never a link or anything else found there.
   */
  private async sweep(downloads: string): Promise<void> {
    const active = new Set([...this.jobs].map((job) => job.work).filter((work): work is string => work !== null));
    const cutoff = this.now().getTime() - STALE_WORK_MS;
    for (const name of await readdir(downloads).catch(() => [])) {
      if (!name.startsWith(WORK_PREFIX)) continue;
      const path = join(downloads, name);
      if (active.has(path)) continue;
      // lstat: a link reads as a link, not as the folder it leads to.
      const info = await lstat(path).catch(() => null);
      if (info?.isDirectory() && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Reuse

  /**
   * A saved download of this upload (recorded, or pending) whose file still
   * holds its bytes; outside a project there is no record. A video capped
   * lower than `maxHeight` asks for doesn't count: a larger one may exist.
   */
  private async recorded(destination: Destination, site: string, id: string, kind: MediaKind, maxHeight: MediaMaxHeight): Promise<MediaLedgerItem | null> {
    if (!destination.project) return null;
    const { dir } = destination;
    const ledger = await readLedger(dir);
    const tallEnough = (platform: PlatformProvenance) => kind === "audio" || platform.maxHeight === undefined || platform.maxHeight >= maxHeight;
    const candidates = [
      ...[...this.pending.values()].filter((entry) => entry.dir === dir).map((entry) => entry.item),
      ...(ledger.items as MediaLedgerItem[]),
    ].filter((item) => item.platform?.site === site && item.platform.id === id && item.platform.kind === kind && tallEnough(item.platform))
      // The closest fit first: a 360p ask takes the 360p copy over a 1080p one.
      .sort((a, b) => (a.platform!.maxHeight ?? UNCAPPED) - (b.platform!.maxHeight ?? UNCAPPED));
    for (const item of candidates) if (await holds(itemPath(dir, item.file), item.bytes, item.sha256)) return item;
    return null;
  }

  /** A file named after the upload already in the folder that no record claims: copied in by hand, say. It is adopted once it probes as the kind asked for. */
  private async untracked(destination: Destination, stem: string, kind: MediaKind, signal: AbortSignal): Promise<string | null> {
    const ledger = destination.project ? await readLedger(destination.dir) : null;
    for (const ext of EXTENSIONS[kind]) {
      const path = join(destination.real, `${stem}.${ext}`);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      if (ledger?.items.some((item) => item.file === `assets/${destination.project ? destination.folder : ""}/${stem}.${ext}`)) continue;
      const streams = await this.probe(path, signal).catch(() => null);
      if (streams && streams.durationSeconds > 0 && (kind === "video" ? !!streams.video : !!streams.audio)) return path;
    }
    return null;
  }

  /** Answers with a recorded download, held for the renderer as a new one is (it was in the project already). */
  private async reuse(
    request: MediaDownloadRequest, destination: Destination, item: MediaLedgerItem, requestedUrl: string, kind: MediaKind, warnings: string[], signal: AbortSignal,
  ): Promise<MediaDownloaded> {
    const dir = (destination as Extract<Destination, { project: true }>).dir;
    const path = itemPath(dir, item.file);
    const streams = await this.probe(path, signal).catch(() => null);
    const platform = item.platform!;
    const side = shortSide(streams?.video);
    // Only a download capped higher than this one: a file of the user's own (an Instagram reel) has the one size its site serves.
    if (kind === "video" && platform.maxHeight !== undefined && platform.maxHeight > request.maxHeight && side && side > request.maxHeight) {
      warnings.push(`This video was in the project already at ${side}p, larger than the ${request.maxHeight}p asked for; that file was reused rather than downloading a smaller one.`);
    }
    this.hold(request.id, dir, item, false);
    return {
      id: request.id,
      source: item.file,
      folder: folderOf(item.file),
      path,
      mediaId: platform.id,
      site: platform.site,
      kind,
      title: item.title ?? platform.id,
      ...withoutUndefined({ channel: platform.channel, channelUrl: platform.channelUrl, uploadDate: platform.uploadDate }),
      durationSeconds: streams?.durationSeconds ?? platform.durationSeconds ?? 0,
      ...(streams?.video?.width ? { width: streams.video.width } : {}),
      ...(streams?.video?.height ? { height: streams.video.height } : {}),
      ...withoutUndefined({ videoCodec: streams?.video?.codec ?? platform.videoCodec, audioCodec: streams?.audio?.codec ?? platform.audioCodec }),
      hasAudio: streams ? !!streams.audio : kind === "audio" || !!platform.audioCodec,
      mimeType: item.mimeType,
      bytes: item.bytes,
      sha256: item.sha256,
      sourceUrl: platform.pageUrl,
      requestedUrl,
      reused: true,
      reencoded: false,
      downloader: platform.downloader,
      attribution: item.attribution ?? platformAttribution({ title: item.title ?? platform.id, channel: platform.channel, site: platform.site, pageUrl: platform.pageUrl }),
      creditsFile: join(dir, CREDITS_FILE),
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Fetching

  /** The user's own Instagram post a permalink names, when the analytics cache has its file link. */
  private async ownInstagram(url: URL): Promise<InstagramMedia | null> {
    if (platformOf(url) !== "instagram" && !isInstagramCdn(url)) return null;
    const post = await this.instagramMedia(url.href).catch(() => null);
    return post?.mediaUrl ? post : null;
  }

  private async fromDownloader(
    request: MediaDownloadRequest, requested: URL, kind: MediaKind, destination: Destination, work: string, signal: AbortSignal, warnings: string[],
  ): Promise<Fetched | { recorded: MediaLedgerItem }> {
    const downloader = this.downloader();
    if (!downloader) throw new DapiError("unsupported", NO_DOWNLOADER);
    const known = platformOf(requested);
    // A known platform's link is read by its own extractor, never the generic one, which would follow it anywhere.
    const common = known ? ["--use-extractors", "default,-generic"] : [];
    const format = formatArgs(kind, request.maxHeight);
    const recovery = {
      signal,
      site: known ?? undefined,
      ...(this.classify ? { classify: this.classify } : {}),
      ...(this.networkRetryMs !== undefined ? { networkRetryMs: this.networkRetryMs } : {}),
    };
    let updated = false;
    const metadata = async (flat: boolean, item: number | undefined, afterUpdate: boolean) => {
      const run = await runRecovering(downloader, [
        ...common, "--no-playlist", ...(flat ? ["--flat-playlist"] : []),
        // A list is counted only as far as `item` reaches, so a channel or a long playlist isn't read to its end.
        ...(item ? ["--playlist-items", String(item)] : ["--playlist-end", String(LIST_MAX + 1)]),
        ...format, "-J", "--skip-download", requested.href,
      ], { ...recovery, purpose: "metadata", timeoutMs: this.timeouts.metadata, updated: updated || afterUpdate });
      updated ||= run.updated;
      for (const note of run.notes) if (!warnings.includes(note)) warnings.push(note);
      return { info: parseListing(run.stdout), version: run.version };
    };
    const cap = this.caps[kind];
    /** The one upload the link is about, read and checked against the caps; again after an update, by the new downloader. */
    const read = async (afterUpdate: boolean) => {
      // A list is counted from its flat listing first, so a link to a long playlist doesn't read every entry.
      let { info, version } = await metadata(!request.item, request.item, afterUpdate);
      let { entry, complete } = selectEntry(info, request.item);
      if (!complete) {
        ({ info, version } = await metadata(false, request.item ?? 1, afterUpdate));
        ({ entry, complete } = selectEntry(info, request.item ?? 1));
        if (!complete) throw new DapiError("unsupported", "The downloader found this upload but couldn't read its formats. Choose another source.");
      }
      const live = entry.live_status;
      if (live === "is_live" || live === "is_upcoming" || entry.is_live === true) {
        throw new DapiError("unsupported", `This is a ${live === "is_upcoming" ? "stream that hasn't started yet" : "live stream"}. Download it once the stream has ended, or choose another source.`);
      }
      const duration = count(entry.duration);
      if (duration !== null && duration > cap.seconds) throw tooLong(kind, duration, cap.seconds);
      const estimate = estimatedBytes(entry);
      if (estimate !== null && estimate > cap.bytes) throw tooLarge(kind, estimate, cap.bytes);
      return { entry, version };
    };
    const first = await read(false);
    let entry = first.entry;

    // The extractor names the site; the link's host does when the generic one read it.
    const extractor = siteOfExtractor(text(entry.extractor_key) ?? text(entry.ie_key) ?? text(entry.extractor));
    const site = extractor === "web" && known ? known : extractor;
    const mediaId = text(String(entry.id ?? ""), 200) ?? mediaIdOf(requested)?.id ?? fileStem(basename(requested.pathname));
    const recorded = await this.recorded(destination, site, mediaId, kind, request.maxHeight);
    if (recorded) return { recorded };

    const pageUrl = httpUrl(entry.webpage_url) ?? requested.href;
    const about = {
      site,
      mediaId,
      title: text(entry.title) ?? text(entry.fulltitle) ?? mediaId,
      ...withoutUndefined({
        channel: text(entry.channel, 200) ?? text(entry.uploader, 200) ?? text(entry.artist, 200),
        channelUrl: httpUrl(entry.channel_url) ?? httpUrl(entry.uploader_url),
        uploadDate: day(entry.upload_date) ?? day(entry.release_date),
      }),
      pageUrl,
      downloader: `yt-dlp ${first.version}`,
      reencoded: false,
      ...(kind === "video" ? { maxHeight: request.maxHeight } : {}),
    };
    const formatsOf = (chosen: Json) => {
      const ids = (Array.isArray(chosen.requested_formats) ? chosen.requested_formats.map((part) => object(part)?.format_id) : [chosen.format_id])
        .filter((id): id is string => typeof id === "string");
      return ids.length ? { formats: ids } : {};
    };

    const existing = await this.untracked(destination, fileStem(mediaId), kind, signal);
    if (existing) return { ...about, ...formatsOf(entry), file: existing, inPlace: true };

    const infoPath = join(work, "info.json");
    await writeFile(infoPath, JSON.stringify(entry));
    await mkdir(join(work, "tmp"));
    let logged = -1;
    const progress = (line: string) => {
      const match = /^\[cutroom\] (\d+) (\d+)/.exec(line.trim());
      if (!match) return;
      const percent = Math.min(100, Math.floor((Number(match[1]) / Math.max(1, Number(match[2]))) * 10) * 10);
      if (percent > logged) {
        logged = percent;
        console.info(`[media] ${site}:${mediaId} ${percent}%`);
      }
    };
    const run = await runRecovering(downloader, [
      ...common,
      "--load-info-json", infoPath,
      ...format,
      ...(kind === "audio" ? ["-x"] : ["--merge-output-format", "mp4", "--remux-video", "mp4"]),
      "--max-filesize", String(cap.bytes),
      "-P", `home:${work}`, "-P", `temp:${join(work, "tmp")}`,
      "-o", "%(id)s.%(ext)s",
      "--no-mtime",
      "--print", "after_move:filepath",
      "--progress", "--newline", "--progress-template", PROGRESS_TEMPLATE,
    ], {
      ...recovery,
      purpose: "download",
      site,
      timeoutMs: this.timeouts.download,
      idleTimeoutMs: this.timeouts.idle,
      // What passes the egress gate: the media, plus room for the pages and manifests around it.
      maxBytes: Math.round(cap.bytes * 1.05) + 64 * MB,
      onStdoutLine: progress,
      onStderrLine: progress,
      updated,
      // The saved formats came from the old downloader's reading of the page (their links may be what failed): the new one reads it again.
      refresh: async () => {
        ({ entry } = await read(true));
        await rm(join(work, "tmp"), { recursive: true, force: true });
        await mkdir(join(work, "tmp"));
        await writeFile(infoPath, JSON.stringify(entry));
      },
    });
    for (const note of run.notes) if (!warnings.includes(note)) warnings.push(note);
    return { ...about, ...formatsOf(entry), file: await this.outputFile(run.stdout, work, kind, cap.bytes), downloader: `yt-dlp ${run.version}` };
  }

  /**
   * The file a download made: the path it printed, else the largest media
   * file in its work folder. None at all after a clean exit is the
   * downloader skipping a file over `--max-filesize`, which it does quietly.
   */
  private async outputFile(stdout: string, work: string, kind: MediaKind, cap: number): Promise<string> {
    const printed = stdout.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("[") && isAbsolute(line)).reverse();
    for (const path of printed) {
      if (within(work, path) && (await stat(path).catch(() => null))?.isFile()) return path;
    }
    let best: { path: string; size: number } | undefined;
    for (const name of await readdir(work)) {
      if (name === "info.json" || /\.(part|ytdl|json|temp|tmp)$/i.test(name) || name.includes(".part-")) continue;
      const path = join(work, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && (!best || info.size > best.size)) best = { path, size: info.size };
    }
    if (!best) throw tooLarge(kind, null, cap);
    return best.path;
  }

  private async fromMyInstants(requested: URL, work: string, signal: AbortSignal): Promise<Fetched> {
    if (!this.pageFetch) throw new DapiError("unsupported", "MyInstants can't be downloaded from in this build. Use a sound from the audio catalog or web_media_search instead.");
    const page = myInstantsPage(requested)!;
    const temp = join(work, `${fileStem(page.slug)}.mp3`);
    const sound = await fetchMyInstantsSound(page.url, temp, { fetch: this.pageFetch, resolve: this.resolve, signal });
    return {
      file: temp,
      site: "myinstants",
      mediaId: sound.slug,
      title: sound.title,
      pageUrl: sound.pageUrl,
      downloader: "Blackout (MyInstants page)",
      reencoded: false,
      maxSeconds: MYINSTANTS_DURATION_MAX,
    };
  }

  /**
   * One of the user's own Instagram files, fetched directly from Instagram's
   * CDN (the Graph API's `media_url`), which needs no sign-in, and named
   * after the post's id. The sound alone is copied out of it without
   * re-encoding.
   */
  private async fromInstagram(requested: URL, own: InstagramMedia | null, kind: MediaKind, work: string, signal: AbortSignal, warnings: string[]): Promise<Fetched> {
    const post = own ?? (await this.instagramMedia(requested.href).catch(() => null));
    const source = checkWebUrl(post?.mediaUrl ?? requested.href);
    const mediaId = post?.id ?? (fileStem(basename(source.pathname).replace(/\.[a-z0-9]{1,5}$/i, "")).slice(0, 64) || "instagram");
    const stem = fileStem(mediaId);
    const download = join(work, `${stem}.download`);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.timeouts.direct)]);
    const cap = this.caps.video.bytes;
    let url = source;
    let response: Response | undefined;
    try {
      for (let hop = 0; ; hop++) {
        await resolvePublic(hostOf(url), this.resolve);
        response = await this.fetch(url.href, { signal: bounded, headers: { "user-agent": this.userAgent, accept: "video/*,audio/*,*/*;q=0.5" } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          const location = response.headers.get("location");
          if (!location || hop >= MAX_REDIRECTS) throw new DapiError("invalid-input", "Instagram's file link redirected too many times. Call instagram_posts again for a fresh `mediaUrl`.");
          url = checkWebUrl(new URL(location, url));
          continue;
        }
        break;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([400, 401, 403, 404, 410].includes(response.status)) {
          throw new DapiError("not-found", `Instagram's link to this file has expired (${response.status}). Call instagram_posts again for a fresh \`mediaUrl\`, or pass the post's permalink.`);
        }
        throw new DapiError("invalid-input", `Instagram's file server answered ${response.status}. Try once more in a moment.`);
      }
      if (Number(response.headers.get("content-length")) > cap) {
        await response.body?.cancel().catch(() => {});
        throw tooLarge("video", Number(response.headers.get("content-length")), cap);
      }
      await this.save(response, download, cap, bounded);
    } catch (error) {
      if (signal.aborted) throw canceled(signal);
      if (bounded.aborted) throw new DapiError("canceled", `The download took longer than ${Math.round(this.timeouts.direct / 60_000)} minutes and was stopped. Try once more.`);
      if (error instanceof DapiError) throw error;
      throw new DapiError("invalid-input", `Couldn't download Instagram's file (${(error as Error).message}). Check the internet connection, then try once more.`, { cause: error });
    }
    const sniffed = sniff(await head(download), "video");
    if (sniffed.kind !== "video" && sniffed.kind !== "audio") {
      throw new DapiError("unsupported", sniffed.kind === "image"
        ? "This Instagram post is a picture, which media_download doesn't take. Pass a video post's `mediaUrl`."
        : "Instagram's file link answered with something other than a video. Call instagram_posts again for a fresh `mediaUrl`.");
    }
    let file = join(work, `${stem}.${sniffed.ext}`);
    await rename(download, file);
    if (kind === "audio" && sniffed.kind === "video") {
      if (!this.extractAudio) throw new DapiError("unsupported", "Saving only the sound of an Instagram video needs the app's audio tools, which this build lacks. Pass `kind: \"video\"`.");
      const sound = join(work, `${stem}.m4a`);
      try {
        await this.extractAudio(file, sound, signal);
      } catch (error) {
        if (signal.aborted) throw canceled(signal);
        throw new DapiError("unsupported", `Couldn't copy the sound out of this Instagram video (${(error as Error).message}). Pass \`kind: "video"\` to keep the whole file.`);
      }
      await rm(file, { force: true });
      file = sound;
    }
    const caption = text(post?.caption ?? undefined, 120)?.split(/(?<=[.!?])\s/)[0];
    const pageUrl = post?.permalink ?? httpUrl(`${source.origin}${source.pathname}`) ?? requested.origin;
    if (!post) warnings.push("This file isn't in the Instagram analytics cache, so it is named after its file and credited to its file link; run instagram_posts first to have it named after the post.");
    return {
      file,
      site: "instagram",
      mediaId,
      title: caption || `Instagram post ${mediaId}`,
      ...(post?.username ? { channel: `@${post.username}`, channelUrl: `https://www.instagram.com/${post.username}/` } : {}),
      pageUrl,
      downloader: "Blackout (Instagram file)",
      reencoded: false,
    };
  }

  /** Streams a response into `path` (created; it must not exist), up to `cap` bytes, failing when nothing arrives for the idle time. */
  private async save(response: Response, path: string, cap: number, signal: AbortSignal): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new DapiError("invalid-input", "Instagram sent no file.");
    const file = await open(path, "wx", 0o644);
    let bytes = 0;
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; void reader.cancel().catch(() => {}); }, this.timeouts.idle);
      timer.unref?.();
    };
    const stop = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    try {
      touch();
      for (;;) {
        const next = await reader.read();
        if (signal.aborted) throw canceled(signal);
        if (stalled) throw new DapiError("invalid-input", `Instagram stopped sending data for ${Math.round(this.timeouts.idle / 1000)} seconds. Try once more.`);
        if (next.done) break;
        touch();
        bytes += next.value.byteLength;
        if (bytes > cap) throw tooLarge("video", bytes, cap);
        await file.write(next.value);
      }
      if (!bytes) throw new DapiError("invalid-input", "Instagram sent an empty file. Call instagram_posts again for a fresh `mediaUrl`.");
      await file.sync();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      await reader.cancel().catch(() => {});
      await file.close().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Checking and landing

  /** Probes the file: it must play, hold the picture or sound asked for, and stay within the caps. */
  private async verify(fetched: Fetched, kind: MediaKind, signal: AbortSignal, warnings: string[]): Promise<Verified> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.timeouts.verify)]);
    let streams: MediaStreams;
    try {
      streams = await this.probe(fetched.file, bounded);
    } catch (error) {
      if (signal.aborted) throw canceled(signal);
      throw new DapiError("unsupported", `The downloaded file couldn't be read as media (${(error as Error).message}). Choose another source.`);
    }
    if (!(streams.durationSeconds > 0)) throw new DapiError("unsupported", "The downloaded file has nothing to play. Choose another source.");
    if (kind === "video") {
      if (!streams.video) throw new DapiError("unsupported", "The download has no picture. Pass `kind: \"audio\"` for sound, or choose another source.");
      if (!VIDEO_CODECS.has(streams.video.codec)) {
        throw new DapiError("unsupported", `No picture the editor can play came with this video (${streams.video.codec}${streams.audio ? ` with ${streams.audio.codec}` : ""}); choose another source.`);
      }
      if (!streams.audio) warnings.push("This video has no sound.");
      // The cap ranks the formats rather than ruling any out: a site with nothing that small gives its smallest picture.
      const side = shortSide(streams.video);
      if (fetched.maxHeight !== undefined && side !== undefined && side > fetched.maxHeight) {
        const picture = streams.video.width ? `${streams.video.width}x${streams.video.height}` : `${side}p`;
        warnings.push(fetched.inPlace
          ? `The file already in the folder is ${picture}, larger than the ${fetched.maxHeight}p asked for; it was kept rather than downloading a smaller one.`
          : `Nothing at or under ${fetched.maxHeight}p was offered, so the smallest picture there was, ${picture}, was taken.`);
      }
    } else {
      if (!streams.audio) throw new DapiError("unsupported", "The download has no sound. Choose another source.");
      if (!AUDIO_CODECS.test(streams.audio.codec)) throw new DapiError("unsupported", `The sound came in a format the editor can't play (${streams.audio.codec}); choose another source.`);
    }
    const maxSeconds = Math.min(fetched.maxSeconds ?? Infinity, this.caps[kind].seconds);
    if (streams.durationSeconds > maxSeconds) {
      if (fetched.maxSeconds !== undefined && fetched.maxSeconds < this.caps[kind].seconds) {
        throw new DapiError("invalid-input", `This sound runs ${clock(streams.durationSeconds)}, longer than the ${clock(fetched.maxSeconds)} a MyInstants sound may run. Pick another one.`);
      }
      throw tooLong(kind, streams.durationSeconds, this.caps[kind].seconds);
    }
    const sniffed = sniff(await head(fetched.file), kind === "video" ? "video" : "image");
    if (sniffed.kind === "html" || sniffed.kind === "rejected" || sniffed.kind === "image") {
      throw new DapiError("unsupported", "The download isn't a media file. Choose another source.");
    }
    const ext = extname(fetched.file).slice(1).toLowerCase() || sniffed.ext;
    const mimeType = kind === "audio" && ext === "webm" ? "audio/webm" : MIME_TYPES[ext] ?? sniffed.mimeType;
    const info = await stat(fetched.file);
    if (info.size > this.caps[kind].bytes) throw tooLarge(kind, info.size, this.caps[kind].bytes);
    return { streams, ext, mimeType, bytes: info.size, sha256: await sha256Of(fetched.file) };
  }

  /**
   * Moves a checked file to `<stem>.<ext>` in its folder: the same bytes
   * already there (or anywhere the project recorded them) are reused rather
   * than written twice; a different file under the name moves this one to
   * `<stem>-<site>` when that one came from another site, else `-2`, `-3`, …
   * In a project, under its lock, held as pending before the lock is let go.
   */
  private async land(
    request: MediaDownloadRequest, destination: Destination, fetched: Fetched, verified: Verified, kind: MediaKind, requestedUrl: string, warnings: string[], signal: AbortSignal,
  ): Promise<MediaDownloaded> {
    const stem = fileStem(fetched.mediaId);
    const { ext, sha256, bytes } = verified;
    const platform: PlatformProvenance = withoutUndefined({
      site: fetched.site,
      id: fetched.mediaId,
      kind,
      pageUrl: fetched.pageUrl,
      channel: fetched.channel,
      channelUrl: fetched.channelUrl,
      uploadDate: fetched.uploadDate,
      durationSeconds: verified.streams.durationSeconds,
      videoCodec: verified.streams.video?.codec,
      audioCodec: verified.streams.audio?.codec,
      formats: fetched.formats,
      maxHeight: answeredCap(fetched.maxHeight, shortSide(verified.streams.video)),
      downloader: fetched.downloader,
    });
    const attribution = platformAttribution({ title: fetched.title, channel: fetched.channel, site: fetched.site, pageUrl: fetched.pageUrl });

    const place = async (names: (attempt: number) => string) => {
      for (let attempt = 1; ; attempt++) {
        const name = `${names(attempt)}.${ext}`;
        const target = join(destination.real, name);
        if (fetched.inPlace && resolve(target) === resolve(fetched.file)) return { name, reused: true, created: false };
        if (await holds(target, bytes, sha256)) {
          if (!fetched.inPlace) await rm(fetched.file, { force: true });
          return { name, reused: true, created: false };
        }
        if (await lstat(target).catch(() => null)) continue;
        await rename(fetched.file, target);
        return { name, reused: !!fetched.inPlace, created: !fetched.inPlace };
      }
    };

    if (!destination.project) {
      const placed = await place((attempt) => (attempt === 1 ? stem : `${stem}-${attempt}`));
      return this.answer(request, null, null, join(destination.real, placed.name), fetched, verified, kind, requestedUrl, placed.reused, attribution, null, warnings);
    }

    const { dir, folder } = destination;
    const landing = this.startWrite(dir);
    try {
      const landed = await withProjectLock(dir, async () => {
        const ledger = await readLedger(dir);
        const same = await this.sameBytes(dir, ledger, sha256);
        if (same && !(fetched.inPlace && resolve(itemPath(dir, same.file)) === resolve(fetched.file))) {
          if (!fetched.inPlace) await rm(fetched.file, { force: true });
          this.hold(request.id, dir, { ...same, platform: same.platform ?? platform }, false);
          return { source: same.file, reused: true };
        }
        const holder = (ledger.items as MediaLedgerItem[]).find((item) => item.file === `assets/${folder}/${stem}.${ext}`);
        const otherSite = !!holder?.platform && holder.platform.site !== fetched.site;
        const names = (attempt: number) => (attempt === 1 ? stem : attempt === 2 && otherSite ? `${stem}-${fetched.site}` : `${stem}-${otherSite ? attempt - 1 : attempt}`);
        const placed = await place(names);
        const source = `assets/${folder}/${placed.name}`;
        const item: MediaLedgerItem = {
          file: source,
          sha256,
          bytes,
          kind,
          mimeType: verified.mimeType,
          title: fetched.title,
          ...(fetched.channel ? { creator: fetched.channel } : {}),
          pageUrl: fetched.pageUrl,
          // Never a file's own (signed, expiring) link: the page is what a credit points at.
          fileUrl: fetched.pageUrl,
          requestedUrl,
          license: UNKNOWN_LICENSE,
          attribution,
          downloadedAt: this.now().toISOString(),
          platform,
        };
        this.hold(request.id, dir, item, placed.created);
        return { source, reused: placed.reused };
      });
      // Stopped while landing (a save of the project): what landed goes again before the save is let through.
      if (signal.aborted) {
        await this.discard(request.id).catch(() => {});
        throw canceled(signal);
      }
      return this.answer(request, landed.source, folderOf(landed.source), itemPath(dir, landed.source), fetched, verified, kind, requestedUrl, landed.reused, attribution, join(dir, CREDITS_FILE), warnings);
    } finally {
      landing();
    }
  }

  private answer(
    request: MediaDownloadRequest, source: string | null, folder: string | null, path: string, fetched: Fetched, verified: Verified, kind: MediaKind,
    requestedUrl: string, reused: boolean, attribution: string, creditsFile: string | null, warnings: string[],
  ): MediaDownloaded {
    const { streams } = verified;
    return {
      id: request.id,
      source,
      folder,
      path,
      mediaId: fetched.mediaId,
      site: fetched.site,
      kind,
      title: fetched.title,
      ...withoutUndefined({ channel: fetched.channel, channelUrl: fetched.channelUrl, uploadDate: fetched.uploadDate }),
      durationSeconds: streams.durationSeconds,
      ...(kind === "video" && streams.video?.width ? { width: streams.video.width } : {}),
      ...(kind === "video" && streams.video?.height ? { height: streams.video.height } : {}),
      ...withoutUndefined({ videoCodec: kind === "video" ? streams.video?.codec : undefined, audioCodec: streams.audio?.codec }),
      hasAudio: !!streams.audio,
      mimeType: verified.mimeType,
      bytes: verified.bytes,
      sha256: verified.sha256,
      sourceUrl: fetched.pageUrl,
      requestedUrl,
      reused,
      reencoded: fetched.reencoded,
      downloader: fetched.downloader,
      attribution,
      creditsFile,
      warnings,
    };
  }

  /** A recorded or pending file of the project with these bytes, still holding them. */
  private async sameBytes(dir: string, ledger: WebMediaLedger, sha256: string): Promise<MediaLedgerItem | null> {
    const candidates = [
      ...(ledger.items as MediaLedgerItem[]).filter((item) => item.sha256 === sha256),
      ...[...this.pending.values()].filter((entry) => entry.dir === dir && entry.item.sha256 === sha256).map((entry) => entry.item),
    ];
    for (const item of candidates) if (await holds(itemPath(dir, item.file), item.bytes, sha256)) return item;
    return null;
  }

  // -------------------------------------------------------------------------
  // Commit and discard, as web_media_download's

  private hold(id: string, dir: string, item: MediaLedgerItem, created: boolean): void {
    // A renderer that went away mid-import never answers; the file stays, so its credit does too.
    const timer = setTimeout(() => {
      void this.commit({ id, assetId: "", src: "", source: item.file }).catch((error: Error) =>
        console.warn(`[media] could not record ${item.file}: ${error.message}`));
    }, this.timeouts.pending);
    timer.unref?.();
    this.pending.set(id, { dir, item, created, timer });
  }

  private take(id: string): Pending {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("This media download is no longer pending. Download it again.");
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry;
  }

  /** Whether a file this download created can go: not while the ledger records it, nor while another pending download reuses it (which then owns it). */
  private releasable(dir: string, file: string, ledger: WebMediaLedger): boolean {
    if (ledger.items.some((item) => item.file === file)) return false;
    const heir = [...this.pending.values()].find((entry) => entry.dir === dir && entry.item.file === file);
    if (heir) heir.created = true;
    return !heir;
  }

  /**
   * Records an imported download in the ledger and rewrites CREDITS.md. When
   * the library answered with an asset it already had for the same bytes
   * (`source` is not the download's file), the download's own file goes.
   */
  async commit(request: MediaCommitRequest): Promise<MediaCommitResult> {
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
        const ids = { ...(request.assetId ? { assetId: request.assetId } : {}), ...(request.src ? { src: request.src } : {}) };
        const at = ledger.items.findIndex((other) => other.file === source);
        if (at < 0) ledger.items.push({ ...item, file: source, ...ids });
        else {
          const before = ledger.items[at] as MediaLedgerItem;
          ledger.items[at] = { ...before, ...(before.platform ? {} : { platform: item.platform }), ...ids } as MediaLedgerItem;
        }
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

let singleton: MediaDownloadService | undefined;

/** The app's one download service (configured by main.ts; see `configureMediaDownloads`). */
export function mediaDownloadService(): MediaDownloadService {
  return (singleton ??= new MediaDownloadService({ downloader: () => null, probe: async () => { throw new Error("no media probe is configured"); } }));
}

/** Sets up the app's download service with what only main.ts has; call once, before any download. */
export function configureMediaDownloads(options: MediaDownloadOptions): MediaDownloadService {
  singleton = new MediaDownloadService(options);
  return singleton;
}
