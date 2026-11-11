/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Opt-in, against the real network: one YouTube search and one audio
// download through media_search and media_download's own code, with a yt-dlp
// binary named by CUTROOM_MEDIA_LIVE and the FFmpeg tools in
// CUTROOM_MEDIA_FFMPEG_DIR (default /opt/homebrew/bin). Skipped otherwise;
// the unit tests never touch the network. With the same binary, the formats
// media_download asks for are also checked against saved listings, offline.
//
//   CUTROOM_MEDIA_LIVE=/path/to/yt-dlp_macos npx vitest run src/media-live.test.ts

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import { MediaSearchService } from "./media-search";
import { MediaDownloadService, formatArgs, mediaTools } from "./media-download";

import type { MediaDownloader } from "./media-runner";

const binary = process.env.CUTROOM_MEDIA_LIVE ?? "";
const tools = process.env.CUTROOM_MEDIA_FFMPEG_DIR ?? "/opt/homebrew/bin";

/** The probe binary as the managed downloader would run it, with the safe base arguments and Node as the JavaScript runtime. */
function probeDownloader(): MediaDownloader {
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  return {
    status: () => ({ state: "ready", version }),
    ensure: async () => ({ path: binary, version }),
    update: async () => ({ version, changed: false }),
    run: (args, opts) => new Promise((settle) => {
      const child = spawn(binary, ["--ignore-config", "--no-plugin-dirs", "--no-cookies", "--js-runtimes", "node", "--ffmpeg-location", tools, "--socket-timeout", "30", ...args], {
        cwd: opts.cwd ?? tmpdir(), stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const lines = (chunk: string, rest: { value: string }, each?: (line: string) => void) => {
        rest.value += chunk;
        const parts = rest.value.split(/\r?\n/);
        rest.value = parts.pop()!;
        for (const line of parts) each?.(line);
      };
      const out = { value: "" };
      const err = { value: "" };
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; lines(chunk, out, opts.onStdoutLine); });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; lines(chunk, err, opts.onStderrLine); });
      const stop = () => child.kill("SIGTERM");
      opts.signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, opts.timeoutMs ?? 600_000);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", stop);
        settle({ code, signal, stdout, stderr });
      });
    }),
  };
}

