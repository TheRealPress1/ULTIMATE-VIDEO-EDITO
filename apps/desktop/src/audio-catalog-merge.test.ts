/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { downloadFor, idProblem, listed, mergeCatalog, mergeEntry, patchProblems, present, timingProblems } from "./audio-catalog-merge";

import type { AudioCatalogEntry, AudioCatalogPatch } from "@diffusionstudio/dapi";

const calm: AudioCatalogEntry = {
  id: "youtube:AAAAAAAAAAA", title: "Calm Piece — Someone", description: "A slow piano bed for calm interviews and reflective stories, quiet enough to sit under any voice.",
  sourceUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA", durationSeconds: 180, rights: "copyrighted", verifiedAt: "2026-11-03",
  artist: "Someone", variant: "original", vocals: "none", moods: ["calm"], energy: 1, uses: ["interview"], avoid: ["sports"],
  sourceRange: { start: 2, end: 170 }, sections: [{ label: "intro", start: 2, end: 20 }], loudnessLufs: -20, suggestedVolumeDb: -14, tags: ["piano"],
};
const loud: AudioCatalogEntry = {
  id: "youtube:BBBBBBBBBBB", title: "Loud Piece (Instrumental) — Other", description: "A driving instrumental with heavy drums for sports highlights and gym montages that need energy.",
  sourceUrl: "https://www.youtube.com/watch?v=BBBBBBBBBBB", durationSeconds: 200, rights: "cc-by", verifiedAt: "2026-11-03", attribution: "Loud Piece by Other, CC BY",
  artist: "Other", variant: "instrumental", vocals: "lead", moods: ["hype"], energy: 5, uses: ["sports"],
};
const defaults = [calm, loud];
const patch = (fields: Partial<AudioCatalogPatch> & { id: string }) => fields as AudioCatalogPatch;
const merged = (patches: AudioCatalogPatch[]) => mergeCatalog(defaults, patches, "music");
const byId = (records: ReturnType<typeof merged>["records"], id: string) => records.find((record) => record.id === id)!;

describe("merging the personal layer over the defaults", () => {
  it("shows the defaults as they are, with where to download them", () => {
    const { records, warnings } = merged([]);
    expect(warnings).toEqual([]);
    expect(records.map((record) => record.merged!.origin)).toEqual(["default", "default"]);
    expect(records[0]!.merged!.download).toEqual({ tool: "media_download", url: calm.sourceUrl, folder: "music" });
    expect(records[0]!.merged).toMatchObject({ overridden: [], needsVerification: false, selectable: true });
  });

  it("lets a field override, an absent field inherit, and null clear", () => {
    const { records } = merged([patch({ id: calm.id, energy: 2, sections: null, notes: "My go-to for podcasts" })]);
    const entry = byId(records, calm.id).merged!;
    expect(entry).toMatchObject({ energy: 2, notes: "My go-to for podcasts", title: calm.title, origin: "overridden" });
    expect(entry.sections).toBeUndefined();
    expect(entry.overridden).toEqual(["sections", "energy", "notes"]);
    expect(byId(records, calm.id).default).toEqual(calm);
  });

  it("replaces arrays and ranges whole rather than merging their items", () => {
    const { records } = merged([patch({ id: calm.id, moods: ["dreamy"], sourceRange: { start: 30, end: 60 } })]);
    expect(byId(records, calm.id).merged).toMatchObject({ moods: ["dreamy"], sourceRange: { start: 30, end: 60 } });
  });

  it("drops the old recording's timing when the source moves without new timing, and flags it", () => {
    const moved = merged([patch({ id: calm.id, sourceUrl: "https://www.youtube.com/watch?v=CCCCCCCCCCC" })]);
    const entry = byId(moved.records, calm.id).merged!;
    expect(entry).toMatchObject({ needsVerification: true, download: { url: "https://www.youtube.com/watch?v=CCCCCCCCCCC" } });
    for (const field of ["sourceRange", "sections", "durationSeconds", "loudnessLufs", "suggestedVolumeDb"] as const) expect(entry[field], field).toBeUndefined();
    expect(moved.warnings.join(" ")).toContain(calm.id);
    const timed = merged([patch({ id: calm.id, sourceUrl: "https://www.youtube.com/watch?v=CCCCCCCCCCC", durationSeconds: 90 })]);
    expect(byId(timed.records, calm.id).merged).toMatchObject({ needsVerification: false, durationSeconds: 90, sourceRange: calm.sourceRange });
  });

  it("hides entries unless asked, counting them", () => {
    const { records } = merged([patch({ id: loud.id, hidden: true })]);
    expect(byId(records, loud.id).excludedReason).toBe("hidden");
    expect(listed(records, { includeHidden: false }).map((entry) => entry.id)).toEqual([calm.id]);
    expect(listed(records, { includeHidden: true }).map((entry) => entry.id)).toEqual([calm.id, loud.id]);
  });

  it("adds complete personal entries and leaves out incomplete or orphaned ones, naming them", () => {
    const { records, warnings } = merged([
      patch({ id: "user:intro", title: "My intro", description: "The jingle I open every video with.", sourceUrl: "https://example.com/intro.mp3", addedAt: "2026-11-02T00:00:00Z" }),
      patch({ id: "youtube:DDDDDDDDDDD", preferred: true }),
      patch({ id: "user:half", title: "No source yet" }),
    ]);
    expect(byId(records, "user:intro").merged).toMatchObject({ origin: "personal", rights: "unknown", download: { tool: "web_media_download", folder: "music" } });
    expect(byId(records, "youtube:DDDDDDDDDDD")).toMatchObject({ merged: null, excludedReason: "no-source" });
    expect(byId(records, "user:half")).toMatchObject({ merged: null, excludedReason: "no-source" });
    expect(warnings.some((warning) => warning.includes("youtube:DDDDDDDDDDD"))).toBe(true);
    expect(listed(records, { includeHidden: true }).map((entry) => entry.id)).toEqual([calm.id, loud.id, "user:intro"]);
    const titled = mergeEntry(null, patch({ id: "user:untitled", sourceUrl: "https://example.com/a.mp3" }), "music");
    expect(titled.record.excludedReason).toBe("incomplete");
  });

  it("orders preferred entries first, then the defaults, then personal entries by when they were added", () => {
    const { records } = merged([
      patch({ id: "user:b", title: "B", description: "Second added.", sourceUrl: "https://example.com/b.mp3", addedAt: "2026-11-02T00:00:00Z" }),
      patch({ id: "user:a", title: "A", description: "First added.", sourceUrl: "https://example.com/a.mp3", addedAt: "2026-11-01T00:00:00Z" }),
      patch({ id: loud.id, preferred: true }),
    ]);
    expect(records.map((record) => record.id)).toEqual([loud.id, calm.id, "user:a", "user:b"]);
  });

  it("uses the last of a duplicated personal id, with a warning", () => {
    const { records, warnings } = merged([patch({ id: calm.id, energy: 2 }), patch({ id: calm.id, energy: 3 })]);
    expect(byId(records, calm.id).merged!.energy).toBe(3);
    expect(warnings.join(" ")).toMatch(/more than once/);
  });

  it("strips unknown stored keys from what it answers", () => {
    const { records } = merged([patch({ id: calm.id, energy: 2, ...{ futureField: "x" } })]);
    expect(byId(records, calm.id).personal).toEqual({ id: calm.id, energy: 2 });
    expect("futureField" in byId(records, calm.id).merged!).toBe(false);
  });
});

