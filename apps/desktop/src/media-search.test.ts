/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";
import { DapiError, toolByName } from "@diffusionstudio/dapi";
import { MediaSearchService, mapEntry, parseListing, publishedAt } from "./media-search";
import {
  MYINSTANTS_SEARCH, SOUNDCLOUD_SEARCH_FLAT, SOUNDCLOUD_SEARCH_FULL, TIKTOK_USER, VIMEO_USER, YOUTUBE_CHANNEL, YOUTUBE_MUSIC_SEARCH, YOUTUBE_MUSIC_SEARCH_FULL,
  YOUTUBE_SEARCH,
} from "./media-fixtures";

import type { DownloaderRun, MediaDownloader } from "./media-runner";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 as const }];

function downloader(answers: unknown[]) {
  const runs: string[][] = [];
  const fake = {
    status: () => ({ state: "ready" as const, version: "2026.10.26" }),
    ensure: vi.fn(async () => ({ path: "/bin/yt-dlp", version: "2026.10.26" })),
    update: vi.fn(async () => ({ version: "2026.10.26", changed: false })),
    run: vi.fn(async (args: string[], opts: { signal?: AbortSignal }): Promise<DownloaderRun> => {
      runs.push(args);
      if (opts.signal?.aborted) return { code: null, signal: "SIGTERM", stdout: "", stderr: "ERROR: [cutroom:canceled] canceled" };
      const next = answers.shift();
      if (next instanceof Error) return { code: 1, signal: null, stdout: "", stderr: `ERROR: ${next.message}` };
      return { code: 0, signal: null, stdout: `[debug] noise\n${JSON.stringify(next ?? { entries: [] })}\n`, stderr: "" };
    }),
  } satisfies MediaDownloader;
  return { fake, runs };
}

function service(answers: unknown[], extra: Partial<ConstructorParameters<typeof MediaSearchService>[0]> = {}) {
  const { fake, runs } = downloader(answers);
  const fetch = vi.fn(async (url: string) => (url.endsWith("/huge.jpg") ? new Response(new Uint8Array(2 * 1024 * 1024)) : url.endsWith("/page.jpg") ? new Response("<html></html>") : new Response(JPEG)));
  const search = new MediaSearchService({ downloader: () => fake, fetch, resolve: PUBLIC, networkRetryMs: 0, ...extra });
  return { search, fake, runs, fetch };
}

const args = (input: Record<string, unknown>) => toolByName("media_search").input.parse(input);
const signal = () => new AbortController().signal;

