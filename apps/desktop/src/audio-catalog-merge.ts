/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The catalog's rules, without the disk: how a personal override combines
// with a default entry, which entries a list shows and in what order, what a
// summary leaves out, and what makes an entry's timing or source
// inconsistent. The store (audio-catalog.ts) reads and writes; everything
// here is pure, so the offline tests of the bundled catalogs use it too.

import { CATALOG_PATCH_FIELDS } from "@diffusionstudio/dapi";
import { platformOf } from "./platform-url";

import type { AudioCatalogDownload, AudioCatalogEntry, AudioCatalogKind, AudioCatalogMerged, AudioCatalogPatch, ToolArgs, ToolOutput } from "@diffusionstudio/dapi";

/** Fields whose values describe one particular recording: a new source makes them stale. */
export const TIMING_FIELDS = ["sourceRange", "sections", "hitAt", "durationSeconds", "bpm", "loudnessLufs", "peakDb", "suggestedVolumeDb"] as const;
/** Fields a Cutroom entry can't do without; a personal override may replace them but not clear them. */
export const REQUIRED_FIELDS = ["title", "description", "sourceUrl", "durationSeconds", "rights", "verifiedAt"] as const;
export const MUSIC_ONLY_FIELDS = ["artist", "variant", "vocals", "explicit", "moods", "energy", "bpm", "loudnessLufs"] as const;
export const SFX_ONLY_FIELDS = ["category", "align", "hitAt", "peakDb"] as const;
/** What a summary leaves out to keep a list short (`sourceUrl` is in `download.url` too); `get` and `detail: "full"` keep them. */
const SUMMARY_OMITS = ["sourceUrl", "description", "attribution", "avoid", "sections", "pageUrl", "verifiedAt", "addedAt", "loudnessLufs"] as const;
/** Slack for a range or a hit against a decoded duration (AAC priming, rounding). */
const DURATION_SLACK = 0.05;

const PATCH_FIELDS = new Set<string>(CATALOG_PATCH_FIELDS);

export type CatalogFilters = Pick<
  ToolArgs<"audio_catalog">,
  "query" | "moods" | "uses" | "category" | "vocals" | "energyMin" | "energyMax" | "maxDurationSeconds" | "rights" | "includeHidden"
>;

export type ExcludedReason = "hidden" | "incomplete" | "no-source";

/** One id after merging: both layers, the result (null when too incomplete to show), and why it's left out of lists, if it is. */
export type MergedRecord = {
  id: string;
  default: AudioCatalogEntry | null;
  personal: AudioCatalogPatch | null;
  merged: AudioCatalogMerged | null;
  excludedReason?: ExcludedReason;
};

type Loose = Record<string, unknown>;

/**
 * Freesound's site, as opposed to cdn.freesound.org where its files are. A
 * sound's page there shares only a picture of the waveform, so the
 * downloader, which reads the page for its preview file, fetches it.
 */
const FREESOUND_SITE = /^(www\.)?freesound\.org$/;

/** The tool and folder that fetch `url`: platform and Freesound pages go through media_download, files and stock pages through web_media_download. */
export function downloadFor(url: string, kind: AudioCatalogKind): AudioCatalogDownload {
  const page = !!platformOf(url) || FREESOUND_SITE.test(parseUrl(url)?.hostname.toLowerCase() ?? "");
  return { tool: page ? "media_download" : "web_media_download", url, folder: kind === "music" ? "music" : "sfx" };
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Why `id` doesn't name the source at `url`, or null when it does (or its
 * prefix makes no claim about the URL): `youtube:<id>` must be that video,
 * `myinstants:<slug>` that sound's page, `freesound:<n>` that sound's page or
 * preview, `wikimedia:<page id>` a Commons upload.
 */
