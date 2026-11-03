/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectJobs } from "./index";
import { bankCategories, bankEntry, knobWords, runSoundEffects, sfxSlug, takeKey, takeName } from "./sound-effects";

import type { EarshotReply, EarshotService } from "./index";

let base: string;
let project: string;
let renders: Array<Record<string, unknown>>;
let fail: Error | null;
/** Renders wait for their signal instead of finishing. */
let hang: boolean;
let writes: string[];
let fake: EarshotService;

const meta = (args: Record<string, unknown>) => ({
  id: args.sound, seed: args.seed ?? 420116625, sr: 48000, dur_s: args.dur ?? 1.0561, onset_s: 0.0195, peak_s: args.apex ?? 0.1305, end_s: 0.681, peak_db: -1.0, lufs_m_max: -15.1,
  edits: args.dur ? { dur: { target: args.dur, method: "shape" } } : {},
  checks: { ok: true, warnings: [], notes: [], summary: `${String(args.sound)}: clean`, measures: { clicks: 0 } },
});

const rows = [
  { id: "whoosh_fast/crisp", category: "whoosh_fast", member: "crisp", type: "forge", dur_s: 1.0561, peak_s: 0.1305, onset_s: 0.0195, end_s: 0.681, kinds: ["whoosh.short"], knobs: { dur: "shape", apex: true, pitch: null, tonal: {} }, notes: "fast passes and cuts" },
  { id: "whoosh_fast/air", category: "whoosh_fast", member: "air", type: "forge", dur_s: 0.9, peak_s: 0.2, onset_s: 0.01, end_s: 0.7, kinds: ["whoosh.short"], knobs: { dur: "shape", apex: true, pitch: null }, notes: "fast passes and cuts" },
  { id: "pluck/kalimba", category: "pluck", member: "kalimba", type: "forge", dur_s: 1.4, peak_s: 0.004, onset_s: 0.0, end_s: 1.3, kinds: ["bell", "text"], knobs: { dur: "param", apex: false, pitch: { param: "f0", note: "C5", range_hz: [130.8, 2093] } }, notes: "a tuned kalimba voice" },
];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "earshot-sfx-")));
  project = join(base, "Launch");
  await mkdir(project, { recursive: true });
  renders = [];
  fail = null;
  hang = false;
  writes = [];
  const startWrite = (dir: string) => { writes.push(dir); return () => writes.push(`done ${dir}`); };
  fake = {
    privateDirs: [],
    noteContent: () => {},
    startWrite,
    renders: new ProjectJobs(startWrite, "The project was saved or moved while the sound effect rendered. Render it again in the project where it is now."),
    earshotVersion: async () => "0.4.0",
    check: vi.fn(async () => ({ ok: true, summary: "a.wav: clean", warnings: [], notes: [] })),
    call: vi.fn(async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<EarshotReply> => {
      if (tool === "sfx_list") {
        const matching = rows.filter((row) => (!args.category || row.category === args.category) && (!args.kind || row.kinds.some((kind) => kind.split(".")[0] === args.kind)));
        return { summary: `${matching.length} sounds in the bank forge_v2r6+fit1+pluck1`, json: { summary: `${matching.length} sounds in the bank forge_v2r6+fit1+pluck1`, version: "forge_v2r6+fit1+pluck1", sounds: matching } };
      }
      renders.push(args);
      if (fail) throw fail;
      // earshot makes the folder and writes the take, then answers.
      await mkdir(dirname(String(args.out)), { recursive: true });
      await writeFile(String(args.out), `RIFF take ${JSON.stringify({ ...args, out: undefined })}`);
      if (hang) await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      return { summary: `wrote ${String(args.out)}: ${String(args.sound)} seed 420116625: 1.056 s; checks: clean`, json: { summary: "…", file: args.out, meta: meta(args) } };
    }),
  } as unknown as EarshotService;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const render = (extra: Record<string, unknown> = {}) => runSoundEffects(fake, { id: "r", action: "render", dir: project, sound: "whoosh_fast/crisp", ...extra });

