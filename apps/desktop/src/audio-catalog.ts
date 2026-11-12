/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `audio_catalog`: Cutroom's curated music and effects (bundled with the
// docs, read-only, replaced on update) under the user's personal layer, one
// app-owned file per kind in userData. Agents can't write userData, so this
// store is the only writer of that layer. Writes are serialized and
// optimistic, as editing_style's are: a stale revision fails without
// overwriting, and every write lands whole (temp file, fsync, rename).

import { copyFile, chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUDIO_CATALOG_PERSONAL_BYTES,
  AUDIO_CATALOG_PERSONAL_MAX,
  AudioCatalogFile,
  CATALOG_PATCH_FIELDS,
  DapiError,
  PersonalCatalogFile,
} from "@diffusionstudio/dapi";
import { listed, mergeCatalog, patchProblems, present } from "./audio-catalog-merge";

import type { AudioCatalogEntry, AudioCatalogKind, AudioCatalogPatch, AudioCatalogPersonal, ToolArgs, ToolOutput } from "@diffusionstudio/dapi";
import type { MergedRecord } from "./audio-catalog-merge";

/** What Cutroom's own catalog says about a source it ships: what a download's credits record. */
export type AudioCatalogCredit = { kind: AudioCatalogKind; id: string; title: string; rights: AudioCatalogEntry["rights"]; attribution?: string; pageUrl?: string };

export type AudioCatalogStoreOptions = {
  /** The staged docs, holding `reference/catalogs/<kind>.json`; null when there are none. */
  docsDir: string | null;
  /** Where the personal files live: `<userData>/audio-catalog`. */
  personalDir: string;
  now?: () => Date;
};

type Defaults = { entries: AudioCatalogEntry[]; updated: string | null; path: string | null; warning?: string };
type Personal = { file: AudioCatalogPersonal; error?: undefined } | { file: null; error: string };

const EMPTY: AudioCatalogPersonal = { version: 1, revision: 0, updatedAt: null, entries: [] };

