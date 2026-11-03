/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { DapiError } from "@diffusionstudio/dapi";
import { creatorTarget, datePool, fileStem, isInstagramCdn, looksLikeImage, looksLikeMediaFile, mediaIdOf, platformOf, queryTarget, siteName, siteOfExtractor } from "./platform-url";

describe("platformOf", () => {
  it.each([
    ["https://www.youtube.com/watch?v=AbCdEfGhIj0", "youtube"],
    ["https://music.youtube.com/watch?v=AbCdEfGhIj0", "youtube"],
    ["https://youtu.be/AbCdEfGhIj0", "youtube"],
    ["https://m.soundcloud.com/a/b", "soundcloud"],
    ["https://www.tiktok.com/@a/video/7300000000000000001", "tiktok"],
    ["https://vm.tiktok.com/ZMabc/", "tiktok"],
    ["https://www.instagram.com/reel/AbC123/", "instagram"],
    ["https://twitter.com/a/status/1234567890", "x"],
    ["https://x.com/a/status/1234567890", "x"],
    ["https://player.vimeo.com/video/123456", "vimeo"],
    ["https://www.myinstants.com/en/instant/boing-123/", "myinstants"],
  ])("%s is %s", (url, site) => expect(platformOf(url)).toBe(site));

  it.each([
    "https://notyoutube.com/watch?v=x", "https://youtube.com.evil.example/watch", "https://example.com/a.mp4", "ftp://youtube.com/x", "not a url",
    "https://scontent.cdninstagram.com/v/video.mp4",
  ])("%s is no known platform", (url) => expect(platformOf(url)).toBeNull());

  it("knows Instagram's file servers apart from its pages", () => {
    expect(isInstagramCdn("https://scontent-lhr8-1.cdninstagram.com/o1/v/t16/f2/m69/AQx.mp4?efg=1")).toBe(true);
    expect(isInstagramCdn("https://video.xx.fbcdn.net/v/t42/AQx.mp4")).toBe(true);
    expect(isInstagramCdn("http://scontent.cdninstagram.com/a.mp4")).toBe(false);
    expect(isInstagramCdn("https://cdninstagram.com.evil.example/a.mp4")).toBe(false);
    expect(isInstagramCdn("https://www.instagram.com/reel/AbC123/")).toBe(false);
  });
});

describe("mediaIdOf", () => {
  it.each([
    ["https://www.youtube.com/watch?v=AbCdEfGhIj0&t=30s", { site: "youtube", id: "AbCdEfGhIj0" }],
    ["https://www.youtube.com/watch?v=AbCdEfGhIj0&list=PL123", { site: "youtube", id: "AbCdEfGhIj0" }],
    ["https://youtu.be/AbCdEfGhIj0?si=x", { site: "youtube", id: "AbCdEfGhIj0" }],
    ["https://www.youtube.com/shorts/ShOrT_123-x", { site: "youtube", id: "ShOrT_123-x" }],
    ["https://www.youtube.com/live/LiVe0000001", { site: "youtube", id: "LiVe0000001" }],
    ["https://www.youtube-nocookie.com/embed/AbCdEfGhIj0", { site: "youtube", id: "AbCdEfGhIj0" }],
    ["https://music.youtube.com/watch?v=MuSiC000001&feature=share", { site: "youtube", id: "MuSiC000001" }],
    ["https://www.tiktok.com/@dancer.one/video/7300000000000000001?lang=en", { site: "tiktok", id: "7300000000000000001" }],
    ["https://x.com/someone/status/1790000000000000000/video/1", { site: "x", id: "1790000000000000000" }],
    ["https://twitter.com/someone/status/1790000000000000000", { site: "x", id: "1790000000000000000" }],
    ["https://www.instagram.com/reel/CaRoUsEl123/?igsh=x", { site: "instagram", id: "CaRoUsEl123" }],
    ["https://www.instagram.com/p/CaRoUsEl123/", { site: "instagram", id: "CaRoUsEl123" }],
    ["https://vimeo.com/123456789", { site: "vimeo", id: "123456789" }],
    ["https://vimeo.com/channels/staffpicks/123456789", { site: "vimeo", id: "123456789" }],
    ["https://player.vimeo.com/video/123456789?h=abc", { site: "vimeo", id: "123456789" }],
    ["https://www.myinstants.com/en/instant/Boing-123/", { site: "myinstants", id: "boing-123" }],
  ])("%s names %j", (url, expected) => expect(mediaIdOf(url)).toEqual(expected));

  it.each([
    "https://www.youtube.com/@quietrooms", "https://www.youtube.com/playlist?list=PL123", "https://www.youtube.com/watch?v=short",
    "https://vm.tiktok.com/ZMabc/", "https://www.instagram.com/someone/", "https://x.com/someone", "https://soundcloud.com/a/b", "https://example.com/v/123",
  ])("%s names nothing on its own", (url) => expect(mediaIdOf(url)).toBeNull());
});