describe("media_search on YouTube", () => {
  it("runs a flat ytsearch and maps the entries, dropping channels", async () => {
    const { search, runs } = service([YOUTUBE_SEARCH]);
    const answer = await search.search(args({ query: "lofi rain instrumental", limit: 3, preview: 0 }), signal());
    expect(runs[0]).toEqual(["--flat-playlist", "-J", "--playlist-end", "3", "--extractor-args", "youtubetab:approximate_date", "ytsearch3:lofi rain instrumental"]);
    expect(answer.profile).toBeNull();
    expect(answer.results.map((result) => result.id)).toEqual(["AbCdEfGhIj0", "ShOrT_123-x", "LiVe0000001"]);
    expect(answer.results[0]).toEqual({
      index: 1, id: "AbCdEfGhIj0", platform: "youtube", title: "Rain on the Window (Instrumental)", channel: "Quiet Rooms",
      channelUrl: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", url: "https://www.youtube.com/watch?v=AbCdEfGhIj0",
      durationSeconds: 187, publishedAt: "2024-01-01", publishedAtApproximate: true, views: 120345, likes: null, comments: null, live: "none",
      thumbnailUrl: "https://i.ytimg.com/vi/AbCdEfGhIj0/hq720.jpg?sqp=big",
    });
    // A Short's link becomes its watch page; a missing duration is null, never a failure.
    expect(answer.results[1]).toMatchObject({ url: "https://www.youtube.com/watch?v=ShOrT_123-x", durationSeconds: null, channel: "Drizzle", publishedAt: null, thumbnailUrl: "https://i.ytimg.com/vi/ShOrT_123-x/hqdefault.jpg" });
    expect(answer.results[2]).toMatchObject({ live: "live", publishedAt: "2024-03-01" });
    expect(toolByName("media_search").output.safeParse({ ...answer, previews: undefined }).success).toBe(true);
  });

  it("sorts by date itself, newest first from a larger relevance pool, since YouTube's results page no longer does", async () => {
    const pool = {
      ...YOUTUBE_SEARCH,
      entries: [
        { _type: "url", ie_key: "Youtube", id: "OlD00000001", url: "https://www.youtube.com/watch?v=OlD00000001", title: "old", timestamp: 1600000000 },
        { _type: "url", ie_key: "Youtube", id: "UnDaTeD0001", url: "https://www.youtube.com/watch?v=UnDaTeD0001", title: "undated" },
        { _type: "url", ie_key: "Youtube", id: "NeW00000001", url: "https://www.youtube.com/watch?v=NeW00000001", title: "new", timestamp: 1760000000 },
        { _type: "url", ie_key: "Youtube", id: "MiD00000001", url: "https://www.youtube.com/watch?v=MiD00000001", title: "middle", upload_date: "20230101" },
      ],
    };
    const { search, runs } = service([pool]);
    const answer = await search.search(args({ query: "rain & thunder", sort: "date", limit: 3, preview: 0 }), signal());
    expect(runs[0]).toEqual(["--flat-playlist", "-J", "--playlist-end", "20", "--extractor-args", "youtubetab:approximate_date", "ytsearch20:rain & thunder"]);
    expect(answer.results.map((result) => [result.index, result.id])).toEqual([[1, "NeW00000001"], [2, "MiD00000001"], [3, "OlD00000001"]]);
    expect(answer.warnings).toEqual(["YouTube no longer sorts a search by upload date, so these are the newest of its 20 most relevant results; the dates are approximate."]);
  });

  it("lists a creator's tab with the profile the listing carries", async () => {
    const { search, runs } = service([YOUTUBE_CHANNEL]);
    const answer = await search.search(args({ creator: "@quietrooms", tab: "shorts", limit: 2, preview: 0 }), signal());
    expect(runs[0]!.at(-1)).toBe("https://www.youtube.com/@quietrooms/shorts");
    expect(answer.profile).toEqual({
      handle: "@quietrooms", name: "Quiet Rooms", bio: "Rain, rooms and slow piano.", url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
      followers: 48200, following: null, posts: null, verified: true,
    });
    expect(answer.results.map((result) => [result.id, result.channel])).toEqual([["NeWeSt00001", "Quiet Rooms"], ["OlDeR000002", "Quiet Rooms"]]);
  });

  it("reads each YouTube Music song in full, whose flat listing has only titles, with links normalized to the watch page", async () => {
    const { search, runs } = service([YOUTUBE_MUSIC_SEARCH_FULL]);
    const answer = await search.search(args({ platform: "youtube_music", query: "slow piano", preview: 0 }), signal());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(["-J", "--playlist-end", "5", "--extractor-args", "youtubetab:approximate_date", "https://music.youtube.com/search?q=slow%20piano#songs"]);
    expect(answer.results[0]).toMatchObject({
      url: "https://www.youtube.com/watch?v=MuSiC000001", channel: "Some Artist", durationSeconds: 214, platform: "youtube_music", views: 81234,
      publishedAt: new Date(1683849600 * 1000).toISOString(), publishedAtApproximate: false,
    });
    expect(answer.results[1]).toMatchObject({ channel: "Some Artist", durationSeconds: 230, publishedAt: "2023-05-12" });
    expect(answer.warnings).toEqual([]);
  });

  it("falls back to YouTube Music's titles-only listing when a song can't be read, and says so", async () => {
    const { search, runs } = service([new Error("[youtube] MuSiC000002: Video unavailable"), YOUTUBE_MUSIC_SEARCH]);
    const answer = await search.search(args({ platform: "youtube_music", query: "slow piano", preview: 0 }), signal());
    expect(runs.map((run) => run.includes("--flat-playlist"))).toEqual([false, true]);
    expect(answer.results.map((result) => [result.title, result.channel, result.durationSeconds])).toEqual([["Slow Piano (Instrumental)", null, null], ["Slow Piano", null, null]]);
    expect(answer.warnings).toEqual(["YouTube Music's songs couldn't each be read, so these results have titles only, with no channel or duration."]);
  });

  it("keeps a long YouTube Music listing flat, saying what it lacks", async () => {
    const { search, runs } = service([YOUTUBE_MUSIC_SEARCH]);
    const answer = await search.search(args({ platform: "youtube_music", query: "slow piano", limit: 15, preview: 0 }), signal());
    expect(runs[0]![0]).toBe("--flat-playlist");
    expect(answer.results[0]).toMatchObject({ channel: null, durationSeconds: null });
    expect(answer.warnings[0]).toMatch(/^Above 10 results, YouTube Music's listing gives titles only/);
  });

  it("says when nothing matched", async () => {
    const { search } = service([{ _type: "playlist", entries: [] }]);
    const answer = await search.search(args({ query: "zzzz", preview: 0 }), signal());
    expect(answer.results).toEqual([]);
    expect(answer.warnings).toEqual(["Nothing matched. Try other words, or another platform."]);
  });
});

describe("media_search elsewhere", () => {
  it("reads SoundCloud entries in full when the flat search left out titles, never keeping API links", async () => {
    const { search, runs } = service([SOUNDCLOUD_SEARCH_FLAT, SOUNDCLOUD_SEARCH_FULL]);
    const answer = await search.search(args({ platform: "soundcloud", query: "night drive", limit: 2, preview: 0 }), signal());
    expect(runs).toHaveLength(2);
    expect(runs[0]![0]).toBe("--flat-playlist");
    expect(runs[1]).not.toContain("--flat-playlist");
    expect(answer.results[0]).toMatchObject({
      id: "1001", title: "Night Drive", channel: "Neon Coast", url: "https://soundcloud.com/neon-coast/night-drive", durationSeconds: 201.4,
      publishedAt: new Date(1690000000 * 1000).toISOString(), publishedAtApproximate: false, likes: 300, comments: 12,
    });
    expect(answer.results[1]!.url).toBe("https://soundcloud.com/neon-coast/night-drive-slowed");
  });

  it("reads a TikTok account in full, with a best-effort warning", async () => {
    const { search, runs } = service([TIKTOK_USER]);
    const answer = await search.search(args({ platform: "tiktok", creator: "@dancer.one", limit: 2, preview: 0 }), signal());
    expect(runs[0]).not.toContain("--flat-playlist");
    expect(runs[0]!.at(-1)).toBe("https://www.tiktok.com/@dancer.one");
    expect(answer.warnings[0]).toMatch(/TikTok account listings are best effort/);
    expect(answer.profile).toMatchObject({ handle: "@dancer.one", name: "dancer.one", followers: null });
    expect(answer.results[0]).toMatchObject({ id: "7300000000000000001", title: "new routine", channel: "Dancer One", views: 120000, likes: 9000, comments: 210, url: "https://www.tiktok.com/@dancer.one/video/7300000000000000001" });
    // An untitled video is named by its id rather than left blank.
    expect(answer.results[1]!.title).toBe("7300000000000000002");
  });

  it("lists a Vimeo user's videos", async () => {
    const { search, runs } = service([VIMEO_USER]);
    const answer = await search.search(args({ platform: "vimeo", creator: "studio", preview: 0 }), signal());
    expect(runs[0]!.at(-1)).toBe("https://vimeo.com/studio/videos");
    expect(answer.results[0]).toMatchObject({ id: "123456789", url: "https://vimeo.com/123456789", title: "Harbour at dusk" });
    // Its links mostly don't download without a sign-in, which the agent hears before trying.
    expect(answer.warnings).toEqual([expect.stringMatching(/^Vimeo downloads are best effort: .*media_download may refuse these links/)]);
  });

  it("decodes the character references a listing read from HTML carries", async () => {
    const escaped = { ...VIMEO_USER, entries: [{ ...VIMEO_USER.entries[0]!, title: "What&#039;s new &ldquo;Mission&rdquo; &amp; more&hellip;" }] };
    const { search } = service([escaped]);
    const answer = await search.search(args({ platform: "vimeo", creator: "staff", preview: 0 }), signal());
    expect(answer.results[0]!.title).toBe("What's new \u201cMission\u201d & more\u2026");
  });

  it.each(["instagram", "x", "tiktok", "vimeo"])("refuses a %s keyword search without running the downloader", async (platform) => {
    const { search, fake } = service([]);
    const error = await search.search(args({ platform, query: "cats" }), signal()).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "unsupported" });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("searches MyInstants through its own page, not the downloader", async () => {
    const pageFetch = vi.fn(async (_url: string) => new Response(MYINSTANTS_SEARCH, { status: 200 }));
    const { search, fake } = service([], { pageFetch });
    const answer = await search.search(args({ platform: "myinstants", query: "boing", limit: 5 }), signal());
    expect(fake.run).not.toHaveBeenCalled();
    expect(pageFetch.mock.calls[0]![0]).toBe("https://www.myinstants.com/en/search/?name=boing");
    expect(answer.results.map((result) => [result.id, result.title, result.url])).toEqual([
      ["boing-123", "Boing", "https://www.myinstants.com/en/instant/boing-123/"],
      ["vine-boom-456", "Vine \"Boom\"", "https://www.myinstants.com/en/instant/vine-boom-456/"],
      ["sad-trombone-789", "Sad Trombone", "https://www.myinstants.com/en/instant/sad-trombone-789/"],
    ]);
    expect(answer.previews).toEqual([]);
  });
});

describe("media_search's contract", () => {
  it("takes exactly one of query and creator", async () => {
    const { search } = service([]);
    for (const input of [{}, { query: "a", creator: "@abc" }]) {
      const error = await search.search(args(input), signal()).catch((thrown: DapiError) => thrown);
      expect(error).toMatchObject({ code: "invalid-input" });
      expect((error as Error).message).toMatch(/exactly one of `query`/);
    }
  });

  it("reuses an answer for the same arguments for ten minutes", async () => {
    let now = 0;
    const { search, fake } = service([YOUTUBE_SEARCH, YOUTUBE_SEARCH, YOUTUBE_SEARCH], { now: () => new Date(now) });
    const first = await search.search(args({ query: "rain", preview: 0 }), signal());
    expect(await search.search(args({ query: "rain", preview: 0 }), signal())).toBe(first);
    expect(fake.run).toHaveBeenCalledTimes(1);
    await search.search(args({ query: "rain", limit: 4, preview: 0 }), signal());
    expect(fake.run).toHaveBeenCalledTimes(2);
    now = 10 * 60_000;
    await search.search(args({ query: "rain", preview: 0 }), signal());
    expect(fake.run).toHaveBeenCalledTimes(3);
  });

  it("inlines the leading thumbnails that are small pictures, and only those", async () => {
    const listing = {
      entries: [
        { ...YOUTUBE_SEARCH.entries[0], id: "AAAAAAAAAA1" },
        { ...YOUTUBE_SEARCH.entries[0], id: "AAAAAAAAAA2", thumbnails: [{ url: "https://i.ytimg.com/huge.jpg", width: 640 }] },
        { ...YOUTUBE_SEARCH.entries[0], id: "AAAAAAAAAA3", thumbnails: [{ url: "https://i.ytimg.com/page.jpg", width: 640 }] },
        { ...YOUTUBE_SEARCH.entries[0], id: "AAAAAAAAAA4", thumbnails: [{ url: "https://localhost/x.jpg", width: 640 }] },
        { ...YOUTUBE_SEARCH.entries[0], id: "AAAAAAAAAA5" },
      ],
    };
    const { search, fetch } = service([listing]);
    const answer = await search.search(args({ query: "rain", limit: 5, preview: 4 }), signal());
    expect(answer.previews).toEqual([{ index: 1, bytes: JPEG, mimeType: "image/jpeg" }]);
    // The fifth is past `preview`; a private host is never asked.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://i.ytimg.com/vi/AbCdEfGhIj0/hq720.jpg?sqp=big", "https://i.ytimg.com/huge.jpg", "https://i.ytimg.com/page.jpg"]);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const { search, fake } = service([]);
    fake.run.mockImplementationOnce(async () => { controller.abort(new DapiError("canceled", "The search was canceled.")); return { code: null, signal: "SIGTERM", stdout: "", stderr: "" }; });
    const error = await search.search(args({ query: "rain" }), controller.signal).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "canceled" });
  });

  it("explains a build without the downloader", async () => {
    const search = new MediaSearchService({ downloader: () => null, resolve: PUBLIC });
    await expect(search.search(args({ query: "rain" }), signal())).rejects.toThrow(/no downloader/);
  });
});

describe("listing helpers", () => {
  it("reads the JSON after other output, and fails readably on none", () => {
    expect(parseListing("WARNING: x\n{\"id\":1}\n")).toEqual({ id: 1 });
    expect(() => parseListing("nothing here")).toThrow(/couldn't be read/);
  });

  it("dates by timestamp, else by upload day", () => {
    expect(publishedAt({ timestamp: 1704067200 })).toBe("2024-01-01T00:00:00.000Z");
    expect(publishedAt({ upload_date: "20240301" })).toBe("2024-03-01");
    expect(publishedAt({ upload_date: "March" })).toBeNull();
  });

  it("drops what isn't one upload", () => {
    const fallback = { channel: null, channelUrl: null };
    expect(mapEntry({ _type: "playlist", id: "x" }, "youtube", true, fallback)).toBeNull();
    expect(mapEntry({ id: "UCx", ie_key: "YoutubeTab", url: "https://www.youtube.com/@x" }, "youtube", true, fallback)).toBeNull();
    expect(mapEntry({ title: "no id" }, "youtube", true, fallback)).toBeNull();
    expect(mapEntry("junk", "youtube", true, fallback)).toBeNull();
  });
});