export class AudioCatalogStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly docsDir: string | null;
  private readonly personalDir: string;
  private readonly now: () => Date;

  constructor(options: AudioCatalogStoreOptions) {
    this.docsDir = options.docsDir;
    this.personalDir = options.personalDir;
    this.now = options.now ?? (() => new Date());
  }

  defaultsPath(kind: AudioCatalogKind): string | null {
    return this.docsDir ? join(this.docsDir, "reference", "catalogs", `${kind}.json`) : null;
  }

  personalPath(kind: AudioCatalogKind): string {
    return join(this.personalDir, `${kind}.local.json`);
  }

  /** Answers one `audio_catalog` call. */
  run(args: ToolArgs<"audio_catalog">): Promise<ToolOutput<"audio_catalog">> {
    if (args.action === "list" || args.action === "get") return this.read(args);
    // Writes go one at a time, across kinds, so a revision read is the one written over.
    const work = this.pending.then(() => (args.action === "save" ? this.save(args) : this.reset(args)));
    this.pending = work.catch(() => {});
    return work;
  }

  private async read(args: ToolArgs<"audio_catalog">): Promise<ToolOutput<"audio_catalog">> {
    const [defaults, personal] = await Promise.all([this.defaults(args.kind), this.personal(args.kind)]);
    return this.answer(args, defaults, personal);
  }

  private async save(args: ToolArgs<"audio_catalog">): Promise<ToolOutput<"audio_catalog">> {
    const { kind, id } = args;
    const fields = args.fields;
    if (!id || !fields || args.expectedRevision === undefined) throw new DapiError("invalid-input", "save needs id, fields and expectedRevision from the last list or get.");
    const [defaults, personal] = await Promise.all([this.defaults(kind), this.personal(kind)]);
    const file = this.writable(kind, personal, args.expectedRevision);
    const base = defaults.entries.find((entry) => entry.id === id) ?? null;
    const previous = lastPatch(file, id);
    // The fields arrive parsed: their text is already cleaned of control and invisible characters.
    const next = { ...(previous ?? { id }), ...fields, id } as AudioCatalogPatch;
    if (!base && !previous && next.addedAt === undefined) next.addedAt = this.now().toISOString();
    const problems = patchProblems(base, next, kind);
    if (problems.length) throw new DapiError("invalid-input", `That change wasn't saved: ${problems.join(" ")}`);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return this.answer(args, defaults, { file });
    const written = await this.write(kind, file, replacePatch(file.entries, id, next));
    return this.answer(args, defaults, { file: written });
  }

  private async reset(args: ToolArgs<"audio_catalog">): Promise<ToolOutput<"audio_catalog">> {
    const { kind, id } = args;
    const [defaults, personal] = await Promise.all([this.defaults(kind), this.personal(kind)]);
    if (args.discardDamaged) {
      // Setting a damaged file aside concerns the whole file: any id or revision sent with it is not needed.
      if (personal.error !== undefined) {
        await this.setAside(kind);
        return this.answer(args, defaults, { file: EMPTY }, [`The unreadable personal ${kind} catalog was set aside next to ${this.personalPath(kind)}, and an empty one starts in its place.`]);
      }
      if (!id || args.expectedRevision === undefined) return this.answer(args, defaults, personal, [`The personal ${kind} catalog reads fine, so nothing was set aside or changed.`]);
    }
    if (!id) throw new DapiError("invalid-input", "reset needs the entry's id.");
    if (args.expectedRevision === undefined) throw new DapiError("invalid-input", "reset needs expectedRevision from the last list or get.");
    const file = this.writable(kind, personal, args.expectedRevision);
    const previous = lastPatch(file, id);
    if (!previous) return this.answer(args, defaults, { file });
    let next: AudioCatalogPatch | null = null;
    if (args.fieldNames) {
      const kept: Record<string, unknown> = { ...previous };
      for (const field of args.fieldNames) delete kept[field];
      next = CATALOG_PATCH_FIELDS.some((field) => kept[field] !== undefined) ? (kept as AudioCatalogPatch) : null;
      if (next) {
        const problems = patchProblems(defaults.entries.find((entry) => entry.id === id) ?? null, next, kind);
        if (problems.length) throw new DapiError("invalid-input", `That reset wasn't saved: ${problems.join(" ")} Reset the whole entry instead.`);
      }
    }
    const written = await this.write(kind, file, replacePatch(file.entries, id, next));
    return this.answer(args, defaults, { file: written });
  }

  /** The personal file to write over, when it was readable and is still at the revision the caller saw. */
  private writable(kind: AudioCatalogKind, personal: Personal, expectedRevision: number): AudioCatalogPersonal {
    if (personal.error !== undefined) {
      throw new DapiError(
        "invalid-input",
        `The personal ${kind} catalog at ${this.personalPath(kind)} can't be read (${personal.error}), so nothing was changed. Fix the file, or call reset with kind "${kind}" and discardDamaged: true (no id or revision needed) to set it aside and start an empty one.`,
      );
    }
    if (personal.file.revision !== expectedRevision) {
      throw new DapiError("busy", `The personal ${kind} catalog changed since revision ${expectedRevision} (it is at ${personal.file.revision} now). List or get it again and review the change before saving.`);
    }
    return personal.file;
  }

  private answer(args: ToolArgs<"audio_catalog">, defaults: Defaults, personal: Personal, notes: string[] = []): ToolOutput<"audio_catalog"> {
    const patches = personal.file?.entries ?? [];
    const { records, warnings } = mergeCatalog(defaults.entries, patches, args.kind);
    if (defaults.warning) warnings.unshift(defaults.warning);
    if (personal.error !== undefined) warnings.unshift(`The personal ${args.kind} catalog couldn't be read, so the user's preferences aren't applied: ${personal.error}`);
    warnings.push(...notes);
    const all = listed(records, { includeHidden: false });
    const hiddenCount = records.filter((record) => record.excludedReason === "hidden").length;
    const base = {
      kind: args.kind,
      revision: personal.file?.revision ?? 0,
      defaultsUpdated: defaults.updated,
      defaultsPath: defaults.path,
      personalPath: this.personalPath(args.kind),
      hiddenCount,
      warnings,
      ...(personal.error !== undefined ? { personalError: personal.error } : {}),
    };
    if (args.action === "list") {
      const matching = listed(records, args);
      return { ...base, total: matching.length, entries: matching.slice(0, args.limit).map((entry) => present(entry, args.detail)) };
    }
    if (!args.id) return { ...base, total: all.length, entries: [] };
    const record = records.find((item) => item.id === args.id) ?? null;
    if (!record && args.action === "get") throw new DapiError("not-found", `There's no ${args.kind} entry ${args.id}. List the catalog for its ids.`);
    return { ...base, total: all.length, entries: [], selected: selected(args.id, record) };
  }

  /**
   * What Cutroom's shipped catalog records about the source at `url`, for the
   * credits of a download: its rights, credit line and page. Only the bundled
   * defaults count, which were checked by hand; the personal layer is anyone's
   * word. Null for any other URL, or when the catalog can't be read.
   */
  async credit(url: string): Promise<AudioCatalogCredit | null> {
    const wanted = comparable(url);
    if (!wanted) return null;
    for (const kind of ["music", "sfx"] as const) {
      const defaults = await this.defaults(kind).catch(() => null);
      const entry = defaults?.entries.find((item) => comparable(item.sourceUrl) === wanted);
      if (entry) {
        return {
          kind, id: entry.id, title: entry.title, rights: entry.rights,
          ...(entry.attribution ? { attribution: entry.attribution } : {}),
          ...(entry.pageUrl ? { pageUrl: entry.pageUrl } : {}),
        };
      }
    }
    return null;
  }

  /** Cutroom's entries for `kind`; none, with a warning, when the docs aren't installed. A damaged bundled file is an error: it ships tested. */
  private async defaults(kind: AudioCatalogKind): Promise<Defaults> {
    const path = this.defaultsPath(kind);
    if (!path) return { entries: [], updated: null, path: null, warning: `Blackout's ${kind} catalog isn't installed with this app; only personal entries are listed.` };
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], updated: null, path, warning: `Blackout's ${kind} catalog is missing from ${path}; only personal entries are listed.` };
      throw error;
    }
    const parsed = AudioCatalogFile.safeParse(safeJson(text));
    if (!parsed.success || parsed.data.kind !== kind) throw new DapiError("unsupported", `Blackout's ${kind} catalog at ${path} is damaged. Reinstall Blackout to restore it.`);
    return { entries: parsed.data.entries as AudioCatalogEntry[], updated: parsed.data.updated, path };
  }

  /** The user's layer: empty when there is no file yet, an error (never a guess) when there is one that doesn't read. */
  private async personal(kind: AudioCatalogKind): Promise<Personal> {
    let text: string;
    try {
      text = await readFile(this.personalPath(kind), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: EMPTY };
      return { file: null, error: (error as Error).message };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return { file: null, error: `it isn't valid JSON: ${(error as Error).message}` };
    }
    const parsed = PersonalCatalogFile.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { file: null, error: `it doesn't match the catalog format${issue ? ` at ${issue.path.join(".") || "the top level"}: ${issue.message}` : ""}` };
    }
    return { file: parsed.data };
  }

  /** Writes the next revision whole: the old file kept as `.bak`, a private temp file synced and renamed over, then the folder synced. */
  private async write(kind: AudioCatalogKind, current: AudioCatalogPersonal, entries: AudioCatalogPatch[]): Promise<AudioCatalogPersonal> {
    if (entries.length > AUDIO_CATALOG_PERSONAL_MAX) {
      throw new DapiError("invalid-input", `The personal ${kind} catalog holds at most ${AUDIO_CATALOG_PERSONAL_MAX} entries. Reset entries the user no longer needs first.`);
    }
    const next: AudioCatalogPersonal = { version: 1, revision: current.revision + 1, updatedAt: this.now().toISOString(), entries };
    // Never write what the next read would call damaged: that would shut out every preference the file holds.
    const readable = PersonalCatalogFile.safeParse(next);
    if (!readable.success) {
      const issue = readable.error.issues[0];
      throw new DapiError("invalid-input", `That change wasn't saved: the personal ${kind} catalog would no longer read${issue ? ` (${issue.path.join(".") || "the top level"}: ${issue.message})` : ""}.`);
    }
    const text = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(text) > AUDIO_CATALOG_PERSONAL_BYTES) {
      throw new DapiError("invalid-input", `The personal ${kind} catalog would pass ${AUDIO_CATALOG_PERSONAL_BYTES / 1024} KiB. Shorten notes or descriptions, or reset entries the user no longer needs.`);
    }
    const path = this.personalPath(kind);
    await mkdir(this.personalDir, { recursive: true, mode: 0o700 });
    if (current.revision > 0) {
      await copyFile(path, `${path}.bak`).then(() => chmod(`${path}.bak`, 0o600)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally { await file.close(); }
      await rename(temp, path);
      if (process.platform !== "win32") {
        const folder = await open(this.personalDir, "r");
        try { await folder.sync(); } finally { await folder.close(); }
      }
    } finally { await unlink(temp).catch(() => {}); }
    return next;
  }

  /** Moves an unreadable personal file out of the way, keeping it: `<kind>.local.corrupt-<time>.json`. */
  private async setAside(kind: AudioCatalogKind): Promise<void> {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    await rename(this.personalPath(kind), join(this.personalDir, `${kind}.local.corrupt-${stamp}.json`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** A URL as two spellings of it compare: parsed and serialized, without its fragment; null when it isn't one. */
function comparable(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The patch the merge uses for `id`: its last occurrence. */
function lastPatch(file: AudioCatalogPersonal, id: string): AudioCatalogPatch | null {
  return file.entries.findLast((entry) => entry.id === id) ?? null;
}

/** `entries` with `id`'s patches replaced by `next` where the first one stood (or appended), or removed when `next` is null. */
function replacePatch(entries: readonly AudioCatalogPatch[], id: string, next: AudioCatalogPatch | null): AudioCatalogPatch[] {
  const at = entries.findIndex((entry) => entry.id === id);
  const others = entries.filter((entry) => entry.id !== id);
  if (!next) return others;
  if (at < 0) return [...others, next];
  const before = entries.slice(0, at).filter((entry) => entry.id !== id).length;
  return [...others.slice(0, before), next, ...others.slice(before)];
}

function selected(id: string, record: MergedRecord | null): NonNullable<ToolOutput<"audio_catalog">["selected"]> {
  return {
    id,
    default: record?.default ?? null,
    personal: record?.personal ?? null,
    merged: record?.merged ?? null,
    ...(record?.excludedReason ? { excludedReason: record.excludedReason } : {}),
  };
}
