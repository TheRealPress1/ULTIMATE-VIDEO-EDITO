/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Main's half of `sound_effects`: the bank listing, the audit, and takes
// rendered into the open project's `assets/sfx/` under a name made from the
// sound, its knobs and its seed, so asking for the same take again finds the
// file already there (under whatever `name` it first got). earshot renders
// into a temporary folder outside the project; the take lands in the project
// only once it is whole, as a write a save or move waits for, and a save or
// move asked for before then stops the render (see `ProjectJobs`). The
// renderer imports what lands here into the live library. Each take is
// credited in the project's CREDITS.md through the web media ledger, as an
// original earshot bank sound under MIT.

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, realpathSync } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DapiError } from "@diffusionstudio/dapi";
import { TEMP_PREFIX } from "../../atomic";
import { libraryFolderRefusal } from "../../dapi/output-policy";
import { withProjectLock } from "../../project-write-transactions";
import { CREDITS_FILE, readLedger, writeCredits, writeLedger } from "../../web-media-ledger";
import { RENDER_TEMP_PREFIX } from "./cache";
import { audit } from "./index";
import { resolveSoundPath } from "./paths";
import { EARSHOT } from "./pins";

import type { WebMediaLedgerItem } from "../../web-media-types";
import type { EarshotService } from "./index";
import type { SoundAudit, SoundBankCategory, SoundBankEntry, SoundEffectsReply, SoundEffectsRequest } from "./types";

/** Where takes live in the library: `assets/sfx/` on disk. */
export const SFX_FOLDER = "sfx";

const LIST_TIMEOUT_MS = 2 * 60 * 1000;
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

const SLUG_MAX = 48;

/** A short ASCII file stem. */
export function sfxSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "") || "sfx";
}

type RenderRequest = Extract<SoundEffectsRequest, { action: "render" }>;

type TakeRequest = Pick<RenderRequest, "sound" | "dur" | "apex" | "pitch" | "seed">;

