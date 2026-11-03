/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalog, toolByName } from "../catalog";
import { toolJsonSchemas } from "../json-schema";
import {
  AudioCatalogFile, CATALOG_PATCH_FIELDS, CatalogId, CatalogMood, CatalogPatch, CatalogUse, MusicCatalogEntry, PersonalCatalogFile, SfxCategory, SfxCatalogEntry, audioCatalog,
} from "./audio-catalog";

const music = {
  id: "youtube:XajaJYraODs",
  title: "Blinding Lights (Instrumental) — The Weeknd",
  description: "A driving synth-pop instrumental with a bright arpeggio over a fast drum machine pulse; suits night drives, retro edits and fast montages.",
  sourceUrl: "https://www.youtube.com/watch?v=XajaJYraODs",
  durationSeconds: 203.5,
  rights: "copyrighted",
  verifiedAt: "2026-11-03",
  artist: "The Weeknd",
  variant: "instrumental",
  vocals: "none",
  moods: ["retro", "upbeat"],
  energy: 4,
};

describe("audio_catalog contract", () => {
  it("is a main tool listed right after editing_style", () => {
    expect(toolByName("audio_catalog").environment).toBe("main");
    const names = catalog.map((tool) => tool.name);
    expect(names.indexOf("audio_catalog")).toBe(names.indexOf("editing_style") + 1);
    expect(audioCatalog.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    const { inputSchema, outputSchema } = toolJsonSchemas(audioCatalog);
    expect(inputSchema.required).toEqual(["kind"]);
    expect(outputSchema.type).toBe("object");
  });

  it("accepts ids only in their documented forms", () => {
    for (const id of ["youtube:XajaJYraODs", "freesound:351256", "wikimedia:3432550", "openverse:eab8a6e2-0ac8", "myinstants:bruh-sound-effect-26614", "user:my-intro"]) {
      expect(CatalogId.safeParse(id).success, id).toBe(true);
    }
    for (const id of ["XajaJYraODs", "spotify:abc", "youtube:", "user:has space", "youtube:a/b", `user:${"x".repeat(129)}`]) {
      expect(CatalogId.safeParse(id).success, id).toBe(false);
    }
  });

  it("applies list defaults and keeps filters to list and to their kind", () => {
    const input = audioCatalog.input;
    expect(input.parse({ kind: "music" })).toEqual({ action: "list", kind: "music", includeHidden: false, detail: "summary", limit: 60 });
    expect(input.parse({ kind: "music", moods: ["calm"], vocals: ["none"], energyMax: 2 })).toMatchObject({ moods: ["calm"], vocals: ["none"] });
    expect(input.parse({ kind: "sfx", category: ["whoosh"], maxDurationSeconds: 2 })).toMatchObject({ category: ["whoosh"] });
    for (const invalid of [
      {}, { kind: "podcast" }, { kind: "music", category: ["whoosh"] }, { kind: "sfx", moods: ["calm"] }, { kind: "sfx", vocals: ["none"] },
      { kind: "music", action: "get", id: "youtube:XajaJYraODs", moods: ["calm"] }, { kind: "music", energyMin: 4, energyMax: 2 },
      { kind: "music", energyMin: 0 }, { kind: "music", limit: 0 }, { kind: "music", limit: 201 }, { kind: "music", moods: ["sad"] },
      { kind: "music", query: "x".repeat(121) },
    ]) expect(input.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  });

  it("requires an id for get, fields and a revision for save, and an id and a revision for reset unless discarding a damaged file", () => {
    const input = audioCatalog.input;
    const id = "youtube:XajaJYraODs";
    expect(input.safeParse({ kind: "music", action: "get" }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "get", id }).success).toBe(true);
    expect(input.safeParse({ kind: "music", action: "save", id, fields: { preferred: true } }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "save", id, expectedRevision: 0 }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "save", id, fields: { preferred: true }, expectedRevision: 0 }).success).toBe(true);
    expect(input.safeParse({ kind: "music", action: "reset", id }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "reset", id, expectedRevision: 2, fieldNames: ["sourceRange"] }).success).toBe(true);
    expect(input.safeParse({ kind: "music", action: "reset", id, discardDamaged: true }).success).toBe(true);
    // Setting a damaged file aside concerns the whole file, so it needs no entry id either.
    expect(input.safeParse({ kind: "music", action: "reset", discardDamaged: true }).success).toBe(true);
    expect(input.safeParse({ kind: "music", action: "reset", expectedRevision: 0 }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "reset", discardDamaged: false, expectedRevision: 0 }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "list", fields: { hidden: true } }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "save", id, expectedRevision: 0, fields: { hidden: true }, fieldNames: ["hidden"] }).success).toBe(false);
    expect(input.safeParse({ kind: "music", action: "reset", id, expectedRevision: 0, fieldNames: ["colour"] }).success).toBe(false);
  });

  it("tells null (clear) from absent (inherit) in a saved patch and refuses unknown fields there", () => {
    const fields = audioCatalog.input.parse({ kind: "music", action: "save", id: music.id, expectedRevision: 0, fields: { sourceRange: null, notes: "  my intro track " } }).fields!;
    expect(fields).toEqual({ sourceRange: null, notes: "my intro track" });
    expect("energy" in fields).toBe(false);
    expect(audioCatalog.input.safeParse({ kind: "music", action: "save", id: music.id, expectedRevision: 0, fields: { colour: "red" } }).success).toBe(false);
    expect(audioCatalog.input.safeParse({ kind: "music", action: "save", id: music.id, expectedRevision: 0, fields: { sourceRange: { start: 9, end: 3 } } }).success).toBe(false);
    expect(audioCatalog.input.safeParse({ kind: "music", action: "save", id: music.id, expectedRevision: 0, fields: { sourceUrl: "http://example.com/a.mp3" } }).success).toBe(false);
    expect(CATALOG_PATCH_FIELDS).toContain("hidden");
    expect(CATALOG_PATCH_FIELDS).not.toContain("id");
  });

  it("cleans control and invisible characters out of text, and refuses text that is nothing else", () => {
    const save = (fields: Record<string, unknown>) => audioCatalog.input.safeParse({ kind: "music", action: "save", id: music.id, expectedRevision: 0, fields });
    const cleaned = save({ notes: "line one\nline\u0000 two\u202e", tags: ["ok\u0007", "lo-fi"], title: "\u200bA title\u2066" });
    expect(cleaned.success && cleaned.data.fields).toEqual({ notes: "line one line two", tags: ["ok", "lo-fi"], title: "A title" });
    for (const blank of ["\u200b\u200b", "\u202e", "\u0007\u0000", " \ufeff\t", "\u2066\u2069"]) {
      expect(save({ title: blank }).success, JSON.stringify(blank)).toBe(false);
      expect(save({ notes: blank }).success, JSON.stringify(blank)).toBe(false);
      expect(save({ tags: ["fine", blank] }).success, JSON.stringify(blank)).toBe(false);
    }
    // The stored file is read through the same rules, so what a save accepts reads back.
    expect(PersonalCatalogFile.safeParse({ version: 1, revision: 1, updatedAt: null, entries: [{ id: music.id, title: "\u200b" }] }).success).toBe(false);
  });

  it("refuses URLs that hold control, bidi or zero-width characters", () => {
    const save = (fields: Record<string, unknown>) => audioCatalog.input.safeParse({ kind: "music", action: "save", id: "user:mine", expectedRevision: 0, fields });
    expect(save({ sourceUrl: "https://example.com/a.mp3" }).success).toBe(true);
    expect(save({ sourceUrl: "  https://example.com/a%E2%80%AE.mp3 " }).success).toBe(true);
    for (const url of [
      "https://example.com/a\u0007b.mp3", "https://example.com/a\u202eb.mp3", "https://exa\u200bmple.com/a.mp3", "https://example.com/\u2066a.mp3",
      "https://example.com/a\u0085.mp3", "https://example.com/a\ufeff.mp3", "https://example.com/a b.mp3", "http://example.com/a.mp3",
    ]) {
      expect(save({ sourceUrl: url }).success, JSON.stringify(url)).toBe(false);
      expect(save({ pageUrl: url }).success, JSON.stringify(url)).toBe(false);
    }
  });

  it("takes addedAt only as an ISO time", () => {
    const save = (addedAt: string) => audioCatalog.input.safeParse({ kind: "music", action: "save", id: "user:mine", expectedRevision: 0, fields: { addedAt } }).success;
    expect(save("2026-11-03T12:00:00.000Z")).toBe(true);
    expect(save("yesterday\u202e")).toBe(false);
  });

  it("publishes compact schemas while still checking every saved value", () => {
    const { inputSchema, outputSchema } = toolJsonSchemas(audioCatalog);
    // Every session pays for these: the whole entry spelled out for each place it appears cost about 34,000 characters.
    expect(JSON.stringify(inputSchema).length).toBeLessThan(5500);
    expect(JSON.stringify(outputSchema).length).toBeLessThan(5500);
    const fields = (inputSchema.properties as Record<string, { propertyNames?: { enum?: string[] } }>).fields!;
    expect(fields.propertyNames?.enum).toEqual(CATALOG_PATCH_FIELDS);
    const save = (value: Record<string, unknown>) => audioCatalog.input.safeParse({ kind: "music", action: "save", id: music.id, expectedRevision: 0, fields: value }).success;
    for (const bad of [{ moods: ["sad"] }, { energy: 6 }, { sections: [{ label: "verse", start: 0, end: 1 }] }, { rights: "free" }, { hidden: "yes" }]) expect(save(bad), JSON.stringify(bad)).toBe(false);
    expect(save({ moods: ["calm"], energy: 2, hidden: true, sourceRange: null })).toBe(true);
  });

  it("keeps unknown keys of a stored patch so a newer app's fields survive", () => {
    expect(CatalogPatch.parse({ id: music.id, preferred: true, futureField: 3 })).toEqual({ id: music.id, preferred: true, futureField: 3 });
    expect(PersonalCatalogFile.safeParse({ version: 1, revision: 0, updatedAt: null, entries: [] }).success).toBe(true);
    expect(PersonalCatalogFile.safeParse({ version: 2, revision: 0, updatedAt: null, entries: [] }).success).toBe(false);
  });

  it("requires the filterable fields on every default entry and refuses typos", () => {
    expect(MusicCatalogEntry.safeParse(music).success).toBe(true);
    for (const key of ["artist", "variant", "vocals", "moods", "energy", "rights", "verifiedAt", "durationSeconds"]) {
      const { [key]: _omitted, ...rest } = music as Record<string, unknown>;
      expect(MusicCatalogEntry.safeParse(rest).success, key).toBe(false);
    }
    expect(MusicCatalogEntry.safeParse({ ...music, mood: ["calm"] }).success).toBe(false);
    expect(MusicCatalogEntry.safeParse({ ...music, description: "Too short." }).success).toBe(false);
    expect(MusicCatalogEntry.safeParse({ ...music, energy: 6 }).success).toBe(false);
    const sfx = { ...music, id: "freesound:351256", title: "Deep whoosh", sourceUrl: "https://cdn.freesound.org/previews/351/351256_2247456-hq.mp3", durationSeconds: 1.2, rights: "cc0", category: "whoosh", hitAt: 0.4 };
    const { artist: _a, variant: _v, vocals: _vo, moods: _m, energy: _e, ...effect } = sfx;
    expect(SfxCatalogEntry.safeParse(effect).success).toBe(true);
    expect(SfxCatalogEntry.safeParse(sfx).success).toBe(false);
    expect(AudioCatalogFile.safeParse({ version: 1, kind: "sfx", updated: "2026-11-03", entries: [effect] }).success).toBe(true);
    expect(AudioCatalogFile.safeParse({ version: 1, kind: "music", updated: "2026-11-03", entries: [effect] }).success).toBe(false);
  });

  it("publishes the documented vocabularies", () => {
    expect(CatalogMood.options).toHaveLength(24);
    expect(CatalogUse.options).toHaveLength(22);
    expect(SfxCategory.options).toHaveLength(19);
    expect(() => z.toJSONSchema(audioCatalog.input, { io: "input" })).not.toThrow();
  });
});
