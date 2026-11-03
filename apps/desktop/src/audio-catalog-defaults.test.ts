/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bundled catalogs, checked offline: shape, ids that name their sources,
// timing inside each source, original curation (nothing shared with the
// reference product's catalog), and the balance the curation promises. The
// live check that each source still exists is scripts/verify-audio-catalogs.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AudioCatalogFile, SfxCategory } from "@diffusionstudio/dapi";
import { idProblem, timingProblems, usableSeconds } from "./audio-catalog-merge";

import type { AudioCatalogEntry } from "@diffusionstudio/dapi";

const repoDocs = join(__dirname, "..", "..", "..", "docs");
const read = (kind: "music" | "sfx") => AudioCatalogFile.parse(JSON.parse(readFileSync(join(repoDocs, "reference", "catalogs", `${kind}.json`), "utf8")));
const music = read("music");
const sfx = read("sfx");
const entries = (file: typeof music) => file.entries as AudioCatalogEntry[];

/** The reference product's catalog ids, frozen: the defaults share none of them, so the curation stays Cutroom's own. */
const REFERENCE_IDS = [
  "youtube:9SBNCYkSceU", "youtube:-VzyB87A08U", "youtube:Dy6iD-aTVHY", "youtube:P5y6X5cKNC4", "youtube:hBI-WX1xmdE", "youtube:JuSsvM8B4Jc",
  "youtube:Cq54DnQQ4h4", "youtube:fxdJInWWGtU", "youtube:WDjMC5Gn63M", "youtube:4JZ-o3iAJv4", "youtube:b59ghNkQC6k", "youtube:43EJPhEhArA",
  "youtube:3B9hiYyYhkk", "youtube:cCJ2OX6V0A8", "youtube:tlUcpEE8A0Q", "youtube:Yczul_609Gg", "youtube:LiXIoqGXfh8", "youtube:O_5gPfLJ5v4",
  "myinstants:popular-riser-metallic-sound-effect-41559", "myinstants:whoosh-sfx-32736", "myinstants:simple-whoosh-76933", "myinstants:transition-whoosh-87155",
  "myinstants:pop-sfx-75405", "myinstants:mouse-click-84937", "myinstants:mouse-click-sound-63406", "myinstants:keyboard-single-click-67301",
  "myinstants:fahhhhhhhhhhhhhh-3525", "myinstants:vine-boom-sound-70972",
];
/** Songs in the reference catalog, by title: another upload of one of them would still be its pick. */
const REFERENCE_TITLES = [
  "hand covers bruise", "new computers", "now or never", "gone, gone", "cornfield chase", "every living breathing moment", "runaway",
  "everything in its right place", "can you hear the music", "summer", "freedom", "whisper my name", "walking on a dream", "hey kids", "in motion",
  "timeless", "dark red", "9 (instrumental)",
];

/** The reference catalog's meme sounds, by name: another upload of the same sound would still be its pick. */
const REFERENCE_SOUNDS = [/vine[\s_-]*boom/i, /\bfa+h{2,}/i];
/**
 * An effect's starting clip volume for a file peaking at 0 dBFS, by category:
 * the middle of the uve-sfx skill's starting range where it gives one (UI
 * clicks and pops -16 to -22, whooshes -12 to -18, impacts -8 to -14, risers
 * -14 to -20), and the README's level for the rest. `suggestedVolumeDb` is
 * this raised by however far the file peaks below 0 dBFS.
 */
const SFX_LEVELS: Record<string, number> = {
  click: -19, pop: -19, typing: -19, notification: -19, shutter: -19, sparkle: -19, foley: -19,
  whoosh: -15, swipe: -15, glitch: -15,
  impact: -11, boom: -11,
  riser: -17, downlifter: -17,
  success: -16, fail: -16, cash: -16,
  meme: -12,
  ambience: -24,
};
/** A level as the catalogs store it: whole decibels within the schema's -40..0 (and never -0). */
const level = (db: number) => Math.max(-40, Math.min(0, Math.round(db))) || 0;