describe("takeName", () => {
  it("names a take by its sound, knobs and seed, so the same take keeps its name", () => {
    const plain = takeName({ sound: "whoosh_fast/crisp" });
    expect(plain).toMatch(/^whoosh-fast-crisp-[0-9a-f]{8}\.wav$/);
    expect(takeName({ sound: "whoosh_fast/crisp" })).toBe(plain);
    const others = [takeName({ sound: "whoosh_fast/crisp", dur: 0.8 }), takeName({ sound: "whoosh_fast/crisp", apex: 0.3 }), takeName({ sound: "whoosh_fast/crisp", seed: 7 }), takeName({ sound: "whoosh_fast/crisp", pitch: "E5" })];
    expect(new Set([plain, ...others]).size).toBe(5);
    expect(takeName({ sound: "pluck/kalimba", name: "Logo bell — Éclat" })).toMatch(/^logo-bell-eclat-[0-9a-f]{8}\.wav$/);
    expect(sfxSlug("///")).toBe("sfx");
    // `name` names the file, not the take.
    expect(takeKey({ sound: "pluck/kalimba" })).toBe(takeName({ sound: "pluck/kalimba", name: "a" }).slice(-12, -4));
    expect(takeName({ sound: "pluck/kalimba", name: "a" }).slice(-12)).toBe(takeName({ sound: "pluck/kalimba", name: "b" }).slice(-12));
  });
});