/** What makes a take the same take: the sound, every knob, the seed and the earshot commit (never `name`), as 8 hex digits. */
export function takeKey(request: TakeRequest): string {
  const key = JSON.stringify({ sound: request.sound, dur: request.dur ?? null, apex: request.apex ?? null, pitch: request.pitch ?? null, seed: request.seed ?? null, earshot: EARSHOT.commit });
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * `<name or id>-<key>.wav`: the same take keeps its key, any other take gets
 * its own. The same take asked for under another `name` reuses the file it
 * already has (see `land`).
 */
export function takeName(request: TakeRequest & Pick<RenderRequest, "name">): string {
  return `${sfxSlug(request.name ?? request.sound)}-${takeKey(request)}.wav`;
}

const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** earshot's knobs dict (`knobs.describe`) as it writes them in its own listing: `dur shape`, `apex`, `pitch F#7 -27c`. */
export function knobWords(knobs: Record<string, unknown>): string[] {
  const words: string[] = [];
  if (knobs.dur !== undefined && knobs.dur !== null && knobs.dur !== false) words.push(typeof knobs.dur === "string" ? `dur ${knobs.dur}` : "dur");
  if (knobs.apex) words.push("apex");
  const pitch = record(knobs.pitch);
  if (knobs.pitch && Object.keys(pitch).length) {
    const range = Array.isArray(pitch.range_hz) && pitch.range_hz.length === 2 ? ` (${pitch.range_hz.map((hz) => Math.round(Number(hz))).join("-")} Hz)` : "";
    words.push(`pitch${typeof pitch.note === "string" ? ` ${pitch.note}` : ""}${range}`);
  }
  return words;
}

/** One row of earshot's `sfx_list`, in the tool's names. */
export function bankEntry(row: Record<string, unknown>): SoundBankEntry {
  const entry: SoundBankEntry = {
    id: String(row.id ?? ""),
    category: String(row.category ?? ""),
    kinds: Array.isArray(row.kinds) ? row.kinds.filter((kind): kind is string => typeof kind === "string") : [],
    knobs: knobWords(record(row.knobs)),
  };
  const optional: Array<[keyof SoundBankEntry, unknown]> = [
    ["member", text(row.member)], ["type", text(row.type)],
    ["durationSeconds", number(row.dur_s)], ["onsetSeconds", number(row.onset_s)], ["peakSeconds", number(row.peak_s)], ["endSeconds", number(row.end_s)],
    ["notes", text(row.notes)],
  ];
  for (const [key, value] of optional) if (value !== undefined) (entry as Record<string, unknown>)[key] = value;
  return entry;
}

/**
 * The bank by category: its ids, cue kinds and use. Every sound's details
 * for the whole bank would run past what an agent's context takes (about
 * 100 KB for 252 sounds), so those come with a category or kind filter.
 */
export function bankCategories(entries: SoundBankEntry[]): SoundBankCategory[] {
  const byCategory = new Map<string, SoundBankCategory>();
  for (const entry of entries) {
    let category = byCategory.get(entry.category);
    if (!category) byCategory.set(entry.category, (category = { category: entry.category, count: 0, kinds: [], ...(entry.notes ? { use: entry.notes } : {}), ids: [] }));
    category.count++;
    category.ids.push(entry.id);
    for (const kind of entry.kinds) if (!category.kinds.includes(kind)) category.kinds.push(kind);
  }
  return [...byCategory.values()];
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * `assets/sfx` in the project, made a level at a time (so a project folder
 * that has gone is never made again), as its real path, which must stay
 * inside the project and out of its protected folders.
 */
async function sfxDir(dir: string): Promise<string> {
  if (!isAbsolute(dir)) throw new DapiError("no-project", "No project open — open one first.");
  const root = await realpath(dir).catch(() => null);
  if (!root || !(await stat(root)).isDirectory()) throw new DapiError("no-project", "The open project's folder is missing. Open the project again.");
  const folder = join(dir, "assets", SFX_FOLDER);
  for (const level of [join(dir, "assets"), folder]) {
    await mkdir(level).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
  const real = await realpath(folder);
  const refusal = libraryFolderRefusal(root, real, `assets/${SFX_FOLDER}`);
  if (refusal) throw new DapiError("invalid-input", refusal);
  return real;
}

/** The project's credit for a bank take, in the web media ledger CREDITS.md is rebuilt from. */
async function credit(service: EarshotService, dir: string, item: WebMediaLedgerItem): Promise<string> {
  return withProjectLock(dir, async () => {
    const ledger = await readLedger(dir);
    if (!ledger.items.some((other) => other.file === item.file && other.sha256 === item.sha256)) {
      ledger.items = ledger.items.filter((other) => other.file !== item.file);
      ledger.items.push(item);
      await writeLedger(dir, ledger);
    }
    return writeCredits(dir, ledger, service.noteContent);
  });
}

export const MIT_LICENSE = {
  code: "mit",
  name: "MIT License",
  url: "https://opensource.org/license/mit",
  attributionRequired: false,
  shareAlike: false,
  commercialUse: true,
  modificationsAllowed: true,
  verified: true,
} as const;

function tempRoot(): string {
  try { return realpathSync.native(tmpdir()); } catch { return tmpdir(); }
}

/** A plain file in `folder` that is this take under another name, if there is one. */
async function sameTake(folder: string, key: string): Promise<string | null> {
  const names = (await readdir(folder)).filter((entry) => entry.endsWith(`-${key}.wav`) && !entry.startsWith(TEMP_PREFIX)).sort();
  for (const entry of names) if ((await lstat(join(folder, entry)).catch(() => null))?.isFile()) return entry;
  return null;
}

/**
 * Puts the rendered take into `folder` as `name`, or finds it there already
 * (also under another name: the library would hand back that file anyway, its
 * content being the same). A new take is copied in beside its place and linked
 * into it, so it never replaces a file and is never seen half written.
 */
async function land(rendered: string, folder: string, name: string, key: string, hold: (path: string) => void): Promise<{ file: string; reused: boolean }> {
  const there = await lstat(join(folder, name)).catch(() => null);
  if (there?.isFile()) return { file: name, reused: true };
  if (there) throw new DapiError("invalid-input", `assets/sfx/${name} exists and isn't a plain file. Remove it and render again.`);
  const other = await sameTake(folder, key);
  if (other) return { file: other, reused: true };
  // The prefix keeps the project watcher and a duplicate's copy off it.
  const staged = join(folder, `${TEMP_PREFIX}${name.replace(/\.wav$/, "")}-${randomUUID().slice(0, 8)}.wav`);
  hold(staged);
  try {
    await copyFile(rendered, staged, fsConstants.COPYFILE_EXCL);
    try {
      await link(staged, join(folder, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { file: name, reused: true };
      // A volume without hard links.
      await rename(staged, join(folder, name));
    }
    return { file: name, reused: false };
  } finally {
    await rm(staged, { force: true });
  }
}

async function render(service: EarshotService, request: RenderRequest, signal: AbortSignal | undefined): Promise<SoundEffectsReply> {
  await sfxDir(request.dir);
  const key = takeKey(request);
  const name = takeName(request);
  const job = service.renders.start(request.dir, signal);
  const work = await mkdtemp(join(tempRoot(), RENDER_TEMP_PREFIX)).catch((error: unknown) => { job.done(); throw error; });
  // Quitting removes it at once; a cache sweep leaves it while the render waits for its turn.
  job.hold(work);
  try {
    // `.wav` tells earshot the format; nothing of earshot's goes into the project.
    const rendered = join(work, name);
    const args: Record<string, unknown> = { sound: request.sound, out: rendered, full: true };
    for (const field of ["seed", "dur", "apex", "pitch"] as const) if (request[field] !== undefined) args[field] = request[field];
    const reply = await service.call("sfx_render", args, job.signal, RENDER_TIMEOUT_MS);
    const meta = record(reply.json?.meta);

    // Landing and crediting are a write into the project, which a save, move or duplicate waits for.
    const landing = service.startWrite(request.dir);
    try {
      // A save or move asked for before this point stopped the render: the folder is going, or gone.
      job.signal.throwIfAborted();
      const folder = await sfxDir(request.dir);
      const { file, reused } = await land(rendered, folder, name, key, job.hold);
      const target = join(folder, file);
      const source = `assets/${SFX_FOLDER}/${file}`;
      const version = await service.earshotVersion();
      const info = await stat(target);
      const checks = meta.checks ? audit(record(meta.checks) as Partial<SoundAudit>) : undefined;
      let creditsFile: string | undefined;
      try {
        creditsFile = await credit(service, request.dir, {
          file: source,
          sha256: await sha256Of(target),
          bytes: info.size,
          kind: "audio",
          mimeType: "audio/wav",
          title: `earshot bank ${request.sound}${request.seed !== undefined ? ` (seed ${request.seed})` : ""}`,
          creator: `earshot ${version} sound bank (Leon Lin)`,
          pageUrl: EARSHOT.repository,
          fileUrl: `${EARSHOT.repository}/tree/${EARSHOT.commit}/earshot/forge/bank`,
          requestedUrl: `earshot:bank/${request.sound}`,
          license: MIT_LICENSE,
          attribution: `earshot bank ${request.sound}, v${version}, MIT`,
          downloadedAt: new Date().toISOString(),
        });
      } catch (error) {
        // The take is fine without its credit line; say so in the log, not as a failure.
        console.warn(`[earshot] couldn't credit ${source}: ${(error as Error).message}`);
        creditsFile = undefined;
      }
      return {
        action: "render",
        version,
        summary: reply.summary.split(rendered).join(target),
        source,
        path: target,
        sound: request.sound,
        seed: number(meta.seed) ?? request.seed ?? 0,
        durationSeconds: number(meta.dur_s) ?? 0,
        onsetSeconds: number(meta.onset_s) ?? 0,
        peakSeconds: number(meta.peak_s) ?? 0,
        endSeconds: number(meta.end_s) ?? 0,
        ...(number(meta.peak_db) !== undefined ? { peakDb: number(meta.peak_db)! } : {}),
        ...(meta.edits && Object.keys(record(meta.edits)).length ? { edits: record(meta.edits) } : {}),
        ...(checks ? { audit: checks } : {}),
        reused,
        ...(creditsFile ? { creditsFile } : { creditsFile: join(request.dir, CREDITS_FILE) }),
      };
    } finally {
      landing();
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    job.done();
  }
}

/** Runs one `sound_effects` request in main. */
export async function runSoundEffects(service: EarshotService, request: SoundEffectsRequest, signal?: AbortSignal): Promise<SoundEffectsReply> {
  switch (request.action) {
    case "list": {
      const reply = await service.call("sfx_list", { ...(request.category ? { category: request.category } : {}), ...(request.kind ? { kind: request.kind } : {}), full: true }, signal, LIST_TIMEOUT_MS);
      const rows = Array.isArray(reply.json?.sounds) ? (reply.json.sounds as unknown[]) : [];
      const entries = rows.map((row) => bankEntry(record(row)));
      const categories = bankCategories(entries);
      const filtered = !!(request.category || request.kind);
      const head = typeof reply.json?.summary === "string" ? reply.json.summary : reply.summary.split("\n")[0] ?? "";
      const summary = filtered ? head : `${head}, in ${categories.length} categories. Pass a category or a kind for each sound's length, onset, peak and knobs.`;
      // A sound's notes stay only where they say more than its category's use.
      const sounds = entries.map((entry) => (entry.notes && entry.notes === categories.find((c) => c.category === entry.category)?.use ? (({ notes: _notes, ...rest }) => rest)(entry) : entry));
      return { action: "list", version: await service.earshotVersion(), summary, bank: String(reply.json?.version ?? ""), categories, ...(filtered ? { sounds } : {}) };
    }
    case "check": {
      const path = await resolveSoundPath(request.path, { project: request.dir, what: "path", privateDirs: service.privateDirs });
      const result = await service.check(path, { category: request.category, role: request.role }, signal);
      return { action: "check", version: await service.earshotVersion(), summary: result.summary, path, audit: result };
    }
    case "render":
      return render(service, request, signal);
  }
}