describe("filtering and presenting", () => {
  const { records } = merged([]);
  const ids = (filters: Parameters<typeof listed>[1]) => listed(records, filters).map((entry) => entry.id);

  it("narrows by each filter, all together", () => {
    expect(ids({ includeHidden: false, moods: ["calm", "dreamy"] })).toEqual([calm.id]);
    expect(ids({ includeHidden: false, vocals: ["none"] })).toEqual([calm.id]);
    expect(ids({ includeHidden: false, energyMin: 4 })).toEqual([loud.id]);
    expect(ids({ includeHidden: false, energyMax: 2, uses: ["sports"] })).toEqual([]);
    expect(ids({ includeHidden: false, rights: ["cc-by", "cc0"] })).toEqual([loud.id]);
    expect(ids({ includeHidden: false, maxDurationSeconds: 175 })).toEqual([calm.id]);
    expect(ids({ includeHidden: false, query: "piano someone" })).toEqual([calm.id]);
    expect(ids({ includeHidden: false, query: "piano drums" })).toEqual([]);
  });

  it("leaves the long fields and the as-shipped bookkeeping out of a summary", () => {
    const summary = present(records[1]!.merged!, "summary");
    for (const field of ["description", "sections", "avoid", "sourceUrl", "attribution", "overridden", "needsVerification", "selectable"]) expect(summary, field).not.toHaveProperty(field);
    // The URL to fetch is still there, where the download names it.
    expect(summary).toMatchObject({ id: loud.id, moods: ["hype"], rights: "cc-by", origin: "default", download: { tool: "media_download", url: loud.sourceUrl } });
    const full = present(records[1]!.merged!, "full");
    expect(full).toMatchObject({ description: loud.description, attribution: loud.attribution, sourceUrl: loud.sourceUrl, overridden: [], needsVerification: false, selectable: true });
  });

  it("keeps the bookkeeping in a summary when it says something", () => {
    const changed = mergeCatalog(defaults, [patch({ id: calm.id, hidden: true, sourceUrl: "https://www.youtube.com/watch?v=CCCCCCCCCCC" })], "music").records;
    expect(present(changed[0]!.merged!, "summary")).toMatchObject({ overridden: ["sourceUrl", "hidden"], needsVerification: true, selectable: false });
  });

  it("downloads platform pages with media_download and files with web_media_download, into the kind's folder", () => {
    expect(downloadFor("https://www.myinstants.com/en/instant/bruh-sound-effect-26614/", "sfx")).toEqual({ tool: "media_download", url: "https://www.myinstants.com/en/instant/bruh-sound-effect-26614/", folder: "sfx" });
    expect(downloadFor("https://cdn.freesound.org/previews/60/60026_71257-hq.mp3", "sfx").tool).toBe("web_media_download");
    // A Freesound page shares a waveform picture, not the sound: the downloader reads the page for its preview file.
    expect(downloadFor("https://freesound.org/people/qubodup/sounds/60026/", "sfx")).toEqual({ tool: "media_download", url: "https://freesound.org/people/qubodup/sounds/60026/", folder: "sfx" });
    expect(downloadFor("https://www.freesound.org/people/qubodup/sounds/60026/", "sfx").tool).toBe("media_download");
    expect(downloadFor("https://upload.wikimedia.org/wikipedia/commons/8/85/Holst-_mars.ogg", "music")).toMatchObject({ tool: "web_media_download", folder: "music" });
  });
});

