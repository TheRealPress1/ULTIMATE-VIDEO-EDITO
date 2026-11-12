/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DapiError } from "@diffusionstudio/dapi";
import {
  AUDIO_FORMAT, MediaDownloadService, VIDEO_FORMAT, estimatedBytes, findInstagramMedia, formatArgs, parseFfmpegInfo, parseFfprobe, platformAttribution, selectEntry, videoSort,
} from "./media-download";
import {
  FFMPEG_INFO, FFPROBE_AAC, FFPROBE_H264, HUGE_INFO, INSTAGRAM_CAROUSEL, LIVE_INFO, LONG_INFO, MYINSTANTS_PAGE, SOUNDCLOUD_TRACK_INFO, UPCOMING_INFO,
  YOUTUBE_VIDEO_INFO, YOUTUBE_VIDEO_INFO_VIDEO,
} from "./media-fixtures";
import { readLedger } from "./web-media-ledger";
import { TEMP_PREFIX, isTempPath } from "./atomic";

import type { DownloaderRun, MediaDownloader } from "./media-runner";
import type { InstagramFreshPost } from "./instagram-types";
import type { MediaDownloadRequest } from "./media-download-types";
import type { MediaStreams } from "./media-download";
import type { MediaLedgerItem } from "./media-download-types";

const root = realpathSync(mkdtempSync(join(tmpdir(), "media-download-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let project: string;
beforeEach(() => {
  project = mkdtempSync(join(root, "project-"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "p", projectId: "p" }));
});

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 as const }];

/** The first bytes of each kind of file the tests land, then something unique, so each stub sniffs as what it is and hashes apart. */
function stub(ext: string, tag: string): Buffer {
  const head = ext === "mp3"
    ? Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000", "latin1")
    : Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(ext === "mp4" ? "ftypisom\u0000\u0000\u0002\u0000isomiso2" : "ftypM4A \u0000\u0000\u0000\u0000M4A isom", "latin1")]);
  return Buffer.concat([head, Buffer.from(`:${tag}:`.padEnd(64, "."))]);
}

/** What the probe says, by the file's extension, unless a test says otherwise for its name. */
const probed = new Map<string, MediaStreams | Error>();
const probe = vi.fn(async (path: string): Promise<MediaStreams> => {
  const own = probed.get(basename(path));
  if (own instanceof Error) throw own;
  if (own) return own;
  const content = readFileSync(path, "latin1");
  if (content.includes(":junk:")) throw new Error("Invalid data found when processing input");
  switch (extname(path)) {
    case ".m4a": return { durationSeconds: 187, audio: { codec: "aac" } };
    case ".mp3": return { durationSeconds: 201, audio: { codec: "mp3" } };
    case ".opus": return { durationSeconds: 260, audio: { codec: "opus" } };
    case ".mp4": return { durationSeconds: 187, video: { codec: "h264", width: 1280, height: 720 }, audio: { codec: "aac" } };
    default: throw new Error("unknown file");
  }
});

type Metadata = (args: string[]) => unknown;

/** A fake downloader: metadata runs answer with `metadata(args)`; download runs write the stub its info names into `home:` and print its path. */
function downloader(metadata: Metadata) {
  const runs: string[][] = [];
  let hold: Promise<void> | null = null;
  const fake = {
    status: () => ({ state: "ready" as const, version: "2026.10.26" }),
    ensure: vi.fn(async () => ({ path: "/bin/yt-dlp", version: "2026.10.26" })),
    update: vi.fn(async () => ({ version: "2026.10.26", changed: false })),
    run: vi.fn(async (args: string[], opts: { signal?: AbortSignal; onStdoutLine?: (line: string) => void }): Promise<DownloaderRun> => {
      runs.push(args);
      const at = args.indexOf("--load-info-json");
      if (at < 0) {
        const answer = metadata(args);
        if (answer instanceof Error) return { code: 1, signal: null, stdout: "", stderr: `ERROR: ${answer.message}` };
        return { code: 0, signal: null, stdout: JSON.stringify(answer), stderr: "" };
      }
      if (hold) await hold;
      if (opts.signal?.aborted) return { code: null, signal: "SIGTERM", stdout: "", stderr: "ERROR: [cutroom:canceled] canceled" };
      const info = JSON.parse(readFileSync(args[at + 1]!, "utf8")) as { id: string; acodec?: string };
      const home = args.find((arg) => arg.startsWith("home:"))!.slice(5);
      const ext = args.includes("-x") ? (info.acodec?.startsWith("mp4a") ? "m4a" : info.acodec ?? "m4a") : "mp4";
      const file = join(home, `${info.id}.${ext}`);
      // Bytes by upload, format and ranking, so a video capped lower is a different file.
      const choice = ["-f", "-S"].map((flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1]! : "")).join(" ");
      writeFileSync(file, stub(ext, `${info.id}-${ext}-${createHash("sha1").update(choice).digest("hex").slice(0, 8)}`));
      for (const line of ["[cutroom] 10 100", "[cutroom] 100 100"]) opts.onStdoutLine?.(line);
      return { code: 0, signal: null, stdout: `[cutroom] 100 100\n${file}\n`, stderr: "" };
    }),
  } satisfies MediaDownloader;
  return { fake, runs, holdDownloads: (until: Promise<void>) => { hold = until; } };
}

const byUrl = (answers: Record<string, unknown>): Metadata => (args) => answers[args.at(-1)!] ?? new Error("[generic] x: Unsupported URL: nope");

function service(metadata: Metadata, extra: Partial<ConstructorParameters<typeof MediaDownloadService>[0]> = {}) {
  const made = downloader(metadata);
  const writes: string[] = [];
  const startWrite = vi.fn((dir: string) => { writes.push(dir); return () => { writes.splice(writes.indexOf(dir), 1); }; });
  const media = new MediaDownloadService({ downloader: () => made.fake, probe, resolve: PUBLIC, startWrite, networkRetryMs: 0, ...extra });
  return { media, ...made, startWrite, writes };
}

const request = (url: string, more: Partial<MediaDownloadRequest> = {}): MediaDownloadRequest => ({ id: `job-${Math.random().toString(36).slice(2)}`, dir: project, url, kind: "audio", maxHeight: 1080, ...more });
const signal = () => new AbortController().signal;
const YT = "https://www.youtube.com/watch?v=AbCdEfGhIj0";
const SC = "https://soundcloud.com/neon-coast/night-drive";
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);
const workFolders = () => (existsSync(join(project, ".cutroom", "downloads")) ? readdirSync(join(project, ".cutroom", "downloads")) : []);

beforeEach(() => {
  probed.clear();
  probe.mockClear();
});