describe("names and sites", () => {
  it("keeps a YouTube id as the file stem and makes any other id safe", () => {
    expect(fileStem("XajaJYraODs")).toBe("XajaJYraODs");
    expect(fileStem("a/b:c?d")).toBe("a_b_c_d");
    expect(fileStem("x".repeat(100))).toHaveLength(80);
    expect(fileStem("")).toBe("media");
  });

  it("maps the downloader's extractor names to sites", () => {
    expect(siteOfExtractor("Youtube")).toBe("youtube");
    expect(siteOfExtractor("YoutubeTab")).toBe("youtube");
    expect(siteOfExtractor("Twitter")).toBe("x");
    expect(siteOfExtractor("TikTok")).toBe("tiktok");
    expect(siteOfExtractor("Generic")).toBe("web");
    expect(siteOfExtractor(undefined)).toBe("web");
    expect(siteOfExtractor("BandcampAlbum")).toBe("bandcampalbum");
    // Freesound pages reach the downloader from the audio catalog: their credit names the site properly.
    expect(siteName(siteOfExtractor("Freesound"))).toBe("Freesound");
    expect(platformOf("https://freesound.org/people/qubodup/sounds/60026/")).toBeNull();
  });

  it("recognizes image links by their file name", () => {
    expect(looksLikeImage("https://example.com/a/photo.JPG?x=1")).toBe(true);
    expect(looksLikeImage("https://example.com/clip.mp4")).toBe(false);
    expect(looksLikeImage("https://www.youtube.com/watch?v=x")).toBe(false);
  });

  it("tells a platform's own media file from its pages", () => {
    expect(looksLikeMediaFile("https://www.myinstants.com/media/sounds/vine-boom.mp3")).toBe(true);
    expect(looksLikeMediaFile("https://example.com/clip.MP4?x=1")).toBe(true);
    expect(looksLikeMediaFile("https://example.com/a/photo.jpg")).toBe(true);
    expect(looksLikeMediaFile("https://www.myinstants.com/en/instant/vine-boom-12345/")).toBe(false);
    expect(looksLikeMediaFile("https://www.youtube.com/watch?v=x&f=a.mp3")).toBe(false);
  });
});

describe("creatorTarget", () => {
  it("normalizes YouTube handles, channel ids and links to a tab", () => {
    expect(creatorTarget("youtube", "@a.b-c")).toEqual({ url: "https://www.youtube.com/@a.b-c/videos", handle: "@a.b-c" });
    expect(creatorTarget("youtube", "quietrooms", "shorts")).toEqual({ url: "https://www.youtube.com/@quietrooms/shorts", handle: "@quietrooms" });
    expect(creatorTarget("youtube", "UCabcdefghijklmnopqrstuv")).toEqual({ url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos", handle: null });
    expect(creatorTarget("youtube", "https://www.youtube.com/@quietrooms/about", "streams").url).toBe("https://www.youtube.com/@quietrooms/streams");
    expect(creatorTarget("youtube", "https://youtube.com/channel/UCabcdefghijklmnopqrstuv/featured").url).toBe("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos");
    expect(creatorTarget("youtube", "https://www.youtube.com/c/OldName").url).toBe("https://www.youtube.com/c/OldName/videos");
  });

  it.each(["@a", "@has space", "https://vimeo.com/someone", "https://www.youtube.com/watch?v=AbCdEfGhIj0", "@".padEnd(40, "x")])("refuses %s as a YouTube creator", (creator) => {
    expect(() => creatorTarget("youtube", creator)).toThrow(/creator Cutroom can list on YouTube/);
  });

  it("lists SoundCloud tracks, Vimeo videos, TikTok and Instagram accounts", () => {
    expect(creatorTarget("soundcloud", "https://soundcloud.com/Neon-Coast/sets")).toEqual({ url: "https://soundcloud.com/neon-coast/tracks", handle: "neon-coast" });
    expect(creatorTarget("vimeo", "studio")).toEqual({ url: "https://vimeo.com/studio/videos", handle: "studio" });
    expect(creatorTarget("tiktok", "https://www.tiktok.com/@dancer.one?lang=en")).toEqual({ url: "https://www.tiktok.com/@dancer.one", handle: "@dancer.one" });
    expect(creatorTarget("instagram", "@some.one")).toEqual({ url: "https://www.instagram.com/some.one/", handle: "@some.one" });
    expect(() => creatorTarget("vimeo", "123456")).toThrow(/list on Vimeo/);
    expect(() => creatorTarget("tiktok", "https://www.tiktok.com/video/1")).toThrow(/list on TikTok/);
    expect(() => creatorTarget("instagram", "https://www.instagram.com/reel/abc/")).toThrow(/list on Instagram/);
  });

  it("says X accounts and MyInstants have no listing, with what to do instead", () => {
    const x = (() => { try { creatorTarget("x", "@someone"); } catch (error) { return error as DapiError; } })()!;
    expect(x.code).toBe("unsupported");
    expect(x.message).toMatch(/media_download/);
    expect(() => creatorTarget("myinstants", "anyone")).toThrow(/query/);
  });
});

describe("queryTarget", () => {
  it("builds each platform's search, encoding what a URL would misread", () => {
    expect(queryTarget("youtube", "a & b #c", 5)).toBe("ytsearch5:a & b #c");
    expect(queryTarget("youtube_music", "rock & roll", 3)).toBe("https://music.youtube.com/search?q=rock%20%26%20roll#songs");
    expect(queryTarget("soundcloud", "night drive", 7)).toBe("scsearch7:night drive");
    expect(queryTarget("myinstants", "vine boom", 3)).toBe("https://www.myinstants.com/en/search/?name=vine%20boom");
  });

  it("reads a larger relevance pool to put a YouTube search newest first, which its results page no longer does", () => {
    expect([1, 5, 10, 20].map(datePool)).toEqual([20, 20, 30, 50]);
  });

  it.each(["instagram", "x", "tiktok", "vimeo"] as const)("refuses a %s keyword search with a substitute", (platform) => {
    try {
      queryTarget(platform, "cats", 5);
      expect.unreachable();
    } catch (error) {
      expect((error as DapiError).code).toBe("unsupported");
      expect((error as DapiError).message).toMatch(/web search|creator|YouTube/);
    }
  });
});