describe.skipIf(!binary || !existsSync(binary))("media tools against the live network", () => {
  const root = mkdtempSync(join(tmpdir(), "cutroom-media-live-"));
  const project = join(root, "project");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("searches YouTube, then downloads one result's sound into a project and reuses it", async () => {
    const downloader = probeDownloader();
    const search = new MediaSearchService({ downloader: () => downloader });
    const args = toolByName("media_search").input.parse({ query: "blinding lights instrumental", limit: 3, preview: 1 });
    const found = await search.search(args, new AbortController().signal);
    console.log(JSON.stringify({ ...found, previews: found.previews.map((preview) => ({ index: preview.index, mimeType: preview.mimeType, bytes: preview.bytes.byteLength })) }, null, 2));
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results[0]!.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/);
    expect(toolByName("media_search").output.safeParse({ platform: found.platform, profile: found.profile, results: found.results, warnings: found.warnings }).success).toBe(true);

    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "live", projectId: "live" }));
    const service = new MediaDownloadService({ downloader: () => downloader, ...mediaTools({ ffprobe: join(tools, "ffprobe"), ffmpeg: join(tools, "ffmpeg") }) });
    const url = "https://www.youtube.com/watch?v=XajaJYraODs";
    const request = { id: "live-1", dir: project, url, kind: "audio" as const, maxHeight: 1080 as const };
    const started = Date.now();
    const first = await service.download(request, new AbortController().signal);
    console.log(JSON.stringify({ ...first, seconds: (Date.now() - started) / 1000 }, null, 2));
    expect(first).toMatchObject({ source: "assets/music/XajaJYraODs.m4a", site: "youtube", mediaId: "XajaJYraODs", kind: "audio", audioCodec: "aac", reused: false, reencoded: false });
    expect(first.durationSeconds).toBeGreaterThan(150);
    await service.commit({ id: "live-1", assetId: "a1", src: "music/XajaJYraODs.m4a", source: first.source! });
    const credits = readFileSync(join(project, "CREDITS.md"), "utf8");
    expect(credits).toContain("XajaJYraODs");
    expect(credits).toMatch(/not verified/);

    const again = await service.download({ ...request, id: "live-2" }, new AbortController().signal);
    expect(again).toMatchObject({ source: first.source, reused: true });
    await service.commit({ id: "live-2", assetId: "a1", src: "music/XajaJYraODs.m4a", source: again.source! });
  }, 600_000);

  it("searches YouTube for footage, then downloads one result's picture and sound into a project", async () => {
    const downloader = probeDownloader();
    const search = new MediaSearchService({ downloader: () => downloader });
    const args = toolByName("media_search").input.parse({ query: "Felix Baumgartner Red Bull Stratos jump", limit: 10, preview: 0 });
    const found = await search.search(args, new AbortController().signal);
    // A short result keeps the download small; the choice is the agent's in real use, by title, channel and length.
    const pick = found.results.filter((result) => result.live === "none" && (result.durationSeconds ?? 0) >= 20 && (result.durationSeconds ?? 0) <= 240)
      .sort((a, b) => a.durationSeconds! - b.durationSeconds!)[0];
    console.log(JSON.stringify(found.results.map((result) => ({ index: result.index, title: result.title, channel: result.channel, seconds: result.durationSeconds })), null, 1));
    expect(pick, "a YouTube result between 20 s and 4 min").toBeDefined();

    const video = join(root, "video-project");
    mkdirSync(video, { recursive: true });
    writeFileSync(join(video, "package.json"), JSON.stringify({ name: "live-video", projectId: "live-video" }));
    const service = new MediaDownloadService({ downloader: () => downloader, ...mediaTools({ ffprobe: join(tools, "ffprobe"), ffmpeg: join(tools, "ffmpeg") }) });
    const request = { id: "live-v1", dir: video, url: pick!.url, kind: "video" as const, maxHeight: 720 as const };
    const started = Date.now();
    const first = await service.download(request, new AbortController().signal);
    console.log(JSON.stringify({ ...first, seconds: (Date.now() - started) / 1000 }, null, 2));
    expect(first).toMatchObject({ kind: "video", site: "youtube", reused: false });
    expect(first.source).toMatch(/^assets\/footage\/[\w-]{11}\.\w+$/);
    expect(first.videoCodec).toBeTruthy();
    expect(first.height).toBeGreaterThan(0);
    expect(first.durationSeconds).toBeGreaterThan(10);
    expect(existsSync(first.path)).toBe(true);
    await service.commit({ id: "live-v1", assetId: "v1", src: first.source!.replace(/^assets\//, ""), source: first.source! });
    expect(readFileSync(join(video, "CREDITS.md"), "utf8")).toContain(first.mediaId);

    const again = await service.download({ ...request, id: "live-v2" }, new AbortController().signal);
    expect(again).toMatchObject({ source: first.source, reused: true });
    await service.commit({ id: "live-v2", assetId: "v1", src: first.source!.replace(/^assets\//, ""), source: again.source! });
  }, 900_000);
});

describe.skipIf(!binary || !existsSync(binary))("media_download's format choice, by the real downloader, offline", () => {
  // Format lists shaped as the sites gave them in November 2026, read back with `--load-info-json --simulate`: nothing is fetched.
  const dir = mkdtempSync(join(tmpdir(), "cutroom-media-formats-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  type Format = { format_id: string; ext: string; vcodec: string; acodec: string; width?: number; height?: number; tbr?: number; abr?: number };
  const format = (format_id: string, ext: string, vcodec: string, acodec: string, size?: [number, number], rate?: number): Format => ({
    format_id, ext, vcodec, acodec, ...(size ? { width: size[0], height: size[1] } : {}), ...(rate ? { [vcodec === "none" ? "abr" : "tbr"]: rate } : {}),
  });
  const listing = (id: string, extractor: string, formats: Format[]) => ({
    id, title: id, extractor: extractor.toLowerCase(), extractor_key: extractor, webpage_url: `https://example.invalid/${id}`,
    formats: formats.map((one) => ({ ...one, url: `https://example.invalid/${id}/${one.format_id}`, protocol: "https" })),
  });
  const chosen = (info: { id: string }, args: string[]): string => {
    const path = join(dir, `${info.id}.json`);
    writeFileSync(path, JSON.stringify(info));
    return execFileSync(binary, ["--ignore-config", "--no-plugin-dirs", "--simulate", "--no-warnings", "--load-info-json", path, ...args, "--print", "%(format_id)s"], { encoding: "utf8" }).trim();
  };
  const youtubeAudio = [format("140", "m4a", "none", "mp4a.40.2", undefined, 129), format("251", "webm", "none", "opus", undefined, 135)];
  // A YouTube Short: vertical, so every rendition is taller than it is wide.
  const SHORT = listing("short", "Youtube", [
    ...youtubeAudio,
    format("134", "mp4", "avc1.4d401e", "none", [360, 640], 400), format("135", "mp4", "avc1.4d401f", "none", [480, 854], 700),
    format("136", "mp4", "avc1.64001f", "none", [720, 1280], 1500), format("137", "mp4", "avc1.640028", "none", [1080, 1920], 3000),
    format("248", "webm", "vp9", "none", [1080, 1920], 2500), format("399", "mp4", "av01.0.08M.08", "none", [1080, 1920], 2000),
  ]);
  const LANDSCAPE = listing("landscape", "Youtube", [
    ...youtubeAudio,
    format("136", "mp4", "avc1.64001f", "none", [1280, 720], 1500), format("137", "mp4", "avc1.640028", "none", [1920, 1080], 3000),
    format("248", "webm", "vp9", "none", [1920, 1080], 2500), format("313", "webm", "vp9", "none", [3840, 2160], 9000),
  ]);
  // TikTok names its sound `aac`, not `mp4a`, and offers H.264 and HEVC side by side.
  const TIKTOK = listing("tiktok", "TikTok", [
    format("download", "mp3", "none", "mp3", undefined, 128),
    format("h264_540p_992286-0", "mp4", "h264", "aac", [576, 1024], 992), format("h264_540p_2240963-1", "mp4", "h264", "aac", [576, 1024], 2240),
    format("bytevc1_540p_1297374-1", "mp4", "h265", "aac", [576, 1024], 1297), format("bytevc1_720p_1600000-0", "mp4", "h265", "aac", [720, 1280], 1600),
  ]);
  const AAC_SOUND = listing("sound", "TikTok", [format("aac", "m4a", "none", "aac", undefined, 128), format("opus", "webm", "none", "opus", undefined, 160)]);

  it.each([
    ["a vertical Short at 1080, whole", SHORT, 1080, "137+140"],
    ["a vertical Short at 360", SHORT, 360, "134+140"],
    ["a landscape video at 1080, H.264 at the same size", LANDSCAPE, 1080, "137+140"],
    ["a video with nothing under the cap: the smallest above it", LANDSCAPE, 360, "136+140"],
    ["TikTok at 480: H.264 over HEVC at the same size", TIKTOK, 480, "h264_540p_2240963-1"],
    ["TikTok at 1080: the larger HEVC picture", TIKTOK, 1080, "bytevc1_720p_1600000-0"],
  ] as const)("takes %s", (_what, info, cap, expected) => {
    expect(chosen(info, formatArgs("video", cap))).toBe(expected);
  }, 60_000);

  it("takes a site's AAC sound whether it says `mp4a` or `aac`", () => {
    expect(chosen(SHORT, formatArgs("audio", 1080))).toBe("140");
    expect(chosen(AAC_SOUND, formatArgs("audio", 1080))).toBe("aac");
  }, 60_000);
});
