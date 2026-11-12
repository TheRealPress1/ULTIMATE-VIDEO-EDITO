/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import { AudioCatalogStore } from "./audio-catalog";
import { mainHandlers } from "./dapi/handlers";

import type { ToolInput } from "@diffusionstudio/dapi";
import type { MainContext } from "./dapi/handler";

const root = mkdtempSync(join(tmpdir(), "audio-catalog-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repoDocs = join(__dirname, "..", "..", "..", "docs");

const piece = {
  id: "youtube:AAAAAAAAAAA", title: "Calm Piece — Someone", description: "A slow piano bed for calm interviews and reflective stories, quiet enough to sit under any voice.",
  sourceUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA", durationSeconds: 180, rights: "copyrighted", verifiedAt: "2026-11-03",
  artist: "Someone", variant: "original", vocals: "none", moods: ["calm"], energy: 1, sourceRange: { start: 2, end: 170 },
};
const hit = {
  id: "freesound:60026", title: "Short airy whoosh", description: "A quick, breathy rush of air under half a second long, for fast text pops and quick cuts.",
  sourceUrl: "https://cdn.freesound.org/previews/60/60026_71257-hq.mp3", durationSeconds: 0.49, rights: "cc0", verifiedAt: "2026-11-03",
  category: "whoosh", align: "span", hitAt: 0.07, sourceRange: { start: 0.02, end: 0.49 },
};

let docs: string;
let personal: string;
let clock: number;
beforeEach(() => {
  const dir = mkdtempSync(join(root, "case-"));
  docs = join(dir, "docs");
  personal = join(dir, "userData", "audio-catalog");
  mkdirSync(join(docs, "reference", "catalogs"), { recursive: true });
  writeFileSync(join(docs, "reference", "catalogs", "music.json"), JSON.stringify({ version: 1, kind: "music", updated: "2026-11-03", entries: [piece] }));
  writeFileSync(join(docs, "reference", "catalogs", "sfx.json"), JSON.stringify({ version: 1, kind: "sfx", updated: "2026-11-03", entries: [hit] }));
  clock = Date.parse("2026-11-03T12:00:00Z");
});

const store = (dir: string | null = docs) => new AudioCatalogStore({ docsDir: dir, personalDir: personal, now: () => new Date(clock++) });
const call = (catalog: AudioCatalogStore, input: ToolInput<"audio_catalog">) => catalog.run(toolByName("audio_catalog").input.parse(input));
const file = (kind = "music") => join(personal, `${kind}.local.json`);
const onDisk = (kind = "music") => JSON.parse(readFileSync(file(kind), "utf8"));

describe("the audio catalog store", () => {
  it("lists the defaults at revision 0 before anything is saved, writing nothing", async () => {
    const result = await call(store(), { kind: "music" });
    expect(result).toMatchObject({ kind: "music", revision: 0, defaultsUpdated: "2026-11-03", total: 1, hiddenCount: 0, warnings: [] });
    expect(result.entries[0]).toMatchObject({ id: piece.id, origin: "default", download: { tool: "media_download", folder: "music" } });
    expect(result.entries[0]).not.toHaveProperty("description");
    expect(result.entries[0]).not.toHaveProperty("sourceUrl");
    expect(result.entries[0]!.download.url).toBe(piece.sourceUrl);
    expect(result.personalPath).toBe(file());
    expect(existsSync(personal)).toBe(false);
  });

  it("gets one entry with both layers, and says when an id is unknown", async () => {
    const result = await call(store(), { kind: "sfx", action: "get", id: hit.id });
    expect(result.entries).toEqual([]);
    expect(result.selected).toMatchObject({ id: hit.id, default: hit, personal: null, merged: { description: hit.description, download: { tool: "web_media_download", folder: "sfx" } } });
    await expect(call(store(), { kind: "sfx", action: "get", id: "freesound:1" })).rejects.toMatchObject({ code: "not-found" });
  });

  it("saves an override as the next revision, privately, keeping the previous file as .bak", async () => {
    const catalog = store();
    const first = await call(catalog, { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { preferred: true, notes: "Use for podcasts" } });
    expect(first.revision).toBe(1);
    expect(first.selected?.merged).toMatchObject({ preferred: true, notes: "Use for podcasts", origin: "overridden" });
    expect(onDisk()).toMatchObject({ version: 1, revision: 1, entries: [{ id: piece.id, preferred: true, notes: "Use for podcasts" }] });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file()}.bak`)).toBe(false);
    const second = await call(catalog, { kind: "music", action: "save", id: piece.id, expectedRevision: 1, fields: { notes: null, energy: 2 } });
    expect(second.revision).toBe(2);
    expect(onDisk().entries).toEqual([{ id: piece.id, preferred: true, notes: null, energy: 2 }]);
    expect(JSON.parse(readFileSync(`${file()}.bak`, "utf8")).revision).toBe(1);
    expect(statSync(`${file()}.bak`).mode & 0o777).toBe(0o600);
    expect(readdirSync(personal).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const listedNow = await call(catalog, { kind: "music", detail: "full" });
    expect(listedNow.entries[0]).toMatchObject({ preferred: true, energy: 2, overridden: ["energy", "preferred", "notes"] });
    expect(listedNow.entries[0]).not.toHaveProperty("notes");
  });

  it("refuses a stale revision without overwriting newer preferences", async () => {
    await call(store(), { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { hidden: true } });
    await expect(call(store(), { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { hidden: false } })).rejects.toMatchObject({ code: "busy" });
    expect(onDisk()).toMatchObject({ revision: 1, entries: [{ hidden: true }] });
    const hidden = await call(store(), { kind: "music" });
    expect(hidden).toMatchObject({ total: 0, hiddenCount: 1 });
    expect((await call(store(), { kind: "music", includeHidden: true })).total).toBe(1);
  });

  it("serializes concurrent saves, so exactly one of two racing on a revision wins", async () => {
    const catalog = store();
    const results = await Promise.allSettled([
      call(catalog, { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { energy: 2 } }),
      call(catalog, { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { energy: 3 } }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(onDisk()).toMatchObject({ revision: 1, entries: [{ energy: 2 }] });
  });

  it("adds a personal entry with its time, and refuses one without a description or with a mismatched id", async () => {
    const added = await call(store(), {
      kind: "music", action: "save", id: "user:my-intro", expectedRevision: 0,
      fields: { title: "My intro jingle", description: "The short jingle that opens every episode.", sourceUrl: "https://example.com/intro.mp3", rights: "royalty-free" },
    });
    expect(added.selected?.merged).toMatchObject({ origin: "personal", addedAt: "2026-11-03T12:00:00.000Z", download: { tool: "web_media_download" } });
    expect(added.total).toBe(2);
    await expect(call(store(), { kind: "music", action: "save", id: "user:other", expectedRevision: 1, fields: { title: "Only a title" } })).rejects.toThrow(/needs description, sourceUrl/);
    await expect(call(store(), {
      kind: "music", action: "save", id: "youtube:XajaJYraODs", expectedRevision: 1, fields: { title: "T", description: "D", sourceUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAB" },
    })).rejects.toMatchObject({ code: "invalid-input" });
    expect(onDisk().revision).toBe(1);
  });

  it("has a sound kept by its Freesound page fetched by the downloader, never by what the page shares", async () => {
    const page = "https://freesound.org/people/Kinoton/sounds/427823/";
    const added = await call(store(), {
      kind: "sfx", action: "save", id: "freesound:427823", expectedRevision: 0,
      fields: { title: "Long low whoosh", description: "A slow, deep rush of air for a title that drifts in.", sourceUrl: page, rights: "cc0" },
    });
    expect(added.selected?.merged?.download).toEqual({ tool: "media_download", url: page, folder: "sfx" });
    // A shipped effect moved to its page goes the same way.
    const moved = await call(store(), { kind: "sfx", action: "save", id: hit.id, expectedRevision: 1, fields: { sourceUrl: "https://freesound.org/people/qubodup/sounds/60026/" } });
    expect(moved.selected?.merged?.download).toMatchObject({ tool: "media_download", folder: "sfx" });
  });

  it("refuses timing outside the source and fields of the other kind", async () => {
    await expect(call(store(), { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { sourceRange: { start: 0, end: 400 } } })).rejects.toThrow(/after the source/);
    await expect(call(store(), { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { category: "whoosh" } })).rejects.toThrow(/describes sound effects/);
    await expect(call(store(), { kind: "sfx", action: "save", id: hit.id, expectedRevision: 0, fields: { hitAt: 0.6 } })).rejects.toThrow(/hitAt/);
    expect(existsSync(file())).toBe(false);
  });

  it("resets single fields back to the default, or the whole override", async () => {
    const catalog = store();
    await call(catalog, { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { energy: 3, notes: "x" } });
    const partial = await call(catalog, { kind: "music", action: "reset", id: piece.id, expectedRevision: 1, fieldNames: ["energy"] });
    expect(partial.selected?.merged).toMatchObject({ energy: 1, notes: "x" });
    expect(onDisk().entries).toEqual([{ id: piece.id, notes: "x" }]);
    const whole = await call(catalog, { kind: "music", action: "reset", id: piece.id, expectedRevision: 2, fieldNames: ["notes"] });
    expect(whole.revision).toBe(3);
    expect(onDisk().entries).toEqual([]);
    const nothing = await call(catalog, { kind: "music", action: "reset", id: piece.id, expectedRevision: 3 });
    expect(nothing.revision).toBe(3);
  });

  it("refuses text that is only invisible characters, so one save can't make the file unreadable", async () => {
    const catalog = store();
    // The call's own check refuses it, before the store sees it.
    expect(() => call(catalog, { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { title: "\u200b\u200b" } })).toThrow(/visible character/);
    expect(existsSync(file())).toBe(false);
    // Even past the schema, the store writes nothing the next read would call damaged.
    const unchecked = { action: "save", kind: "music", id: piece.id, expectedRevision: 0, fields: { notes: "" }, includeHidden: false, detail: "summary", limit: 60 } as const;
    await expect(catalog.run(unchecked as never)).rejects.toThrow(/would no longer read \(entries\.0\.notes/);
    expect(existsSync(file())).toBe(false);
    const saved = await call(catalog, { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { notes: "\u202eFor intros\u200b" } });
    expect(saved.selected?.personal).toEqual({ id: piece.id, notes: "For intros" });
    const after = await call(catalog, { kind: "music" });
    expect(after.personalError).toBeUndefined();
    expect(after.revision).toBe(1);
  });

  it("keeps a damaged personal file: lists the defaults with the error, refuses writes, and sets it aside only when asked", async () => {
    mkdirSync(personal, { recursive: true });
    writeFileSync(file(), "{ not json");
    const listedNow = await call(store(), { kind: "music" });
    expect(listedNow.personalError).toMatch(/isn't valid JSON/);
    expect(listedNow.warnings[0]).toMatch(/preferences aren't applied/);
    expect(listedNow.total).toBe(1);
    await expect(call(store(), { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { energy: 2 } })).rejects.toThrow(/discardDamaged/);
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
    const reset = await call(store(), { kind: "music", action: "reset", discardDamaged: true });
    expect(reset.revision).toBe(0);
    expect(reset.selected).toBeUndefined();
    expect(reset.warnings.join(" ")).toMatch(/set aside/);
    expect(existsSync(file())).toBe(false);
    const aside = readdirSync(personal).filter((name) => name.startsWith("music.local.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(personal, aside[0]!), "utf8")).toBe("{ not json");
  });

  it("tells how to set a damaged file aside, and leaves a readable one alone when asked to", async () => {
    mkdirSync(personal, { recursive: true });
    writeFileSync(file("sfx"), "[]");
    await expect(call(store(), { kind: "sfx", action: "save", id: hit.id, expectedRevision: 0, fields: { hidden: true } })).rejects.toThrow(/discardDamaged: true \(no id or revision needed\)/);
    await call(store(), { kind: "music", action: "save", id: piece.id, expectedRevision: 0, fields: { preferred: true } });
    const kept = await call(store(), { kind: "music", action: "reset", discardDamaged: true });
    expect(kept.revision).toBe(1);
    expect(kept.personalError).toBeUndefined();
    expect(kept.warnings.join(" ")).toMatch(/reads fine/);
    expect(onDisk().entries).toEqual([{ id: piece.id, preferred: true }]);
    expect(readdirSync(personal).some((name) => name.startsWith("music.local.corrupt-"))).toBe(false);
    // With an id and the revision, discardDamaged on a readable file is an ordinary reset.
    await call(store(), { kind: "music", action: "reset", id: piece.id, expectedRevision: 1, discardDamaged: true });
    expect(onDisk()).toMatchObject({ revision: 2, entries: [] });
  });

  it("reports a personal file of the wrong shape rather than guessing", async () => {
    mkdirSync(personal, { recursive: true });
    writeFileSync(file("sfx"), JSON.stringify({ version: 1, revision: -1, updatedAt: null, entries: [] }));
    expect((await call(store(), { kind: "sfx" })).personalError).toMatch(/catalog format at revision/);
  });

  it("keeps unknown keys on disk through a save", async () => {
    mkdirSync(personal, { recursive: true });
    writeFileSync(file(), JSON.stringify({ version: 1, revision: 4, updatedAt: null, entries: [{ id: piece.id, energy: 2, fromNewerApp: [1] }] }));
    await call(store(), { kind: "music", action: "save", id: piece.id, expectedRevision: 4, fields: { energy: 3 } });
    expect(onDisk().entries).toEqual([{ id: piece.id, energy: 3, fromNewerApp: [1] }]);
  });

  it("caps the personal file's entries and size", async () => {
    mkdirSync(personal, { recursive: true });
    const many = Array.from({ length: 500 }, (_, index) => ({ id: `user:e${index}`, title: "T", description: "D", sourceUrl: "https://example.com/a.mp3" }));
    writeFileSync(file(), JSON.stringify({ version: 1, revision: 1, updatedAt: null, entries: many }));
    await expect(call(store(), { kind: "music", action: "save", id: "user:one-more", expectedRevision: 1, fields: { title: "T", description: "D", sourceUrl: "https://example.com/b.mp3" } }))
      .rejects.toThrow(/at most 500/);
    const wordy = Array.from({ length: 450 }, (_, index) => ({
      id: `user:w${index}`, title: "T".repeat(120), description: "D".repeat(400), notes: "N".repeat(500), attribution: "A".repeat(300), sourceUrl: "https://example.com/a.mp3",
    }));
    writeFileSync(file(), JSON.stringify({ version: 1, revision: 1, updatedAt: null, entries: wordy }));
    await expect(call(store(), { kind: "music", action: "save", id: "user:w0", expectedRevision: 1, fields: { notes: "M".repeat(500) } })).rejects.toThrow(/KiB/);
    expect(JSON.parse(readFileSync(file(), "utf8")).revision).toBe(1);
  });

  it("credits a source from Blackout's own entries only, never from the personal layer", async () => {
    const catalog = store();
    expect(await catalog.credit(hit.sourceUrl)).toEqual({ kind: "sfx", id: hit.id, title: hit.title, rights: "cc0" });
    expect(await catalog.credit(`${piece.sourceUrl}#t=3`)).toMatchObject({ kind: "music", id: piece.id, rights: "copyrighted" });
    await call(catalog, { kind: "sfx", action: "save", id: "user:boom", expectedRevision: 0, fields: { title: "Boom", description: "Mine.", sourceUrl: "https://example.com/boom.mp3", rights: "cc0" } });
    expect(await catalog.credit("https://example.com/boom.mp3")).toBeNull();
    expect(await catalog.credit("not a url")).toBeNull();
    expect(await store(null).credit(hit.sourceUrl)).toBeNull();
    const real = new AudioCatalogStore({ docsDir: repoDocs, personalDir: personal });
    expect(await real.credit("https://upload.wikimedia.org/wikipedia/commons/8/85/Holst-_mars.ogg")).toMatchObject({ id: "wikimedia:427690", rights: "public-domain" });
  });

  it("lists personal entries alone, with a warning, when the defaults aren't installed", async () => {
    const result = await call(store(null), { kind: "music" });
    expect(result).toMatchObject({ total: 0, defaultsPath: null, defaultsUpdated: null });
    expect(result.warnings[0]).toMatch(/isn't installed/);
  });

  it("serves the bundled catalogs", async () => {
    const real = new AudioCatalogStore({ docsDir: repoDocs, personalDir: personal });
    const musicList = await call(real, { kind: "music", vocals: ["none"], energyMax: 2, limit: 5 });
    expect(musicList.entries.length).toBeGreaterThan(0);
    expect(musicList.entries.length).toBeLessThanOrEqual(5);
    expect(musicList.total).toBeGreaterThanOrEqual(musicList.entries.length);
    const safe = await call(real, { kind: "music", rights: ["cc0", "cc-by", "cc-by-sa", "royalty-free", "public-domain"] });
    expect(safe.total).toBeGreaterThanOrEqual(9);
    const whooshes = await call(real, { kind: "sfx", category: ["whoosh", "swipe"], maxDurationSeconds: 2 });
    expect(whooshes.entries.every((entry) => entry.hitAt !== undefined && entry.download.folder === "sfx")).toBe(true);
    // Every answer is what the published output schema promises, in both levels of detail.
    const output = toolByName("audio_catalog").output;
    for (const answer of [musicList, safe, whooshes, await call(real, { kind: "music", detail: "full", limit: 200 }), await call(real, { kind: "sfx", detail: "full", limit: 200 }), await call(real, { kind: "music", action: "get", id: "youtube:XajaJYraODs" })]) {
      expect(() => output.parse(answer)).not.toThrow();
    }
  });
});

describe("the audio_catalog handler", () => {
  const ctx = (audioCatalog?: AudioCatalogStore) => ({ signal: new AbortController().signal, logs: () => [], version: "0", window: {} as MainContext["window"], audioCatalog }) as MainContext;

  it("answers from the app's store, and says so when there is none", async () => {
    const args = toolByName("audio_catalog").input.parse({ kind: "sfx" });
    expect((await mainHandlers.audio_catalog(args, ctx(store()))).entries[0]?.id).toBe(hit.id);
    await expect(mainHandlers.audio_catalog(args, ctx())).rejects.toMatchObject({ code: "unsupported" });
  });
});
