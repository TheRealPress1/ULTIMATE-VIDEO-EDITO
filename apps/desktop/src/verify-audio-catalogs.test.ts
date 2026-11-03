/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The live catalog check, run against stand-ins: a fake yt-dlp, an injected
// fetch and a fake measurer, so no network or binary is touched.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkMeasured, checkMetadata, formatReport, parseArgs, verifyCatalogs } from "../scripts/verify-audio-catalogs.mjs";

import type { VerifyDeps } from "../scripts/verify-audio-catalogs.mjs";

const root = mkdtempSync(join(tmpdir(), "verify-catalogs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const song = { id: "youtube:XajaJYraODs", title: "Blinding Lights (Instrumental) — The Weeknd", sourceUrl: "https://www.youtube.com/watch?v=XajaJYraODs", durationSeconds: 203.34, sourceRange: { start: 0.8, end: 198.1 }, loudnessLufs: -7.6 };
const gone = { id: "youtube:AAAAAAAAAAA", title: "Gone — Someone", sourceUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA", durationSeconds: 100 };
const whoosh = { id: "freesound:60026", title: "Short airy whoosh", sourceUrl: "https://cdn.freesound.org/previews/60/60026_71257-hq.mp3", durationSeconds: 0.49, hitAt: 0.07 };
const meme = { id: "myinstants:bruh-sound-effect-26614", title: "Bruh", sourceUrl: "https://www.myinstants.com/en/instant/bruh-sound-effect-26614/", durationSeconds: 0.817 };

function docs() {
  const dir = mkdtempSync(join(root, "docs-"));
  mkdirSync(join(dir, "reference", "catalogs"), { recursive: true });
  writeFileSync(join(dir, "reference", "catalogs", "music.json"), JSON.stringify({ version: 1, kind: "music", updated: "2026-11-03", entries: [song, gone] }));
  writeFileSync(join(dir, "reference", "catalogs", "sfx.json"), JSON.stringify({ version: 1, kind: "sfx", updated: "2026-11-03", entries: [whoosh, meme] }));
  return dir;
}

function deps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    ytDlp: vi.fn(async (args: string[]) => {
      const url = args.at(-1)!;
      if (url.endsWith("AAAAAAAAAAA")) return { code: 1, stdout: "", stderr: "ERROR: [youtube] AAAAAAAAAAA: Video unavailable" };
      if (args.includes("-J")) return { code: 0, stdout: JSON.stringify({ title: "The Weeknd - Blinding Lights (Official Instrumental)", channel: "The Weeknd", duration: 203, availability: "public", live_status: "not_live" }), stderr: "" };
      writeFileSync(args[args.indexOf("-o") + 1]!.replace("%(id)s.%(ext)s", "XajaJYraODs.m4a"), "audio");
      return { code: 0, stdout: "", stderr: "" };
    }),
    fetch: vi.fn(async (url: string) => {
      if (url.includes("/instant/")) return new Response(`<meta property="og:audio" content="https://www.myinstants.com/media/sounds/bruh.mp3"/>`, { headers: { "content-type": "text/html" } });
      return new Response(new Uint8Array([0x49, 0x44, 0x33]), { headers: { "content-type": "audio/mpeg" } });
    }) as unknown as VerifyDeps["fetch"],
    download: false,
    measure: vi.fn(async () => ({ duration: 203.34, loudnessLufs: -7.7 })),
    ...overrides,
  };
}

describe("the live catalog check", () => {
  it("reads its options, refusing unknown ones", () => {
    expect(parseArgs(["--kind", "sfx", "--ids", "a, b", "--download", "--yt-dlp", "/x/yt-dlp"])).toMatchObject({ kinds: ["sfx"], download: true, ytDlp: "/x/yt-dlp" });
    expect([...parseArgs(["--ids", "a,b"]).ids!]).toEqual(["a", "b"]);
    expect(() => parseArgs(["--kind", "podcast"])).toThrow(/music or sfx/);
    expect(() => parseArgs(["--fix"])).toThrow(/Unknown option/);
  });

  it("passes live entries and names the ones that are gone, without touching the catalogs", async () => {
    const dir = docs();
    const stand = deps();
    const results = await verifyCatalogs({ kinds: ["music", "sfx"], ids: null, docsDir: dir }, stand);
    expect(results.map((result) => [result.id, result.status])).toEqual([[song.id, "ok"], [gone.id, "fail"], [whoosh.id, "ok"], [meme.id, "ok"]]);
    expect(results[1]!.problems[0]).toMatch(/Video unavailable/);
    expect(results[0]!.notes[0]).toContain("The Weeknd");
    expect(results[3]!.notes[0]).toContain("/media/sounds/bruh.mp3");
    expect(stand.fetch).toHaveBeenCalledWith("https://www.myinstants.com/media/sounds/bruh.mp3", expect.anything());
    const report = formatReport(results);
    expect(report).toContain(`FAIL music ${gone.id}`);
    expect(report).toContain("3 of 4 entries verified; 1 need a look");
  });

  it("measures downloads when asked, catching drift in length and loudness", async () => {
    const dir = docs();
    const results = await verifyCatalogs({ kinds: ["music"], ids: new Set([song.id]), docsDir: dir }, deps({ download: true, measure: vi.fn(async () => ({ duration: 190.2, loudnessLufs: -11 })) }));
    expect(results).toHaveLength(1);
    expect(results[0]!.problems.join(" ")).toMatch(/runs 190.2 s/);
    expect(results[0]!.problems.join(" ")).toMatch(/sourceRange ends at 198.1/);
    expect(results[0]!.problems.join(" ")).toMatch(/-11 LUFS/);
  });

  it("flags metadata that no longer matches the entry", () => {
    expect(checkMetadata(song, { duration: 203, availability: "public", live_status: "not_live" }).fail).toEqual([]);
    expect(checkMetadata(song, { duration: 260, availability: "public" }).fail.join(" ")).toMatch(/260 s, not 203.34 s/);
    expect(checkMetadata(song, { duration: 203, availability: "private" }).fail.join(" ")).toMatch(/private/);
    expect(checkMetadata(song, { duration: 203, live_status: "is_live" }).fail.join(" ")).toMatch(/live stream/);
    expect(checkMeasured(whoosh, { duration: 0.05 })).toEqual(["the file runs 0.05 s, not 0.49 s", "hitAt 0.07 s is past the source"]);
    expect(checkMeasured(whoosh, { duration: 0.4 })).toEqual([]);
  });

  it("calls a file that isn't audio a failure", async () => {
    const dir = docs();
    const results = await verifyCatalogs({ kinds: ["sfx"], ids: new Set([whoosh.id]), docsDir: dir }, deps({ fetch: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as VerifyDeps["fetch"] }));
    expect(results[0]).toMatchObject({ status: "fail", problems: ["its file is text/html, not audio"] });
  });
});