export function idProblem(id: string, url: string): string | null {
  const at = id.indexOf(":");
  const prefix = id.slice(0, at);
  const key = id.slice(at + 1);
  const link = parseUrl(url);
  if (!link || link.protocol !== "https:") return `${id}: its sourceUrl must be an https link.`;
  const host = link.hostname.toLowerCase();
  const parts = link.pathname.split("/").filter(Boolean);
  switch (prefix) {
    case "youtube": {
      if (!YOUTUBE_ID.test(key)) return `${id}: a YouTube id has 11 letters, digits, - or _.`;
      const watch = /^(www\.|m\.|music\.)?youtube\.com$/.test(host) && parts[0] === "watch" && link.searchParams.get("v") === key;
      const short = host === "youtu.be" && parts[0] === key;
      return watch || short ? null : `${id}: its sourceUrl must be https://www.youtube.com/watch?v=${key}.`;
    }
    case "myinstants": {
      const at = parts.indexOf("instant");
      const ok = /^(www\.)?myinstants\.com$/.test(host) && at >= 0 && parts[at + 1]?.toLowerCase() === key.toLowerCase();
      return ok ? null : `${id}: its sourceUrl must be the sound's MyInstants page, …/instant/${key}/.`;
    }
    case "freesound": {
      if (!/^\d{1,12}$/.test(key)) return `${id}: a Freesound id is the sound's number.`;
      const preview = host === "cdn.freesound.org" && parts[0] === "previews" && new RegExp(`^${key}_\\d+-(hq|lq)\\.(mp3|ogg)$`).test(parts.at(-1) ?? "");
      const page = /^(www\.)?freesound\.org$/.test(host) && parts[0] === "people" && parts[2] === "sounds" && parts[3] === key;
      return preview || page ? null : `${id}: its sourceUrl must be that sound's Freesound page or preview file.`;
    }
    case "wikimedia":
      if (!/^\d{1,12}$/.test(key)) return `${id}: a Wikimedia id is the file page's id.`;
      return host === "upload.wikimedia.org" ? null : `${id}: its sourceUrl must be the file on upload.wikimedia.org.`;
    default:
      return null;
  }
}

/** What is inconsistent about an entry's timing: a range or section outside the source, sections out of order, a hit outside the range. */
export function timingProblems(entry: AudioCatalogEntry): string[] {
  const problems: string[] = [];
  const duration = entry.durationSeconds;
  const range = entry.sourceRange;
  if (range && duration !== undefined && range.end > duration + DURATION_SLACK) {
    problems.push(`${entry.id}: sourceRange ends at ${range.end} s, after the source's ${duration} s.`);
  }
  let previous = -Infinity;
  for (const section of entry.sections ?? []) {
    if (duration !== undefined && section.end > duration + DURATION_SLACK) problems.push(`${entry.id}: the ${section.label} section ends after the source does.`);
    if (section.start < previous - 1e-6) problems.push(`${entry.id}: sections must be in order and not overlap.`);
    previous = section.end;
  }
  if (entry.hitAt !== undefined) {
    const start = range?.start ?? 0;
    const end = range?.end ?? duration;
    if (entry.hitAt < start - 1e-6 || (end !== undefined && entry.hitAt > end + 1e-6)) {
      problems.push(`${entry.id}: hitAt (${entry.hitAt} s) must fall inside ${range ? "sourceRange" : "the source"}.`);
    }
  }
  return problems;
}

/** Fields of `kind`'s opposite that an entry of `kind` must not set. */
export function foreignFields(entry: Loose, kind: AudioCatalogKind): string[] {
  const foreign: readonly string[] = kind === "music" ? SFX_ONLY_FIELDS : MUSIC_ONLY_FIELDS;
  return foreign.filter((field) => entry[field] !== undefined && entry[field] !== null);
}

/** The patch's known fields only (unknown keys stay on disk, out of every answer). */
export function knownPatch(patch: AudioCatalogPatch): AudioCatalogPatch {
  const known: Loose = { id: patch.id };
  for (const [key, value] of Object.entries(patch)) if (PATCH_FIELDS.has(key) && value !== undefined) known[key] = value;
  return known as AudioCatalogPatch;
}

/** The fields a patch sets or clears, in schema order. */
export function patchFields(patch: AudioCatalogPatch | null): string[] {
  if (!patch) return [];
  return CATALOG_PATCH_FIELDS.filter((field) => (patch as Loose)[field] !== undefined);
}

/**
 * One entry: `base` (Cutroom's, or null for a personal entry) with `patch`
 * (the user's, or null) on top. A field the patch leaves out inherits; null
 * clears it; arrays and objects replace whole. A patch that moves the source
 * to another URL without new timing drops the inherited timing, which
 * described the old recording.
 */