describe("consistency checks", () => {
  it("ties each id prefix to its source", () => {
    expect(idProblem("youtube:XajaJYraODs", "https://www.youtube.com/watch?v=XajaJYraODs")).toBeNull();
    expect(idProblem("youtube:XajaJYraODs", "https://youtu.be/XajaJYraODs")).toBeNull();
    expect(idProblem("youtube:XajaJYraODs", "https://www.youtube.com/watch?v=AAAAAAAAAAA")).toMatch(/must be/);
    expect(idProblem("youtube:short", "https://www.youtube.com/watch?v=short")).toMatch(/11/);
    expect(idProblem("myinstants:bruh", "https://www.myinstants.com/en/instant/bruh/")).toBeNull();
    expect(idProblem("myinstants:bruh", "https://www.myinstants.com/en/instant/other/")).not.toBeNull();
    expect(idProblem("freesound:60026", "https://cdn.freesound.org/previews/60/60026_71257-hq.mp3")).toBeNull();
    expect(idProblem("freesound:60026", "https://freesound.org/people/qubodup/sounds/60026/")).toBeNull();
    expect(idProblem("freesound:60026", "https://cdn.freesound.org/previews/60/60027_71257-hq.mp3")).not.toBeNull();
    expect(idProblem("wikimedia:427690", "https://upload.wikimedia.org/wikipedia/commons/8/85/Holst-_mars.ogg")).toBeNull();
    expect(idProblem("wikimedia:427690", "https://example.com/Holst-_mars.ogg")).not.toBeNull();
    expect(idProblem("user:anything", "https://example.com/a.mp3")).toBeNull();
    expect(idProblem("user:anything", "http://example.com/a.mp3")).toMatch(/https/);
  });

  it("finds timing outside the source", () => {
    expect(timingProblems(calm)).toEqual([]);
    expect(timingProblems({ ...calm, sourceRange: { start: 0, end: 181 } }).join(" ")).toMatch(/after the source/);
    expect(timingProblems({ ...calm, sections: [{ label: "main", start: 10, end: 30 }, { label: "outro", start: 20, end: 40 }] }).join(" ")).toMatch(/order/);
    expect(timingProblems({ ...calm, hitAt: 175 }).join(" ")).toMatch(/hitAt/);
    expect(timingProblems({ ...calm, sourceRange: undefined, hitAt: 175 })).toEqual([]);
  });

  it("refuses a save that clears a required field, mixes kinds, or leaves a new entry incomplete", () => {
    expect(patchProblems(calm, patch({ id: calm.id, title: null }), "music").join(" ")).toMatch(/title can't be cleared/);
    expect(patchProblems(calm, patch({ id: calm.id, hitAt: 3 }), "music").join(" ")).toMatch(/hitAt describes sound effects/);
    expect(patchProblems(null, patch({ id: "user:new", title: "New" }), "music").join(" ")).toMatch(/needs description, sourceUrl/);
    expect(patchProblems(null, patch({ id: "youtube:XajaJYraODs", title: "T", description: "D", sourceUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA" }), "music").join(" ")).toMatch(/must be/);
    expect(patchProblems(calm, patch({ id: calm.id, sourceRange: { start: 0, end: 500 } }), "music").join(" ")).toMatch(/after the source/);
    expect(patchProblems(calm, patch({ id: calm.id, sourceUrl: "https://www.youtube.com/watch?v=CCCCCCCCCCC" }), "music")).toEqual([]);
  });
});