describe("render", () => {
  it("renders into assets/sfx, measures the take and credits it", async () => {
    const reply = await render();
    const name = takeName({ sound: "whoosh_fast/crisp" });
    expect(reply).toMatchObject({
      action: "render", version: "0.4.0", source: `assets/sfx/${name}`, path: join(project, "assets", "sfx", name), sound: "whoosh_fast/crisp", seed: 420116625,
      durationSeconds: 1.0561, onsetSeconds: 0.0195, peakSeconds: 0.1305, endSeconds: 0.681, peakDb: -1,
      audit: { ok: true, summary: "whoosh_fast/crisp: clean", warnings: [], notes: [] }, reused: false, creditsFile: join(project, "CREDITS.md"),
    });
    expect(reply.summary).toBe(`wrote ${join(project, "assets", "sfx", name)}: whoosh_fast/crisp seed 420116625: 1.056 s; checks: clean`);
    // earshot rendered into a temporary folder of its own, outside the project, with the extension soundfile needs; it is gone now.
    const out = String(renders[0]!.out);
    expect(out).toMatch(new RegExp(`/cutroom-sfx-[^/]+/${name.replace(/\./g, "\\.")}$`));
    expect(out.startsWith(project)).toBe(false);
    await expect(stat(dirname(out))).rejects.toThrow();
    expect(renders[0]).toMatchObject({ sound: "whoosh_fast/crisp", full: true });
    expect(renders[0]).not.toHaveProperty("dur");
    expect(await readdir(join(project, "assets", "sfx"))).toEqual([name]);
    expect(writes).toEqual([project, `done ${project}`]);

    const ledger = JSON.parse(await readFile(join(project, ".cutroom", "web-media.json"), "utf8"));
    expect(ledger.items).toEqual([expect.objectContaining({
      file: `assets/sfx/${name}`, kind: "audio", mimeType: "audio/wav", title: "earshot bank whoosh_fast/crisp", fileUrl: expect.stringContaining("github.com/Leonxlnx/earshot/tree/591fa3e"),
      license: expect.objectContaining({ code: "mit", name: "MIT License", verified: true, commercialUse: true, modificationsAllowed: true }),
      attribution: "earshot bank whoosh_fast/crisp, v0.4.0, MIT",
    })]);
    const credits = await readFile(join(project, "CREDITS.md"), "utf8");
    expect(credits).toContain("earshot bank whoosh\\_fast/crisp");
    expect(credits).toContain("License: MIT License (<https://opensource.org/license/mit>).");
  });

  it("reuses the file for the same take and makes a new one for other knobs", async () => {
    const first = await render();
    const again = await render();
    expect(again).toMatchObject({ reused: true, path: first.action === "render" ? first.path : "" });
    const shaped = await render({ dur: 0.8, apex: 0.32, seed: 7 });
    expect(renders[2]).toMatchObject({ sound: "whoosh_fast/crisp", dur: 0.8, apex: 0.32, seed: 7 });
    expect(shaped).toMatchObject({ reused: false, seed: 7, durationSeconds: 0.8, peakSeconds: 0.32, edits: { dur: { target: 0.8, method: "shape" } } });
    expect((await readdir(join(project, "assets", "sfx"))).sort()).toHaveLength(2);
    const ledger = JSON.parse(await readFile(join(project, ".cutroom", "web-media.json"), "utf8"));
    expect(ledger.items).toHaveLength(2);
  });

  it("reuses the same take asked for under another name: one file, and src and path agree", async () => {
    const first = await render({ name: "Logo whoosh" });
    const again = await render({ name: "Other whoosh" });
    const file = `logo-whoosh-${takeKey({ sound: "whoosh_fast/crisp" })}.wav`;
    expect(first).toMatchObject({ reused: false, source: `assets/sfx/${file}`, path: join(project, "assets", "sfx", file) });
    expect(again).toMatchObject({ reused: true, source: `assets/sfx/${file}`, path: join(project, "assets", "sfx", file) });
    expect(await readdir(join(project, "assets", "sfx"))).toEqual([file]);
    const ledger = JSON.parse(await readFile(join(project, ".cutroom", "web-media.json"), "utf8"));
    expect(ledger.items.map((item: { file: string }) => item.file)).toEqual([`assets/sfx/${file}`]);
  });

  it("stops a render when its project is saved or moved, and writes nothing into the folder", async () => {
    hang = true;
    const pending = render();
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    fake.renders.cancel(project);
    // A write into the project until it has stopped, so the move waits for it.
    expect(writes).toEqual([project]);
    await expect(pending).rejects.toMatchObject({ code: "no-project", message: expect.stringContaining("saved or moved while the sound effect rendered") });
    expect(writes).toEqual([project, `done ${project}`]);
    expect(await readdir(join(project, "assets", "sfx"))).toEqual([]);
    await expect(stat(join(project, ".cutroom"))).rejects.toThrow();
    await expect(stat(join(project, "CREDITS.md"))).rejects.toThrow();
    await expect(stat(dirname(String(renders[0]!.out)))).rejects.toThrow();
    // Other projects' renders go on.
    hang = false;
    const elsewhere = join(base, "Other");
    await mkdir(elsewhere);
    const pendingElsewhere = runSoundEffects(fake, { id: "r2", action: "render", dir: elsewhere, sound: "whoosh_fast/crisp" });
    fake.renders.cancel(project);
    await expect(pendingElsewhere).resolves.toMatchObject({ reused: false });
  });

  it("stops a render at once when Cutroom quits, its temporary take removed before anything else runs", async () => {
    hang = true;
    const pending = render();
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    const work = dirname(String(renders[0]!.out));
    expect(fake.renders.holds(work)).toBe(true);
    fake.renders.dispose();
    // Synchronously: the app is gone before the render's own cleanup would run.
    await expect(stat(work)).rejects.toThrow();
    await expect(pending).rejects.toMatchObject({ code: "canceled", message: "Cutroom quit while the sound effect rendered." });
    expect(await readdir(join(project, "assets", "sfx"))).toEqual([]);
    await expect(stat(join(project, "CREDITS.md"))).rejects.toThrow();
    expect(fake.renders.holds(work)).toBe(false);
  });

  it("leaves nothing behind when earshot refuses", async () => {
    fail = Object.assign(new Error("unknown sound id 'whoosh_fast/cripsy'. Did you mean whoosh_fast/crisp?"), { code: "invalid-input" });
    await expect(render({ sound: "whoosh_fast/cripsy" })).rejects.toThrow("Did you mean whoosh_fast/crisp?");
    expect(await readdir(join(project, "assets", "sfx"))).toEqual([]);
    await expect(readFile(join(project, "CREDITS.md"))).rejects.toThrow();
  });

  it("refuses an assets/sfx that leads outside the project, and a missing project", async () => {
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(project, "assets"), { recursive: true });
    await symlink(elsewhere, join(project, "assets", "sfx"));
    await expect(render()).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("leads outside the project") });
    expect(renders).toEqual([]);
    await expect(runSoundEffects(fake, { id: "r", action: "render", dir: join(base, "gone"), sound: "whoosh_fast/crisp" })).rejects.toMatchObject({ code: "no-project" });
  });

  it("refuses an assets/sfx that leads into one of the project's protected folders", async () => {
    await mkdir(join(project, ".cutroom"), { recursive: true });
    await mkdir(join(project, "assets"), { recursive: true });
    await symlink("../.cutroom", join(project, "assets", "sfx"));
    await expect(render()).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("The project's assets/sfx folder leads into .cutroom") });
    expect(renders).toEqual([]);
  });
});