export function mergeEntry(base: AudioCatalogEntry | null, patch: AudioCatalogPatch | null, kind: AudioCatalogKind): { record: MergedRecord; warnings: string[] } {
  const id = base?.id ?? patch!.id;
  const warnings: string[] = [];
  const entry: Loose = base ? structuredClone(base) : { id };
  const overridden = patchFields(patch);
  for (const field of overridden) {
    const value = (patch as Loose)[field];
    if (value === null) delete entry[field];
    else entry[field] = structuredClone(value);
  }
  let needsVerification = false;
  const movedUrl = base && typeof patch?.sourceUrl === "string" && patch.sourceUrl !== base.sourceUrl;
  if (movedUrl && !TIMING_FIELDS.some((field) => overridden.includes(field))) {
    for (const field of TIMING_FIELDS) delete entry[field];
    needsVerification = true;
    warnings.push(`${id} plays from a different source than Blackout's entry, so its duration, range and levels were dropped. Probe the new source before trimming it.`);
  }

  const record: MergedRecord = { id, default: base, personal: patch ? knownPatch(patch) : null, merged: null };
  const hasText = (field: string) => typeof entry[field] === "string" && (entry[field] as string).length > 0;
  if (!hasText("sourceUrl")) {
    record.excludedReason = "no-source";
    warnings.push(`${id} has no sourceUrl, so it's left out. Give it one with save, or reset it.`);
    return { record, warnings };
  }
  if (!hasText("title") || (!base && !hasText("description"))) {
    record.excludedReason = "incomplete";
    warnings.push(
      base
        ? `${id} has no title, so it's left out. Give it one with save, or reset the field.`
        : `${id} is in the personal catalog without ${hasText("title") ? "a description" : "a title"} and isn't one of Blackout's entries (any more), so it's left out. Complete it with save, or reset it.`,
    );
    return { record, warnings };
  }
  const hidden = entry.hidden === true;
  if (hidden) record.excludedReason = "hidden";
  record.merged = {
    ...(entry as AudioCatalogEntry),
    rights: (entry.rights as AudioCatalogMerged["rights"] | undefined) ?? "unknown",
    origin: !base ? "personal" : overridden.length ? "overridden" : "default",
    overridden,
    needsVerification,
    selectable: !hidden,
    download: downloadFor(entry.sourceUrl as string, kind),
  };
  return { record, warnings };
}

/**
 * Every id in the defaults and the personal layer, merged, in list order:
 * preferred entries first, then Cutroom's order, then personal entries by
 * when they were added. A personal id that appears twice uses its last
 * occurrence.
 */
export function mergeCatalog(defaults: readonly AudioCatalogEntry[], patches: readonly AudioCatalogPatch[], kind: AudioCatalogKind): { records: MergedRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map<string, AudioCatalogPatch>();
  for (const patch of patches) {
    if (byId.has(patch.id)) warnings.push(`${patch.id} appears more than once in the personal catalog; its last occurrence is used.`);
    byId.set(patch.id, patch);
  }
  const records: MergedRecord[] = [];
  const known = new Set<string>();
  for (const base of defaults) {
    known.add(base.id);
    const merged = mergeEntry(base, byId.get(base.id) ?? null, kind);
    records.push(merged.record);
    warnings.push(...merged.warnings);
  }
  const personal = [...byId.values()].filter((patch) => !known.has(patch.id));
  const added = (patch: AudioCatalogPatch) => (typeof patch.addedAt === "string" ? patch.addedAt : "￿");
  personal.sort((a, b) => (added(a) < added(b) ? -1 : added(a) > added(b) ? 1 : 0));
  for (const patch of personal) {
    const merged = mergeEntry(null, patch, kind);
    records.push(merged.record);
    warnings.push(...merged.warnings);
  }
  const preferred = records.filter((record) => record.merged?.preferred === true);
  return { records: [...preferred, ...records.filter((record) => record.merged?.preferred !== true)], warnings };
}