describe("media_download through the downloader", () => {
  it("saves a YouTube video's AAC sound as music/<id>.m4a and credits it once imported", async () => {
    const { media, runs } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    const job = request(`${YT}&t=10s`);
    const download = await media.download({ ...job, url: YT }, signal());
    expect(runs[0]).toEqual(["--use-extractors", "default,-generic", "--no-playlist", "--flat-playlist", "--playlist-end", "101", "-f", AUDIO_FORMAT, "-J", "--skip-download", YT]);
    expect(runs[1]).toEqual(expect.arrayContaining(["--load-info-json", "-x", "--max-filesize", String(1024 ** 3), "--print", "after_move:filepath", "-o", "%(id)s.%(ext)s"]));
    expect(runs[1]).not.toContain("--audio-format");
    expect(download).toMatchObject({
      source: "assets/music/AbCdEfGhIj0.m4a", folder: "music", path: join(project, "assets", "music", "AbCdEfGhIj0.m4a"), mediaId: "AbCdEfGhIj0", site: "youtube", kind: "audio",
      title: "Rain on the Window (Instrumental)", channel: "Quiet Rooms", uploadDate: "2024-01-01", durationSeconds: 187, audioCodec: "aac", hasAudio: true,
      mimeType: "audio/mp4", sourceUrl: YT, reused: false, reencoded: false, downloader: "yt-dlp 2026.10.26", creditsFile: join(project, "CREDITS.md"), warnings: [],
    });
    expect(download).not.toHaveProperty("videoCodec");
    expect(workFolders()).toEqual([]);

    await media.commit({ id: download.id, assetId: "asset-1", src: "music/AbCdEfGhIj0.m4a", source: download.source! });
    const [item] = (await readLedger(project)).items as MediaLedgerItem[];
    expect(item).toMatchObject({
      file: "assets/music/AbCdEfGhIj0.m4a", assetId: "asset-1", kind: "audio", fileUrl: YT, pageUrl: YT, license: { code: "unknown", verified: false },
      platform: { site: "youtube", id: "AbCdEfGhIj0", kind: "audio", pageUrl: YT, audioCodec: "aac", formats: ["140"], downloader: "yt-dlp 2026.10.26" },
    });
    const credits = readFileSync(join(project, "CREDITS.md"), "utf8");
    expect(credits).toContain(`Credit: "Rain on the Window (Instrumental)" by Quiet Rooms on YouTube (${YT})`);
    expect(credits).toContain("not verified. Confirm the rights before publishing.");
  });

  it("keeps SoundCloud's MP3 as it is, named after the track", async () => {
    const { media } = service(byUrl({ [SC]: SOUNDCLOUD_TRACK_INFO }));
    const download = await media.download(request(SC), signal());
    expect(download).toMatchObject({ source: "assets/music/1001.mp3", site: "soundcloud", audioCodec: "mp3", mimeType: "audio/mpeg", reencoded: false, channel: "Neon Coast" });
  });

  it("downloads picture and sound as MP4 up to maxHeight into footage/", async () => {
    const { media, runs } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO_VIDEO }));
    const download = await media.download(request(YT, { kind: "video", maxHeight: 720 }), signal());
    // The same choice for the metadata and the download: the picture's shorter side capped, H.264 then HEVC at a size, AAC first.
    for (const run of runs) expect(run).toEqual(expect.arrayContaining(formatArgs("video", 720)));
    expect(formatArgs("video", 720)).toEqual(["-f", VIDEO_FORMAT, "-S", "res:720,+vcodec:avc,+acodec:m4a"]);
    expect(formatArgs("audio", 720)).toEqual(["-f", AUDIO_FORMAT]);
    expect(videoSort(1080)).toBe("res:1080,+vcodec:avc,+acodec:m4a");
    expect(runs[1]).toEqual(expect.arrayContaining(["--merge-output-format", "mp4", "--remux-video", "mp4", "--max-filesize", String(4 * 1024 ** 3)]));
    expect(download).toMatchObject({ source: "assets/footage/AbCdEfGhIj0.mp4", kind: "video", width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac", hasAudio: true, mimeType: "video/mp4" });
  });

  it("finds an upload saved before by the link's id, without the network", async () => {
    const { media, fake } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    const first = await media.download(request(YT), signal());
    await media.commit({ id: first.id, assetId: "a", src: "music/AbCdEfGhIj0.m4a", source: first.source! });
    fake.run.mockClear();
    fake.ensure.mockClear();
    const again = await media.download(request("https://youtu.be/AbCdEfGhIj0?si=x", { folder: "sfx" }), signal());
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.ensure).not.toHaveBeenCalled();
    expect(again).toMatchObject({ source: first.source, reused: true, title: first.title, channel: "Quiet Rooms", sha256: first.sha256, requestedUrl: "https://youtu.be/AbCdEfGhIj0?si=x" });
    // A reused file is recorded once.
    await media.commit({ id: again.id, assetId: "a", src: "music/AbCdEfGhIj0.m4a", source: again.source! });
    expect((await readLedger(project)).items).toHaveLength(1);
  });

  it("reuses a saved upload offline, and calls a site it can't resolve the network's fault, not the link's", async () => {
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    const first = await media.download(request(YT), signal());
    await media.commit({ id: first.id, assetId: "a", src: "music/AbCdEfGhIj0.m4a", source: first.source! });

    const offline = vi.fn(async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND www.youtube.com"), { code: "ENOTFOUND" }); });
    const later = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }), { resolve: offline });
    expect(await later.media.download(request(YT), signal())).toMatchObject({ reused: true, source: first.source });
    expect(offline).not.toHaveBeenCalled();

    const error = await later.media.download(request("https://www.youtube.com/watch?v=ZyXwVuTsRq9"), signal()).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "invalid-input", message: "Couldn't reach YouTube (ENOTFOUND). Check the internet connection, then try once more." });
    expect(later.fake.run).not.toHaveBeenCalled();
  });

  it("downloads a taller video than the one saved, and reuses a taller one for a lower cap, saying so", async () => {
    const { media, runs } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO_VIDEO }));
    probed.set("AbCdEfGhIj0.mp4", { durationSeconds: 187, video: { codec: "h264", width: 640, height: 360 }, audio: { codec: "aac" } });
    const small = await media.download(request(YT, { kind: "video", maxHeight: 360 }), signal());
    await media.commit({ id: small.id, assetId: "s", src: "footage/AbCdEfGhIj0.mp4", source: small.source! });
    expect((await readLedger(project)).items[0]).toMatchObject({ platform: { maxHeight: 360 } });

    probed.clear();
    const tall = await media.download(request(YT, { kind: "video", maxHeight: 1080 }), signal());
    expect(tall).toMatchObject({ reused: false, source: "assets/footage/AbCdEfGhIj0-2.mp4", height: 720 });
    await media.commit({ id: tall.id, assetId: "t", src: "footage/AbCdEfGhIj0-2.mp4", source: tall.source! });

    runs.length = 0;
    const lower = await media.download(request(YT, { kind: "video", maxHeight: 480 }), signal());
    expect(runs).toEqual([]);
    expect(lower).toMatchObject({ reused: true, source: tall.source });
    expect(lower.warnings).toEqual(["This video was in the project already at 720p, larger than the 480p asked for; that file was reused rather than downloading a smaller one."]);
    expect(await media.download(request(YT, { kind: "video", maxHeight: 360 }), signal())).toMatchObject({ reused: true, source: small.source, warnings: [] });
  });

  it("after updating for a failed download, reads the page again with the new downloader before retrying", async () => {
    let reads = 0;
    const { media, fake, runs } = service(() => ({ ...YOUTUBE_VIDEO_INFO, format_id: `140-read${++reads}` }));
    fake.update.mockResolvedValueOnce({ version: "2026.11.01", changed: true });
    const original = fake.run.getMockImplementation()!;
    const loaded: string[] = [];
    fake.run.mockImplementation(async (args, opts) => {
      const at = args.indexOf("--load-info-json");
      if (at >= 0) {
        loaded.push((JSON.parse(readFileSync(args[at + 1]!, "utf8")) as { format_id: string }).format_id);
        if (loaded.length === 1) {
          runs.push(args);
          return { code: 1, signal: null, stdout: "", stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" };
        }
      }
      return original(args, opts);
    });
    const download = await media.download(request(YT), signal());
    expect(fake.update).toHaveBeenCalledOnce();
    expect(runs.map((args) => (args.includes("--load-info-json") ? "download" : "metadata"))).toEqual(["metadata", "download", "metadata", "download"]);
    expect(loaded).toEqual(["140-read1", "140-read2"]);
    expect(download).toMatchObject({ reused: false, downloader: "yt-dlp 2026.11.01", warnings: ["The downloader was updated to yt-dlp 2026.11.01 to read this page."] });
    await media.commit({ id: download.id, assetId: "a", src: "music/AbCdEfGhIj0.m4a", source: download.source! });
    expect((await readLedger(project)).items[0]).toMatchObject({ platform: { formats: ["140-read2"] } });
  });

  it("calls a clean exit without a file what it is, a file over the size cap, rather than asking for a retry", async () => {
    const { media, fake } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    const original = fake.run.getMockImplementation()!;
    // `--print` makes the downloader quiet, so the skip says nothing at all.
    fake.run.mockImplementation(async (args, opts) => (args.includes("--load-info-json") ? { code: 0, signal: null, stdout: "", stderr: "" } : original(args, opts)));
    const error = await media.download(request(YT), signal()).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "invalid-input", message: "The downloader skipped this audio: it is larger than the 1.0 GB media_download takes for audio. Choose a shorter source." });
    expect(workFolders()).toEqual([]);
  });

  it("counts a list only up to one past the last item it can choose", async () => {
    const many = {
      _type: "playlist",
      entries: Array.from({ length: 101 }, (_, n) => ({ _type: "url", ie_key: "Youtube", id: `V${String(n).padStart(10, "0")}`, url: `https://www.youtube.com/watch?v=V${String(n).padStart(10, "0")}` })),
    };
    const { media, runs } = service(() => many);
    const error = await media.download(request("https://www.youtube.com/@someone/videos"), signal()).catch((thrown: DapiError) => thrown);
    expect(runs[0]).toEqual(expect.arrayContaining(["--flat-playlist", "--playlist-end", "101"]));
    expect(error).toMatchObject({ code: "invalid-input", message: "This link holds more than 100 uploads. Pass the upload's own link, or `item` (1-100) for one of the first 100." });
  });

  it("adopts a file named after the upload that no record claims, after reading its metadata", async () => {
    mkdirSync(join(project, "assets", "music"), { recursive: true });
    writeFileSync(join(project, "assets", "music", "AbCdEfGhIj0.m4a"), stub("m4a", "copied in by hand"));
    const { media, runs } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    const download = await media.download(request(YT), signal());
    expect(runs).toHaveLength(1);
    expect(download).toMatchObject({ source: "assets/music/AbCdEfGhIj0.m4a", reused: true, title: "Rain on the Window (Instrumental)" });
    await media.commit({ id: download.id, assetId: "a", src: "music/AbCdEfGhIj0.m4a", source: download.source! });
    expect((await readLedger(project)).items[0]).toMatchObject({ file: "assets/music/AbCdEfGhIj0.m4a", title: "Rain on the Window (Instrumental)" });
  });

  it("names around a different file: <id>-<site> when it came from another site, else -2", async () => {
    mkdirSync(join(project, "assets", "music"), { recursive: true });
    writeFileSync(join(project, "assets", "music", "1001.mp3"), stub("mp3", "junk"));
    const first = service(byUrl({ [SC]: SOUNDCLOUD_TRACK_INFO }));
    expect((await first.media.download(request(SC), signal())).source).toBe("assets/music/1001-2.mp3");

    rmSync(join(project, "assets", "music", "1001-2.mp3"));
    mkdirSync(join(project, ".cutroom"), { recursive: true });
    const other: MediaLedgerItem = {
      file: "assets/music/1001.mp3", sha256: "0".repeat(64), bytes: 1, kind: "audio", mimeType: "audio/mpeg", fileUrl: "https://vimeo.com/1001", requestedUrl: "https://vimeo.com/1001",
      license: { code: "unknown", name: "Unknown", attributionRequired: true, shareAlike: false, commercialUse: false, modificationsAllowed: false, verified: false }, downloadedAt: "2026-01-01T00:00:00.000Z",
      platform: { site: "vimeo", id: "1001", kind: "audio", pageUrl: "https://vimeo.com/1001", downloader: "yt-dlp x" },
    };
    writeFileSync(join(project, ".cutroom", "web-media.json"), JSON.stringify({ version: 1, items: [other] }));
    const second = service(byUrl({ [SC]: SOUNDCLOUD_TRACK_INFO }));
    expect((await second.media.download(request(SC), signal())).source).toBe("assets/music/1001-soundcloud.mp3");
  });

  it("asks which upload of a post that holds several, and takes the one asked for", async () => {
    const post = "https://www.instagram.com/p/CaRoUsEl123/";
    const { media, runs } = service((args) => {
      const at = args.indexOf("--playlist-items");
      if (at < 0) return INSTAGRAM_CAROUSEL;
      return { ...INSTAGRAM_CAROUSEL, entries: [INSTAGRAM_CAROUSEL.entries[Number(args[at + 1]) - 1]] };
    });
    const error = await media.download(request(post, { kind: "video" }), signal()).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "invalid-input" });
    expect((error as Error).message).toBe("This link holds 3 uploads. Pass `item` (1-3) to choose one, or pass the upload's own link.");

    const download = await media.download(request(post, { kind: "video", item: 2 }), signal());
    expect(runs.at(-2)).toEqual(expect.arrayContaining(["--playlist-items", "2"]));
    expect(runs.at(-2)).not.toContain("--flat-playlist");
    expect(download).toMatchObject({ source: "assets/footage/3100000000000000002.mp4", site: "instagram", channel: "someone", sourceUrl: post });
  });

  it.each([
    ["a live stream", LIVE_INFO, "audio", /live stream\. Download it once the stream has ended/],
    ["an upcoming stream", UPCOMING_INFO, "audio", /hasn't started yet/],
    ["seven hours of video", LONG_INFO, "video", /runs 7 h 00 min, longer than the 3 h 00 min .*kind: "audio"/],
    ["seven hours of sound", LONG_INFO, "audio", /runs 7 h 00 min, longer than the 6 h 00 min/],
    ["five gigabytes of video", HUGE_INFO, "video", /about 5\.0 GB, more than the 4\.0 GB .*lower `maxHeight`/],
  ] as const)("refuses %s before downloading", async (_what, info, kind, message) => {
    const { media, runs } = service(() => info);
    const error = (await media.download(request(YT, { kind }), signal()).catch((thrown: Error) => thrown)) as Error;
    expect(error.message).toMatch(message);
    expect(runs).toHaveLength(1);
    expect(workFolders()).toEqual([]);
  });

  it("refuses a picture the editor can't play, and a download without the sound asked for", async () => {
    probed.set("AbCdEfGhIj0.mp4", { durationSeconds: 10, video: { codec: "mpeg4" }, audio: { codec: "aac" } });
    const video = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO_VIDEO }));
    await expect(video.media.download(request(YT, { kind: "video" }), signal())).rejects.toThrow(/No picture the editor can play came with this video \(mpeg4 with aac\)/);
    probed.set("AbCdEfGhIj0.m4a", { durationSeconds: 10, video: { codec: "h264" } });
    const audio = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    await expect(audio.media.download(request(YT), signal())).rejects.toThrow(/has no sound/);
    expect(existsSync(join(project, "assets", "music", "AbCdEfGhIj0.m4a"))).toBe(false);
  });

  it("warns about a silent video and keeps it", async () => {
    probed.set("AbCdEfGhIj0.mp4", { durationSeconds: 10, video: { codec: "hevc", width: 1080, height: 1920 } });
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO_VIDEO }));
    const download = await media.download(request(YT, { kind: "video" }), signal());
    expect(download).toMatchObject({ hasAudio: false, videoCodec: "hevc", warnings: ["This video has no sound."] });
    expect(download).not.toHaveProperty("audioCodec");
  });

  it("caps a video by its picture's shorter side, and says so when nothing that small was offered", async () => {
    probed.set("AbCdEfGhIj0.mp4", { durationSeconds: 30, video: { codec: "h264", width: 1080, height: 1920 }, audio: { codec: "aac" } });
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO_VIDEO }));
    // A vertical 1080x1920 is within a 1080 cap.
    const vertical = await media.download(request(YT, { kind: "video", maxHeight: 1080 }), signal());
    expect(vertical).toMatchObject({ width: 1080, height: 1920, warnings: [] });
    await media.discard(vertical.id);

    probed.set("AbCdEfGhIj0.mp4", { durationSeconds: 30, video: { codec: "h264", width: 720, height: 1280 }, audio: { codec: "aac" } });
    const small = await media.download(request(YT, { kind: "video", maxHeight: 360 }), signal());
    expect(small.warnings).toEqual(["Nothing at or under 360p was offered, so the smallest picture there was, 720x1280, was taken."]);
    await media.commit({ id: small.id, assetId: "s", src: "footage/AbCdEfGhIj0.mp4", source: small.source! });
    // Recorded as answering every cap up to its shorter side: no download under them would be smaller.
    expect((await readLedger(project)).items[0]).toMatchObject({ platform: { maxHeight: 720 } });
    expect(await media.download(request(YT, { kind: "video", maxHeight: 720 }), signal())).toMatchObject({ reused: true, source: small.source, warnings: [] });
    expect((await media.download(request(YT, { kind: "video", maxHeight: 480 }), signal())).warnings).toEqual([
      "This video was in the project already at 720p, larger than the 480p asked for; that file was reused rather than downloading a smaller one.",
    ]);
  });

  it("sends images and web_media_search results to web_media_download", async () => {
    const { media, fake } = service(byUrl({}), { isWebResult: (url) => url === "https://upload.wikimedia.org/a.ogg" });
    await expect(media.download(request("https://example.com/photo.jpg"), signal())).rejects.toThrow(/web_media_download/);
    await expect(media.download(request("https://upload.wikimedia.org/a.ogg"), signal())).rejects.toThrow(/web_media_download/);
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("refuses a MyInstants link that isn't a sound page, a malformed one included, with what to pass instead", async () => {
    const { media, fake } = service(byUrl({}));
    for (const url of ["https://www.myinstants.com/en/instant/%zz/", "https://www.myinstants.com/en/index/us/"]) {
      const error = await media.download(request(url), signal()).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(DapiError);
      expect(error).toMatchObject({ code: "invalid-input", message: expect.stringMatching(/^That isn't a MyInstants sound page .*media_search/) });
    }
    // The site's own MP3 link is a file, which web_media_download takes.
    const file = await media.download(request("https://www.myinstants.com/media/sounds/vine-boom.mp3"), signal()).catch((thrown: unknown) => thrown);
    expect(file).toMatchObject({ code: "invalid-input", message: expect.stringMatching(/^That is a MyInstants sound file, not its page\. Download the file with web_media_download/) });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("refuses private hosts before running anything", async () => {
    const { media, fake } = service(byUrl({}));
    await expect(media.download(request("http://127.0.0.1/video.mp4"), signal())).rejects.toThrow(/private network/);
    await expect(media.download(request("http://router.local/video.mp4"), signal())).rejects.toThrow(/private network/);
    expect(fake.run).not.toHaveBeenCalled();
  });
});

describe("media_download's folders", () => {
  it.each(["../outside", ".hidden", "music/.git", "music//x", "a/b/c/d/e", "music/", "x".repeat(42), "sfx\\..\\x"])("refuses the library folder %j", async (folder) => {
    const { media, fake } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    const error = await media.download(request(YT, { folder }), signal()).catch((thrown: DapiError) => thrown);
    if (folder === "music/") {
      // A trailing slash is the same folder.
      expect(error).toMatchObject({ source: "assets/music/AbCdEfGhIj0.m4a" });
      return;
    }
    expect(error).toMatchObject({ code: "invalid-input" });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("takes nested library folders and an absolute folder inside the project's assets", async () => {
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO, [SC]: SOUNDCLOUD_TRACK_INFO }));
    expect((await media.download(request(YT, { folder: "b-roll/city night" }), signal())).source).toBe("assets/b-roll/city night/AbCdEfGhIj0.m4a");
    expect((await media.download(request(SC, { folder: join(project, "assets", "sfx") }), signal())).source).toBe("assets/sfx/1001.mp3");
    await expect(media.download(request(SC, { folder: join(root, "elsewhere") }), signal())).rejects.toThrow(/With a project open, `folder` is a library folder/);
  });

  it("refuses an assets folder that leads out of the project", async () => {
    const outside = mkdtempSync(join(root, "outside-"));
    mkdirSync(join(project, "assets"));
    symlinkSync(outside, join(project, "assets", "music"));
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    await expect(media.download(request(YT), signal())).rejects.toThrow(/assets\/music folder leads outside the project/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses an assets folder that leads into a protected folder of the project", async () => {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, "assets"));
    symlinkSync("../.git", join(project, "assets", "music"));
    const { media, fake } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    await expect(media.download(request(YT), signal())).rejects.toThrow(
      "The project's assets/music folder leads into .git, which Blackout keeps off-limits to editing sessions. Remove that link and try again.",
    );
    expect(fake.run).not.toHaveBeenCalled();
    expect(readdirSync(join(project, ".git"))).toEqual([]);
  });

  it("saves into an absolute folder with no project open, recording nothing", async () => {
    const folder = join(root, "no-project", "Music");
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    await expect(media.download(request(YT, { dir: null }), signal())).rejects.toMatchObject({ code: "no-project" });
    await expect(media.download(request(YT, { dir: null, folder: "music" }), signal())).rejects.toMatchObject({ code: "no-project" });
    const download = await media.download(request(YT, { dir: null, folder }), signal());
    expect(download).toMatchObject({ source: null, folder: null, path: join(folder, "AbCdEfGhIj0.m4a"), creditsFile: null, reused: false });
    expect(readdirSync(folder)).toEqual(["AbCdEfGhIj0.m4a"]);
    const again = await media.download(request(YT, { dir: null, folder }), signal());
    expect(again).toMatchObject({ path: join(folder, "AbCdEfGhIj0.m4a"), reused: true });
  });
});

describe("media_download's lifecycle", () => {
  it("stops a download into a project being saved, cleaning up before the save goes on", async () => {
    const { media, holdDownloads, writes } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    let release!: () => void;
    holdDownloads(new Promise((settle) => { release = settle; }));
    const pending = media.download(request(YT), signal()).catch((thrown: DapiError) => thrown);
    await vi.waitFor(() => expect(workFolders()).toHaveLength(1));
    // The app's temp prefix: the watcher ignores it, and a duplicate of the project leaves it out without stopping the download.
    expect(workFolders().every((name) => isTempPath(name) && name.includes("media-job-"))).toBe(true);
    media.cancelDownloads(project);
    expect(writes).toEqual([project]);
    release();
    const error = await pending;
    expect(error).toMatchObject({ code: "no-project" });
    expect((error as Error).message).toMatch(/saved or moved during the download/);
    expect(workFolders()).toEqual([]);
    expect(writes).toEqual([]);
    expect(existsSync(join(project, "assets", "music", "AbCdEfGhIj0.m4a"))).toBe(false);
  });

  it("runs one download per upload at a time; the second asks reuse the first's file", async () => {
    const { media, fake } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO, "https://youtu.be/AbCdEfGhIj0": YOUTUBE_VIDEO_INFO }));
    const [one, two] = await Promise.all([media.download(request(YT), signal()), media.download(request("https://youtu.be/AbCdEfGhIj0"), signal())]);
    expect(fake.run.mock.calls.filter(([args]) => args.includes("--load-info-json"))).toHaveLength(1);
    expect(one.reused).toBe(false);
    expect(two).toMatchObject({ reused: true, source: one.source });
  });

  it("takes a file the renderer couldn't import back out, but never one it reused", async () => {
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    const download = await media.download(request(YT), signal());
    await media.discard(download.id);
    expect(existsSync(download.path)).toBe(false);
    await expect(media.discard(download.id)).rejects.toThrow(/no longer pending/);

    const kept = await media.download(request(YT), signal());
    await media.commit({ id: kept.id, assetId: "a", src: "music/x", source: kept.source! });
    const reused = await media.download(request(YT), signal());
    await media.discard(reused.id);
    expect(existsSync(kept.path)).toBe(true);
  });

  it("refuses a .cutroom/downloads that is a link before fetching anything, leaving where it leads alone", async () => {
    const elsewhere = mkdtempSync(join(root, "elsewhere-"));
    writeFileSync(join(elsewhere, "old-file.txt"), "keep");
    mkdirSync(join(elsewhere, `${TEMP_PREFIX}media-old`));
    for (const name of readdirSync(elsewhere)) utimesSync(join(elsewhere, name), hoursAgo(3), hoursAgo(3));
    mkdirSync(join(project, ".cutroom"));
    symlinkSync(elsewhere, join(project, ".cutroom", "downloads"));
    const { media, fake } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    await expect(media.download(request(YT), signal())).rejects.toThrow("The project's .cutroom/downloads folder must be a real folder.");
    expect(fake.run).not.toHaveBeenCalled();
    expect(readdirSync(elsewhere).sort()).toEqual([`${TEMP_PREFIX}media-old`, "old-file.txt"].sort());
  });

  it("clears only the work folders a crash left behind, never a link or anything else there", async () => {
    const downloads = join(project, ".cutroom", "downloads");
    const elsewhere = mkdtempSync(join(root, "elsewhere-"));
    writeFileSync(join(elsewhere, "precious.txt"), "keep");
    mkdirSync(join(downloads, `${TEMP_PREFIX}media-crashed`), { recursive: true });
    writeFileSync(join(downloads, `${TEMP_PREFIX}media-crashed`, "part"), "x");
    mkdirSync(join(downloads, `${TEMP_PREFIX}media-recent`));
    mkdirSync(join(downloads, "not-ours"));
    symlinkSync(elsewhere, join(downloads, `${TEMP_PREFIX}media-link`));
    for (const name of [`${TEMP_PREFIX}media-crashed`, "not-ours"]) utimesSync(join(downloads, name), hoursAgo(3), hoursAgo(3));
    lutimesSync(join(downloads, `${TEMP_PREFIX}media-link`), hoursAgo(3), hoursAgo(3));
    const { media } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    await media.download(request(YT), signal());
    expect(workFolders().sort()).toEqual([`${TEMP_PREFIX}media-link`, `${TEMP_PREFIX}media-recent`, "not-ours"].sort());
    expect(readdirSync(elsewhere)).toEqual(["precious.txt"]);
  });

  it("removes every work folder on quit", async () => {
    const { media, holdDownloads } = service(byUrl({ [YT]: YOUTUBE_VIDEO_INFO }));
    holdDownloads(new Promise(() => {}));
    void media.download(request(YT), signal()).catch(() => {});
    await vi.waitFor(() => expect(workFolders()).toHaveLength(1));
    media.dispose();
    expect(workFolders()).toEqual([]);
  });
});

describe("media_download from MyInstants and the user's own Instagram", () => {
  const PAGE = "https://www.myinstants.com/en/instant/boing-spring-123/";
  const mp3 = () => new Response(stub("mp3", "boing"), { status: 200, headers: { "content-type": "audio/mpeg" } });

  it("reads a MyInstants page with the page fetch and saves sfx/<slug>.mp3, reusing it after", async () => {
    const pageFetch = vi.fn(async (url: string) => (url.endsWith(".mp3") ? mp3() : new Response(MYINSTANTS_PAGE, { status: 200 })));
    const { media, fake } = service(byUrl({}), { pageFetch });
    const download = await media.download(request(PAGE, { kind: "video" }), signal());
    expect(fake.run).not.toHaveBeenCalled();
    expect(pageFetch.mock.calls.map(([url]) => url)).toEqual([PAGE, "https://www.myinstants.com/media/sounds/boing-spring.mp3"]);
    expect(download).toMatchObject({
      source: "assets/sfx/boing-spring-123.mp3", site: "myinstants", mediaId: "boing-spring-123", title: "Boing & Spring", kind: "audio",
      sourceUrl: PAGE, downloader: "Blackout (MyInstants page)", warnings: ["MyInstants only has sounds, so this was saved as audio."],
    });
    await media.commit({ id: download.id, assetId: "s", src: "sfx/boing-spring-123.mp3", source: download.source! });
    pageFetch.mockClear();
    expect(await media.download(request(PAGE), signal())).toMatchObject({ reused: true, source: download.source });
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("refuses a MyInstants sound longer than ten minutes", async () => {
    probed.set("boing-spring-123.mp3", { durationSeconds: 900, audio: { codec: "mp3" } });
    const pageFetch = vi.fn(async (url: string) => (url.endsWith(".mp3") ? mp3() : new Response(MYINSTANTS_PAGE)));
    const { media } = service(byUrl({}), { pageFetch });
    await expect(media.download(request(PAGE), signal())).rejects.toThrow(/longer than the 10 min 00 s a MyInstants sound may run/);
  });

  const CDN = "https://scontent-lhr8-1.cdninstagram.com/o1/v/t16/f2/m69/AQabc.mp4?efg=signed&oh=token";
  const PERMALINK = "https://www.instagram.com/reel/OwnReel123/";
  const snapshot = { account: { username: "me.myself" }, posts: [{ id: "17900000000000001", caption: "Sunset run. More soon", permalink: PERMALINK, mediaUrl: CDN }] };
  const mp4 = () => new Response(stub("mp4", "own reel"), { status: 200, headers: { "content-type": "video/mp4" } });

  it("fetches the user's own Instagram file directly, named after the post, credited to its permalink", async () => {
    const fetch = vi.fn(async () => mp4());
    const { media, fake } = service(byUrl({}), { fetch, instagramMedia: async (url) => findInstagramMedia(snapshot, url) });
    const download = await media.download(request(CDN, { kind: "video" }), signal());
    expect(fake.run).not.toHaveBeenCalled();
    expect(download).toMatchObject({
      source: "assets/footage/17900000000000001.mp4", site: "instagram", mediaId: "17900000000000001", title: "Sunset run.", channel: "@me.myself",
      sourceUrl: PERMALINK, downloader: "Blackout (Instagram file)",
    });
    await media.commit({ id: download.id, assetId: "v", src: "footage/x.mp4", source: download.source! });
    const [item] = (await readLedger(project)).items;
    expect(item).toMatchObject({ fileUrl: PERMALINK, pageUrl: PERMALINK, requestedUrl: "https://scontent-lhr8-1.cdninstagram.com/o1/v/t16/f2/m69/AQabc.mp4" });
    expect(JSON.stringify(item)).not.toMatch(/oh=token|efg=/);
  });

  it("routes the user's own permalink to the same direct file, and copies the sound out for audio", async () => {
    const fetch = vi.fn(async (_url: string) => mp4());
    const extractAudio = vi.fn(async (_input: string, output: string) => writeFileSync(output, stub("m4a", "own reel sound")));
    const { media, fake } = service(byUrl({}), { fetch, extractAudio, instagramMedia: async (url) => findInstagramMedia(snapshot, url) });
    const download = await media.download(request(`${PERMALINK}?igsh=abc`), signal());
    expect(fake.run).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]![0]).toBe(CDN);
    expect(extractAudio).toHaveBeenCalledOnce();
    expect(download).toMatchObject({ source: "assets/music/17900000000000001.m4a", kind: "audio", audioCodec: "aac" });
  });

  it("finds the user's own post saved before by the post's id, without fetching it again", async () => {
    const fetch = vi.fn(async () => mp4());
    const { media } = service(byUrl({}), { fetch, instagramMedia: async (url) => findInstagramMedia(snapshot, url) });
    const first = await media.download(request(PERMALINK, { kind: "video" }), signal());
    await media.commit({ id: first.id, assetId: "v", src: "footage/17900000000000001.mp4", source: first.source! });
    expect(await media.download(request(PERMALINK, { kind: "video" }), signal())).toMatchObject({ reused: true, source: first.source });
    expect(await media.download(request(CDN, { kind: "video" }), signal())).toMatchObject({ reused: true, source: first.source });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("takes one file of the user's own carousel through the downloader, whose file link is only its first", async () => {
    const album = { account: { username: "me.myself" }, posts: [{ id: "17900000000000009", caption: "", permalink: "https://www.instagram.com/p/CaRoUsEl123/", mediaUrl: CDN, mediaType: "CAROUSEL_ALBUM" }] };
    const fetch = vi.fn(async () => mp4());
    const { media, runs } = service((args) => {
      const at = args.indexOf("--playlist-items");
      return at < 0 ? INSTAGRAM_CAROUSEL : { ...INSTAGRAM_CAROUSEL, entries: [INSTAGRAM_CAROUSEL.entries[Number(args[at + 1]) - 1]] };
    }, { fetch, instagramMedia: async (url) => findInstagramMedia(album, url) });
    const download = await media.download(request("https://www.instagram.com/p/CaRoUsEl123/", { kind: "video", item: 2 }), signal());
    expect(fetch).not.toHaveBeenCalled();
    expect(runs[0]).toEqual(expect.arrayContaining(["--playlist-items", "2"]));
    expect(download).toMatchObject({ source: "assets/footage/3100000000000000002.mp4", downloader: "yt-dlp 2026.10.26" });
    await expect(media.download(request("https://www.instagram.com/p/CaRoUsEl123/", { kind: "video" }), signal())).rejects.toThrow(/holds 3 uploads/);

    // A single post has no second file; a file link is one file whatever `item` says.
    const single = service(byUrl({}), { fetch, instagramMedia: async (url) => findInstagramMedia(snapshot, url) });
    await expect(single.media.download(request(PERMALINK, { kind: "video", item: 2 }), signal())).rejects.toMatchObject({ code: "not-found", message: "This post holds one file, so it has no item 2. Leave `item` out." });
    const file = await single.media.download(request(CDN, { kind: "video", item: 2 }), signal());
    expect(file.warnings).toEqual(["`item` was ignored: a file link is one file. Pass the post's permalink to choose one of several."]);
  });

  // Instagram itself, asked through the connected account: the cache is only as new as the last sync, and its links expire.
  const FRESH_CDN = "https://scontent-lhr8-1.cdninstagram.com/o1/v/t16/f2/m69/AQnew.mp4?efg=signed&oh=newtoken";
  const own = { id: "17900000000000001", permalink: PERMALINK, caption: "Sunset run. More soon", mediaType: "VIDEO", username: "me.myself" };
  /** The cache as a sync from before file links were kept left it. */
  const noLinks = { account: { username: "me.myself" }, posts: [{ id: own.id, caption: own.caption, permalink: PERMALINK, mediaUrl: null }] };
  const cachedFrom = (from: Parameters<typeof findInstagramMedia>[0] = snapshot) => async (url: string) => findInstagramMedia(from, url);
  const instagramReturns = (asked: InstagramFreshPost) => vi.fn(async (_url: string, _signal: AbortSignal): Promise<InstagramFreshPost> => asked);
  const withFile = (mediaUrl: string | null): InstagramFreshPost => ({ kind: "post", post: { ...own, mediaUrl } });
  const expired = () => new Response("URL signature expired", { status: 403 });

  it("asks Instagram for a post's file when the cache holds none, so a stale cache doesn't matter", async () => {
    const fetch = vi.fn(async (_url: string) => mp4());
    const instagramFresh = instagramReturns(withFile(FRESH_CDN));
    const { media, fake } = service(byUrl({}), { fetch, instagramMedia: cachedFrom(noLinks), instagramFresh });
    const download = await media.download(request(PERMALINK, { kind: "video" }), signal());
    expect(instagramFresh).toHaveBeenCalledWith(PERMALINK, expect.any(AbortSignal));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([FRESH_CDN]);
    expect(fake.run).not.toHaveBeenCalled();
    expect(download).toMatchObject({
      source: "assets/footage/17900000000000001.mp4", site: "instagram", channel: "@me.myself", sourceUrl: PERMALINK, downloader: "Blackout (Instagram file)",
    });
  });

  it("finds a post newer than the last sync through Instagram too", async () => {
    const fetch = vi.fn(async (_url: string) => mp4());
    const { media } = service(byUrl({}), { fetch, instagramMedia: async () => null, instagramFresh: instagramReturns(withFile(FRESH_CDN)) });
    const download = await media.download(request(PERMALINK, { kind: "video" }), signal());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([FRESH_CDN]);
    expect(download).toMatchObject({ source: "assets/footage/17900000000000001.mp4", sourceUrl: PERMALINK });
  });

  it("takes a post's /p/ and /reel/ links as one post", async () => {
    const fetch = vi.fn(async (_url: string) => mp4());
    const { media, fake } = service(byUrl({}), { fetch, instagramMedia: cachedFrom() });
    await media.download(request("https://www.instagram.com/p/OwnReel123/?igsh=abc", { kind: "video" }), signal());
    expect(fake.run).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]![0]).toBe(CDN);
  });

  it("fetches a file link passed in as it is, asking Instagram for nothing while it works", async () => {
    const instagramFresh = instagramReturns(withFile(FRESH_CDN));
    const { media } = service(byUrl({}), { fetch: vi.fn(async (_url: string) => mp4()), instagramMedia: async () => null, instagramFresh });
    await media.download(request(CDN, { kind: "video" }), signal());
    expect(instagramFresh).not.toHaveBeenCalled();
  });

  it("replaces an expired file link with a current one from Instagram, once, whether cached or passed in", async () => {
    for (const link of [PERMALINK, CDN]) {
      const fetch = vi.fn(async (url: string) => (url === FRESH_CDN ? mp4() : expired()));
      const instagramFresh = instagramReturns(withFile(FRESH_CDN));
      const { media } = service(byUrl({}), { fetch, instagramMedia: cachedFrom(), instagramFresh });
      const download = await media.download(request(link, { kind: "video" }), signal());
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([CDN, FRESH_CDN]);
      expect(instagramFresh).toHaveBeenCalledOnce();
      expect(instagramFresh).toHaveBeenCalledWith(link, expect.any(AbortSignal));
      expect(download).toMatchObject({ source: "assets/footage/17900000000000001.mp4", sourceUrl: PERMALINK });
      project = mkdtempSync(join(root, "project-"));
      writeFileSync(join(project, "package.json"), JSON.stringify({ name: "p", projectId: "p" }));
    }
  });

  it("doesn't ask twice: a current link Instagram's servers refuse too is reported as that", async () => {
    const fetch = vi.fn(async (_url: string) => expired());
    const instagramFresh = instagramReturns(withFile(FRESH_CDN));
    const { media } = service(byUrl({}), { fetch, instagramMedia: cachedFrom(), instagramFresh });
    const error = await media.download(request(PERMALINK, { kind: "video" }), signal()).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "not-found" });
    expect((error as Error).message).toMatch(/refused the file's current link \(403\)/);
    expect(instagramFresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Instagram can't be asked", { kind: "failed", reason: "Instagram is limiting requests. Wait a while, then try again." } as const, /expired \(403\)\. A current one couldn't be had: Instagram is limiting requests\. Wait a while, then try again\./],
    ["Instagram gives the post no file", withFile(null), /expired \(403\)\. Instagram gives apps no file for this post of the user's/],
    ["the link isn't one of the account's posts", { kind: "none" } as const, /expired \(403\)\. It isn't one of the connected account's posts/],
  ])("says why an expired file link couldn't be replaced when %s", async (_name, asked, message) => {
    const { media } = service(byUrl({}), { fetch: vi.fn(async (_url: string) => expired()), instagramMedia: cachedFrom(), instagramFresh: instagramReturns(asked) });
    const error = await media.download(request(CDN, { kind: "video" }), signal()).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "not-found" });
    expect((error as Error).message).toMatch(message);
  });

  it("says to try again, not to call instagram_posts, when Instagram's file server sends an empty file", async () => {
    const empty = vi.fn(async (_url: string) => new Response("", { status: 200, headers: { "content-type": "video/mp4" } }));
    const { media } = service(byUrl({}), { fetch: empty, instagramMedia: cachedFrom() });
    await expect(media.download(request(CDN, { kind: "video" }), signal())).rejects.toMatchObject({ code: "invalid-input", message: "Instagram sent an empty file. Try once more in a moment." });
  });

  it("tries the downloader for a post of the user's that Instagram gives no file for, and says why when that fails too", async () => {
    const { media, fake } = service(byUrl({}), { fetch: vi.fn(), instagramMedia: cachedFrom(noLinks), instagramFresh: instagramReturns(withFile(null)) });
    const error = await media.download(request(PERMALINK, { kind: "video" }), signal()).catch((thrown: DapiError) => thrown);
    expect(fake.run).toHaveBeenCalled();
    expect(error).toBeInstanceOf(DapiError);
    expect((error as Error).message).toMatch(/^Instagram gives apps no file for this post of the user's .*Ask the user for the original export.* \(The downloader said: .*\)$/s);
  });

  it("stops as a cancellation, not as an Instagram failure, when canceled while Instagram is being asked", async () => {
    const controller = new AbortController();
    const instagramFresh = vi.fn(async (): Promise<InstagramFreshPost> => {
      controller.abort();
      return { kind: "failed", reason: "Couldn't reach Instagram. Check the internet connection, then try again." };
    });
    const { media, fake } = service(byUrl({}), { fetch: vi.fn(), instagramMedia: cachedFrom(noLinks), instagramFresh });
    const error = await media.download(request(PERMALINK, { kind: "video" }), controller.signal).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "canceled" });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("reports why Instagram couldn't be asked about a post the cache knows as the user's, without trying the downloader", async () => {
    const reason = "Instagram authorization has expired or is invalid. Reconnect your account in Analytics, then try again.";
    const { media, fake } = service(byUrl({}), { fetch: vi.fn(), instagramMedia: cachedFrom(noLinks), instagramFresh: instagramReturns({ kind: "failed", reason }) });
    await expect(media.download(request(PERMALINK, { kind: "video" }), signal())).rejects.toMatchObject({ code: "invalid-input", message: `Couldn't get this post's file from Instagram. ${reason}` });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([
    ["isn't one of the connected account's posts", { kind: "none" } as const],
    ["can't be checked against Instagram", { kind: "failed", reason: "Couldn't reach Instagram. Check the internet connection, then try again." } as const],
  ])("goes to the downloader, as before, for a post that %s", async (_name, asked) => {
    const post = "https://www.instagram.com/p/CaRoUsEl123/";
    const instagramFresh = instagramReturns(asked);
    const { media, runs } = service((args) => {
      const at = args.indexOf("--playlist-items");
      return at < 0 ? INSTAGRAM_CAROUSEL : { ...INSTAGRAM_CAROUSEL, entries: [INSTAGRAM_CAROUSEL.entries[Number(args[at + 1]) - 1]] };
    }, { instagramMedia: async () => null, instagramFresh });
    const download = await media.download(request(post, { kind: "video", item: 2 }), signal());
    expect(instagramFresh).toHaveBeenCalledOnce();
    expect(runs.length).toBeGreaterThan(0);
    expect(download).toMatchObject({ source: "assets/footage/3100000000000000002.mp4", site: "instagram", channel: "someone" });
  });
});

describe("media_download's helpers", () => {
  it("reads ffprobe's report, skipping cover art", () => {
    expect(parseFfprobe(FFPROBE_AAC)).toEqual({ durationSeconds: 187.012, audio: { codec: "aac" } });
    expect(parseFfprobe(FFPROBE_H264)).toEqual({ durationSeconds: 187.02, video: { codec: "h264", width: 1920, height: 1080 }, audio: { codec: "aac" } });
  });

  it("reads ffmpeg's report when there is no ffprobe", () => {
    expect(parseFfmpegInfo(FFMPEG_INFO)).toEqual({ durationSeconds: 187.02, video: { codec: "vp9", width: 1920, height: 1080 }, audio: { codec: "opus" } });
    expect(parseFfmpegInfo("garbage")).toEqual({ durationSeconds: 0 });
  });

  it("estimates the chosen formats' size", () => {
    expect(estimatedBytes(YOUTUBE_VIDEO_INFO)).toBe(3_000_000);
    expect(estimatedBytes(YOUTUBE_VIDEO_INFO_VIDEO)).toBe(43_000_000);
    expect(estimatedBytes({ id: "x" })).toBeNull();
  });

  it("selects one entry and fills it from the post", () => {
    expect(selectEntry(YOUTUBE_VIDEO_INFO, undefined)).toEqual({ entry: YOUTUBE_VIDEO_INFO, complete: true });
    const one = selectEntry({ ...INSTAGRAM_CAROUSEL, entries: [INSTAGRAM_CAROUSEL.entries[0]] }, undefined);
    expect(one.entry).toMatchObject({ id: "3100000000000000001", uploader: "someone", webpage_url: "https://www.instagram.com/p/CaRoUsEl123/" });
    expect(selectEntry({ _type: "playlist", entries: [{ _type: "url", url: "https://x.com/a/status/1", id: "1" }] }, undefined).complete).toBe(false);
    expect(() => selectEntry({ _type: "playlist", entries: [] }, 4)).toThrow(/no item 4/);
  });

  it("writes the credit line", () => {
    expect(platformAttribution({ title: "Night Drive", channel: "Neon Coast", site: "soundcloud", pageUrl: SC })).toBe(`"Night Drive" by Neon Coast on SoundCloud (${SC})`);
    expect(platformAttribution({ title: "Clip", site: "bilibili", pageUrl: "https://b.example/1" })).toBe(`"Clip" on bilibili (https://b.example/1)`);
  });

  it("finds the user's own post by permalink or file, ignoring queries", () => {
    const snapshot = { account: { username: "me" }, posts: [{ id: "1", caption: "", permalink: "https://www.instagram.com/reel/A1/", mediaUrl: "https://scontent.cdninstagram.com/v/a.mp4?x=1", mediaType: "VIDEO" }] };
    expect(findInstagramMedia(snapshot, "https://instagram.com/reel/A1")).toMatchObject({ id: "1", mediaType: "VIDEO" });
    expect(findInstagramMedia(snapshot, "https://scontent.cdninstagram.com/v/a.mp4?x=2")?.id).toBe("1");
    expect(findInstagramMedia(snapshot, "https://www.instagram.com/reel/B2/")).toBeNull();
  });

  it("finds a post by its shortcode whichever form of the link carries it", () => {
    const snapshot = { account: { username: "me" }, posts: [{ id: "1", caption: "", permalink: "https://www.instagram.com/reel/AbCdEfGhIjK/", mediaUrl: null, mediaType: "VIDEO" }] };
    for (const link of [
      "https://www.instagram.com/reel/AbCdEfGhIjK/",
      "https://www.instagram.com/p/AbCdEfGhIjK/",
      "https://instagram.com/reels/AbCdEfGhIjK?igsh=abc",
      "https://www.instagram.com/me/reel/AbCdEfGhIjK/",
    ]) expect(findInstagramMedia(snapshot, link)?.id).toBe("1");
    // Shortcodes are case-sensitive and a different post is a different post.
    expect(findInstagramMedia(snapshot, "https://www.instagram.com/p/abcdefghijK/")).toBeNull();
    expect(findInstagramMedia(snapshot, "https://www.instagram.com/p/AbCdEfGhIjL/")).toBeNull();
  });
});