describe("list", () => {
  it("lists the bank by category; a filter adds each sound's times and knobs", async () => {
    const all = await runSoundEffects(fake, { id: "l", action: "list" });
    expect(all).toEqual({
      action: "list", version: "0.4.0", bank: "forge_v2r6+fit1+pluck1",
      summary: "3 sounds in the bank forge_v2r6+fit1+pluck1, in 2 categories. Pass a category or a kind for each sound's length, onset, peak and knobs.",
      categories: [
        { category: "whoosh_fast", count: 2, kinds: ["whoosh.short"], use: "fast passes and cuts", ids: ["whoosh_fast/crisp", "whoosh_fast/air"] },
        { category: "pluck", count: 1, kinds: ["bell", "text"], use: "a tuned kalimba voice", ids: ["pluck/kalimba"] },
      ],
    });
    const whooshes = await runSoundEffects(fake, { id: "l", action: "list", kind: "whoosh" });
    expect(fake.call).toHaveBeenLastCalledWith("sfx_list", { kind: "whoosh", full: true }, undefined, expect.any(Number));
    expect(whooshes.action === "list" && whooshes.sounds).toEqual([
      { id: "whoosh_fast/crisp", category: "whoosh_fast", member: "crisp", type: "forge", durationSeconds: 1.0561, onsetSeconds: 0.0195, peakSeconds: 0.1305, endSeconds: 0.681, kinds: ["whoosh.short"], knobs: ["dur shape", "apex"] },
      { id: "whoosh_fast/air", category: "whoosh_fast", member: "air", type: "forge", durationSeconds: 0.9, onsetSeconds: 0.01, peakSeconds: 0.2, endSeconds: 0.7, kinds: ["whoosh.short"], knobs: ["dur shape", "apex"] },
    ]);
  });

  it("puts earshot's knobs in its own words", () => {
    expect(knobWords({ dur: "param", apex: false, pitch: { note: "F#7 -27c", range_hz: [1455, 11518.9] } })).toEqual(["dur param", "pitch F#7 -27c (1455-11519 Hz)"]);
    expect(knobWords({})).toEqual([]);
    expect(bankEntry({ id: "x/y", category: "x" })).toEqual({ id: "x/y", category: "x", kinds: [], knobs: [] });
    expect(bankCategories([])).toEqual([]);
  });
});

describe("check", () => {
  it("resolves the file like the other sound tools and audits it", async () => {
    await mkdir(join(project, "assets", "sfx"), { recursive: true });
    await writeFile(join(project, "assets", "sfx", "a.wav"), "wav");
    const reply = await runSoundEffects(fake, { id: "c", action: "check", dir: project, path: "sfx/a.wav", role: "hit" });
    expect(fake.check).toHaveBeenCalledWith(join(project, "assets", "sfx", "a.wav"), { category: undefined, role: "hit" }, undefined);
    expect(reply).toEqual({ action: "check", version: "0.4.0", summary: "a.wav: clean", path: join(project, "assets", "sfx", "a.wav"), audit: { ok: true, summary: "a.wav: clean", warnings: [], notes: [] } });
    await expect(runSoundEffects(fake, { id: "c", action: "check", dir: null, path: "sfx/a.wav" })).rejects.toMatchObject({ code: "no-project" });
  });
});