/** How long the useful part of an entry is: its range, else the whole source; undefined when neither is known. */
export function usableSeconds(entry: AudioCatalogEntry): number | undefined {
  return entry.sourceRange ? entry.sourceRange.end - entry.sourceRange.start : entry.durationSeconds;
}

const overlaps = <T>(wanted: readonly T[] | undefined, have: readonly T[] | undefined) => !wanted || (have ?? []).some((item) => wanted.includes(item));

/** Whether a merged entry passes a list's filters (all of them: each filter narrows). */
export function matches(entry: AudioCatalogMerged, filters: CatalogFilters): boolean {
  if (!overlaps(filters.moods, entry.moods) || !overlaps(filters.uses, entry.uses)) return false;
  if (filters.category && (!entry.category || !filters.category.includes(entry.category))) return false;
  if (filters.vocals && (!entry.vocals || !filters.vocals.includes(entry.vocals))) return false;
  if (filters.rights && !filters.rights.includes(entry.rights)) return false;
  if (filters.energyMin !== undefined && (entry.energy === undefined || entry.energy < filters.energyMin)) return false;
  if (filters.energyMax !== undefined && (entry.energy === undefined || entry.energy > filters.energyMax)) return false;
  if (filters.maxDurationSeconds !== undefined) {
    const length = usableSeconds(entry);
    if (length === undefined || length > filters.maxDurationSeconds) return false;
  }
  if (filters.query) {
    const haystack = [entry.title, entry.artist, entry.description, entry.notes, entry.category, ...(entry.tags ?? []), ...(entry.moods ?? []), ...(entry.uses ?? [])]
      .filter(Boolean).join(" ").toLowerCase();
    if (!filters.query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))) return false;
  }
  return true;
}

/** The entries a list shows: selectable (or hidden, when asked for) and matching, in merged order. */
export function listed(records: readonly MergedRecord[], filters: CatalogFilters): AudioCatalogMerged[] {
  return records.flatMap((record) => {
    const entry = record.merged;
    if (!entry) return [];
    if (record.excludedReason === "hidden" && !filters.includeHidden) return [];
    return matches(entry, filters) ? [entry] : [];
  });
}

/**
 * An entry as a list shows it. A summary leaves out the long fields, and the
 * bookkeeping that only says the entry is as shipped: no overridden fields,
 * nothing to re-verify, selectable.
 */
export function present(entry: AudioCatalogMerged, detail: "summary" | "full"): ToolOutput<"audio_catalog">["entries"][number] {
  if (detail === "full") return entry;
  const summary: Loose = { ...entry };
  for (const field of SUMMARY_OMITS) delete summary[field];
  if (!entry.overridden.length) delete summary.overridden;
  if (!entry.needsVerification) delete summary.needsVerification;
  if (entry.selectable) delete summary.selectable;
  return summary as ToolOutput<"audio_catalog">["entries"][number];
}

/**
 * Why a personal patch can't be saved over `base` (or as a new entry when
 * `base` is null), or an empty list. The merged result must be a complete,
 * consistent entry of `kind`.
 */
export function patchProblems(base: AudioCatalogEntry | null, patch: AudioCatalogPatch, kind: AudioCatalogKind): string[] {
  const problems: string[] = [];
  const fields = patch as Loose;
  if (base) {
    for (const field of REQUIRED_FIELDS) if (fields[field] === null) problems.push(`${field} can't be cleared on one of Blackout's entries: set another value, or reset the field.`);
  }
  const foreign = foreignFields(fields, kind);
  if (foreign.length) problems.push(`${foreign.join(", ")} ${foreign.length === 1 ? "describes" : "describe"} ${kind === "music" ? "sound effects" : "music"}, not ${kind}.`);
  const { record } = mergeEntry(base, patch, kind);
  if (!base) {
    const missing = ["title", "description", "sourceUrl"].filter((field) => typeof fields[field] !== "string" || !(fields[field] as string).length);
    if (missing.length) problems.push(`A new entry needs ${missing.join(", ")}.`);
    if (typeof fields.sourceUrl === "string") {
      const mismatch = idProblem(patch.id, fields.sourceUrl);
      if (mismatch) problems.push(mismatch);
    }
  }
  if (record.merged) problems.push(...timingProblems(record.merged));
  return problems;
}
