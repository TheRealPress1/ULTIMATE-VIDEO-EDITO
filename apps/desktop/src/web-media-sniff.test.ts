/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { decodeEntities, sharedMedia, sniff } from "./web-media-sniff";

const bytes = (...parts: Array<string | number[]>): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const char of part) out.push(char.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array([...out, ...new Array(64).fill(0)]);
};
/** An ISO-BMFF `ftyp` box with a major brand and compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + compatible.length * 4;
  return bytes([0, 0, 0, size], "ftyp", major, [0, 0, 0, 0], ...compatible);
};
const text = (value: string) => new TextEncoder().encode(value);

describe("sniff", () => {
  it.each([
    ["JPEG", bytes([0xff, 0xd8, 0xff, 0xe0]), "image", "image/jpeg", "jpg"],
    ["PNG", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image", "image/png", "png"],
    ["GIF", bytes("GIF89a"), "image", "image/gif", "gif"],
    ["WebP", bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "), "image", "image/webp", "webp"],
    ["AVIF", ftyp("avif", "mif1", "miaf"), "image", "image/avif", "avif"],
    ["AVIF via compatible brand", ftyp("mif1", "avif"), "image", "image/avif", "avif"],
    ["BMP", bytes("BM", [0x36, 0, 0, 0, 0, 0, 0, 0, 0x36, 0]), "image", "image/bmp", "bmp"],
    ["SVG", text('<?xml version="1.0"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10"></svg>'), "image", "image/svg+xml", "svg"],
    ["MP4", ftyp("isom", "iso2", "avc1", "mp41"), "video", "video/mp4", "mp4"],
    ["MOV", ftyp("qt  ", "qt  "), "video", "video/quicktime", "mov"],
    ["M4V", ftyp("M4V ", "M4V ", "mp42"), "video", "video/x-m4v", "m4v"],
    ["M4A", ftyp("M4A ", "M4A ", "mp42", "isom"), "audio", "audio/mp4", "m4a"],
    ["WebM", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], "webm"), "video", "video/webm", "webm"],
    ["Matroska", bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88], "matroska"), "video", "video/x-matroska", "mkv"],
    ["Ogg Theora", bytes("OggS", [0, 2, 0, 0, 0, 0, 0, 0, 0, 0], [0x80], "theora"), "video", "video/ogg", "ogv"],
    ["Ogg Vorbis", bytes("OggS", [0, 2, 0, 0, 0, 0, 0, 0, 0, 0], [0x01], "vorbis"), "audio", "audio/ogg", "ogg"],
    ["Ogg Opus", bytes("OggS", [0, 2], "OpusHead"), "audio", "audio/ogg", "ogg"],
    ["MPEG-TS", (() => { const ts = new Uint8Array(400); ts[0] = ts[188] = ts[376] = 0x47; return ts; })(), "video", "video/mp2t", "ts"],
    ["MP3 with ID3", bytes("ID3", [4, 0, 0, 0, 0, 0, 0]), "audio", "audio/mpeg", "mp3"],
    ["MP3 frame", bytes([0xff, 0xfb, 0x90, 0x64]), "audio", "audio/mpeg", "mp3"],
    ["ADTS AAC", bytes([0xff, 0xf1, 0x50, 0x80]), "audio", "audio/aac", "aac"],
    ["WAV", bytes("RIFF", [1, 2, 3, 4], "WAVEfmt "), "audio", "audio/wav", "wav"],
    ["FLAC", bytes("fLaC", [0, 0, 0, 34]), "audio", "audio/flac", "flac"],
  ])("recognizes %s", (_name, head, kind, mimeType, ext) => {
    expect(sniff(head)).toEqual({ kind, mimeType, ext });
  });

  it("takes untagged Ogg as video only when video is preferred", () => {
    const ogg = bytes("OggS", [0, 2, 0, 0, 0, 0, 0, 0]);
    expect(sniff(ogg)).toMatchObject({ kind: "audio" });
    expect(sniff(ogg, "video")).toMatchObject({ kind: "video", ext: "ogv" });
    expect(sniff(bytes("OggS", [0, 2], [1], "vorbis"), "video")).toMatchObject({ kind: "audio" });
  });

  it("asks for a rendition of TIFF and HEIC images", () => {
    for (const head of [bytes([0x49, 0x49, 0x2a, 0x00]), bytes([0x4d, 0x4d, 0x00, 0x2a]), ftyp("heic", "mif1", "heic"), ftyp("mif1", "heic")]) {
      const sniffed = sniff(head);
      expect(sniffed.kind).toBe("rejected");
      expect((sniffed as { reason: string }).reason).toMatch(/Choose a JPEG\/PNG\/WebP rendition of this image\.$/);
    }
  });

  it("recognizes web pages, with or without a doctype, and refuses everything else", () => {
    for (const page of ["<!DOCTYPE html><html>", "\uFEFF  <!doctype HTML>", "<!-- hi -->\n<html lang=en>", "<head><meta charset=utf-8>", "<meta property=og:image content=x>"]) {
      expect(sniff(text(page)), page).toEqual({ kind: "html" });
    }
    for (const other of [text("%PDF-1.7\n"), text("{\"results\": []}"), text("PK\u0003\u0004zip"), bytes("RIFF", [1, 2, 3, 4], "AVI LIST"), ftyp("jp2 ", "jp2 "), new Uint8Array(0)]) {
      const sniffed = sniff(other);
      expect(sniffed.kind).toBe("rejected");
      expect((sniffed as { reason: string }).reason).toMatch(/isn't an image, video or audio file/);
    }
  });
});

describe("sharedMedia", () => {
  const page = new URL("https://news.example/2026/10/launch.html");

  it("finds a page's shared image, in priority order, resolved against the page", () => {
    const html = `<!doctype html><html><head>
      <title>Launch &amp; landing | News</title>
      <meta name="twitter:image" content="/img/twitter.jpg">
      <meta content="https://cdn.example/og-secure.jpg" property="og:image:secure_url" />
      <meta property='og:image' content='../../media/og.jpg?w=1200&amp;h=630'>
      <link rel="image_src" href="//cdn.example/link.jpg">
      <meta property="og:image" content="javascript:alert(1)">
    </head></html>`;
    expect(sharedMedia(html, page)).toEqual({
      candidates: [
        "https://cdn.example/og-secure.jpg",
        "https://news.example/media/og.jpg?w=1200&h=630",
        "https://news.example/img/twitter.jpg",
        "https://cdn.example/link.jpg",
      ],
      title: "Launch & landing | News",
    });
  });

  it("puts the page's video first only when video is preferred, and honors <base>", () => {
    const html = `<head><base href="https://static.example/assets/"><meta property="og:title" content="Liftoff">
      <meta property="og:video" content="clip.mp4"><meta property="og:image" content="poster.jpg"></head>`;
    expect(sharedMedia(html, page, "video").candidates).toEqual(["https://static.example/assets/clip.mp4", "https://static.example/assets/poster.jpg"]);
    expect(sharedMedia(html, page, "image")).toEqual({ candidates: ["https://static.example/assets/poster.jpg"], title: "Liftoff" });
  });

  it("finds nothing on a page that shares nothing", () => {
    expect(sharedMedia("<html><body><img src=a.jpg></body></html>", page)).toEqual({ candidates: [] });
  });

  it("reads attributes however they are spelled: unquoted, unspaced, valueless, unterminated", () => {
    const html = `<META PROPERTY=og:image CONTENT=/a.jpg/><meta property="og:image:url"content='b.jpg'>
      <meta name content="ignored"><meta = property="twitter:image" content="c.jpg"><metadata property="og:image" content="no.jpg">
      <link rel="preload image_src" href="d.jpg"><title id=t>Pad <b>39A</b></title><title>Second</title>
      <meta property="og:image:secure_url" content="https://e.example/e.jpg`;
    expect(sharedMedia(html, page)).toEqual({
      candidates: ["https://news.example/a.jpg/", "https://news.example/2026/10/b.jpg", "https://news.example/2026/10/c.jpg", "https://news.example/2026/10/d.jpg"],
      title: "Pad <b>39A</b>",
    });
  });

  it("reads a hostile 2 MiB page in linear time", () => {
    const size = 2 * 1024 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const pages = [
      fill("<meta "), // every tag left open, none closed
      fill("<link <base "),
      fill("<title>"), // titles never closed
      `<meta ${"a".repeat(size)}>`, // one long tag without an `=`
      `<meta ${fill("a ")}>`,
      `<meta ${fill("a=")}>`,
      `<meta content="${fill("&amp")}`,
      `<title>${fill("</title ")}`,
      `<meta property="og:image" content="x.jpg">${fill("<meta a=b>")}`,
    ];
    for (const html of pages) {
      const started = performance.now();
      sharedMedia(html, page);
      expect(performance.now() - started, html.slice(0, 24)).toBeLessThan(500);
    }
  });

  it("reads a 2 MiB page of tens of thousands of share tags in linear time, keeping the first few", () => {
    const size = 2 * 1024 * 1024;
    const tags = (make: (i: number) => string) => {
      const parts: string[] = [];
      for (let i = 0, length = 0; length < size; i++) length += parts[parts.push(make(i)) - 1]!.length;
      return parts.join("");
    };
    const pages: Array<[string, string, string[]]> = [
      ["the same og:image", tags(() => `<meta property="og:image" content="/a">`), ["https://news.example/a"]],
      ["distinct og:image", tags((i) => `<meta property=og:image content=/${i}>`), Array.from({ length: 8 }, (_, i) => `https://news.example/${i}`)],
      ["distinct image_src", tags((i) => `<link rel=image_src href=/${i}>`), Array.from({ length: 8 }, (_, i) => `https://news.example/${i}`)],
      ["distinct twitter:image", tags((i) => `<meta name=twitter:image content=/${i}>`), Array.from({ length: 8 }, (_, i) => `https://news.example/${i}`)],
      ["unusable og:image", tags((i) => `<meta property=og:image content="http://[${i}">`), []],
      ["distinct keys", tags((i) => `<meta property=k${i} content=/${i}>`), []],
      ["unusable bases", tags((i) => `<base href="http://[${i}">`), []],
    ];
    for (const [name, html, candidates] of pages) {
      const started = performance.now();
      const shared = sharedMedia(html, page);
      expect(performance.now() - started, name).toBeLessThan(500);
      expect(shared.candidates, name).toEqual(candidates);
    }
    // A gallery's first images still come in order of key, then of tag.
    const gallery = `${Array.from({ length: 30 }, (_, i) => `<meta property=og:image content=/og${i}>`).join("")}<meta name=twitter:image content=/tw>`;
    expect(sharedMedia(gallery, page).candidates).toEqual(Array.from({ length: 8 }, (_, i) => `https://news.example/og${i}`));
    expect(sharedMedia(`<meta property=og:image content=/og><meta name=twitter:image content=/tw>`, page).candidates)
      .toEqual(["https://news.example/og", "https://news.example/tw"]);
  });

  it("resolves against the first <base href> only, as a browser does", () => {
    const html = `<base target=_blank><base href="https://first.example/a/"><base href="https://second.example/b/"><meta property="og:image" content="x.jpg">`;
    expect(sharedMedia(html, page).candidates).toEqual(["https://first.example/a/x.jpg"]);
    expect(sharedMedia(`<base href="http://[bad"><base href="https://second.example/"><meta property="og:image" content="x.jpg">`, page).candidates)
      .toEqual(["https://news.example/2026/10/x.jpg"]);
  });

  it("decodes named and numeric character references", () => {
    expect(decodeEntities("a&amp;b &lt;c&gt; &#39;d&#x27; &quot;e&quot; &#x1F680; &unknown; &#0;")).toBe("a&b <c> 'd' \"e\" 🚀 &unknown; &#0;");
  });
});