/** Mood families the music is balanced across: each needs at least three entries. */
const FAMILIES: Record<string, string[]> = {
  calm: ["calm", "reflective"],
  curious: ["curious"],
  upbeat: ["upbeat", "warm"],
  hype: ["hype", "motivational", "triumphant"],
  cinematic: ["cinematic", "epic"],
  dark: ["dark", "tense", "eerie", "mysterious"],
  emotional: ["emotional", "romantic"],
  comedic: ["comedic", "playful"],
  retro: ["retro", "nostalgic"],
  confident: ["confident", "luxurious"],
};
const OPEN_RIGHTS = new Set(["cc0", "cc-by", "cc-by-sa", "royalty-free", "public-domain"]);
const PLAN_CATEGORIES = ["whoosh", "swipe", "riser", "downlifter", "impact", "boom", "click", "pop", "typing", "notification", "shutter", "glitch", "sparkle", "success", "fail", "cash", "meme", "foley"];
/** Agent-directed or link-bearing text has no place in a description: it is data an agent reads, never instructions. */
const UNSAFE_TEXT = /https?:|www\.|\.com\b|\byou must\b|\bignore\b|\btool\b|\bagent\b|\bsystem prompt\b/i;

describe.each([["music", music], ["sfx", sfx]] as const)("the bundled %s catalog", (kind, file) => {
  it("parses, is the right kind, and was curated recently", () => {
    expect(file.kind).toBe(kind);
    expect(file.version).toBe(1);
    expect(file.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has unique ids that name their sources", () => {
    const ids = entries(file).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of entries(file)) expect(idProblem(entry.id, entry.sourceUrl), entry.id).toBeNull();
    const urls = entries(file).map((entry) => entry.sourceUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("keeps every range, section and hit inside its source", () => {
    for (const entry of entries(file)) {
      expect(timingProblems(entry), entry.id).toEqual([]);
      expect(entry.verifiedAt, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (entry.sourceRange) expect(entry.sourceRange.end - entry.sourceRange.start, entry.id).toBeGreaterThan(0);
    }
  });

  it("describes each entry in plain, original prose", () => {
    for (const entry of entries(file)) {
      expect(entry.description!.length, entry.id).toBeGreaterThanOrEqual(80);
      expect(entry.description!.length, entry.id).toBeLessThanOrEqual(400);
      expect(entry.description, entry.id).not.toMatch(UNSAFE_TEXT);
      expect(entry.title, entry.id).not.toMatch(UNSAFE_TEXT);
    }
    const descriptions = entries(file).map((entry) => entry.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("shares nothing with the reference product's catalog", () => {
    const reference = new Set(REFERENCE_IDS);
    for (const entry of entries(file)) {
      expect(reference.has(entry.id), entry.id).toBe(false);
      for (const id of REFERENCE_IDS) expect(entry.sourceUrl.includes(id.split(":")[1]!), entry.id).toBe(false);
    }
  });

  it("credits every openly licensed entry", () => {
    for (const entry of entries(file)) {
      if (["cc-by", "cc-by-sa", "royalty-free", "public-domain"].includes(entry.rights)) expect(entry.attribution, entry.id).toBeTruthy();
    }
  });
});

describe("the music curation", () => {
  const list = entries(music);

  it("has thirty entries across ten mood families, and low, middle and high energy across the catalog", () => {
    expect(list.length).toBeGreaterThanOrEqual(30);
    for (const [family, moods] of Object.entries(FAMILIES)) {
      expect(list.filter((entry) => entry.moods!.some((mood) => moods.includes(mood))).length, family).toBeGreaterThanOrEqual(3);
    }
    expect(list.filter((entry) => entry.energy! <= 2).length).toBeGreaterThanOrEqual(6);
    expect(list.filter((entry) => entry.energy === 3).length).toBeGreaterThanOrEqual(6);
    expect(list.filter((entry) => entry.energy! >= 4).length).toBeGreaterThanOrEqual(6);
  });

  it("is what the catalog README says it is", () => {
    const readme = readFileSync(join(repoDocs, "reference", "catalogs", "README.md"), "utf8");
    expect(readme).toContain(`**Music (${list.length} entries)**`);
    expect(readme).toContain(`**Sound effects (${sfx.entries.length} entries)**`);
    const stated = /(\d+) entries are low energy \(1–2\), (\d+) middle \(3\) and (\d+) high \(4–5\)/.exec(readme);
    expect(stated?.slice(1).map(Number)).toEqual([
      list.filter((entry) => entry.energy! <= 2).length, list.filter((entry) => entry.energy === 3).length, list.filter((entry) => entry.energy! >= 4).length,
    ]);
  });

  it("is mostly instrumental, with a usable share of rights-safe beds", () => {
    expect(list.filter((entry) => entry.vocals === "none").length).toBeGreaterThanOrEqual(20);
    expect(list.filter((entry) => OPEN_RIGHTS.has(entry.rights)).length / list.length).toBeGreaterThanOrEqual(0.3);
  });

  it("spreads artists, apart from openly licensed libraries", () => {
    const counts = new Map<string, number>();
    for (const entry of list) if (!OPEN_RIGHTS.has(entry.rights)) counts.set(entry.artist!, (counts.get(entry.artist!) ?? 0) + 1);
    for (const [artist, count] of counts) expect(count, artist).toBeLessThanOrEqual(2);
  });

  it("titles each piece by name and artist, and picks none of the reference catalog's songs", () => {
    for (const entry of list) {
      expect(entry.title, entry.id).toContain(` — ${entry.artist}`);
      if (entry.variant === "instrumental") expect(entry.title, entry.id).toContain("(Instrumental)");
      const name = entry.title.split(" — ")[0]!.toLowerCase();
      for (const title of REFERENCE_TITLES) expect(name === title || name.startsWith(`${title} (`), `${entry.id} ${title}`).toBe(false);
    }
  });

  it("measures loudness and suggests a bed level about 18 LU under dialogue", () => {
    for (const entry of list) {
      expect(entry.loudnessLufs, entry.id).toBeDefined();
      expect(entry.suggestedVolumeDb, entry.id).toBe(level(-34 - entry.loudnessLufs!));
      expect(entry.sourceRange, entry.id).toBeDefined();
    }
  });
});

describe("the sound effect curation", () => {
  const list = entries(sfx);

  it("covers every planned category with at least thirty-six short sounds", () => {
    expect(list.length).toBeGreaterThanOrEqual(36);
    for (const category of PLAN_CATEGORIES) expect(list.some((entry) => entry.category === category), category).toBe(true);
    for (const entry of list) expect(entry.durationSeconds, entry.id).toBeLessThanOrEqual(entry.category === "ambience" ? 120 : 20);
  });

  it("says where each impact, riser, whoosh and click lands", () => {
    for (const entry of list) {
      if (["impact", "boom", "riser", "whoosh", "swipe", "click"].includes(entry.category!)) {
        expect(entry.align, entry.id).toBeDefined();
        expect(entry.hitAt, entry.id).toBeDefined();
      }
      expect(entry.sourceRange, entry.id).toBeDefined();
      expect(usableSeconds(entry)!, entry.id).toBeLessThanOrEqual(20);
    }
  });

  it("suggests each effect's level from its category's starting level and its own peak", () => {
    expect(Object.keys(SFX_LEVELS).sort()).toEqual([...SfxCategory.options].sort());
    for (const entry of list) {
      expect(entry.peakDb, entry.id).toBeDefined();
      expect(entry.suggestedVolumeDb, entry.id).toBe(level(SFX_LEVELS[entry.category!]! - entry.peakDb!));
    }
  });

  it("picks none of the reference catalog's meme sounds, under any upload", () => {
    for (const entry of list) for (const sound of REFERENCE_SOUNDS) expect(`${entry.id} ${entry.title} ${entry.sourceUrl}`, entry.id).not.toMatch(sound);
  });

  it("is mostly openly licensed, from sources that download reliably", () => {
    expect(list.filter((entry) => entry.rights === "cc0").length / list.length).toBeGreaterThanOrEqual(0.75);
    for (const entry of list) expect(entry.id, entry.id).toMatch(/^(freesound|wikimedia|openverse|myinstants|youtube):/);
  });
});
