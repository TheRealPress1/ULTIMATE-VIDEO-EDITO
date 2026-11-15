/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Media tab's logic, apart from its components so it can be tested
// without rendering: what kind a file is, sorting and filtering, the path
// bar, columns, which rows are on screen, and selection.

import type { MediaDetails, MediaEntry, MediaPlace } from "@desktop/main-channels";

/** Drag type for files and folders dragged out of the Media tab: absolute paths, one per line. */
export const MEDIA_PATHS_DRAG_TYPE = "application/x-media-paths";

export type MediaKind = "video" | "audio" | "image";
export type SortKey = "name" | "date" | "kind" | "duration" | "size";
export type SortOrder = { key: SortKey; descending: boolean };
export type ViewMode = "columns" | "list" | "grid";
export type BrowserPlace = MediaPlace | { label: string; path: string; group: "added" };

const KINDS: Record<MediaKind, readonly string[]> = {
  video: ["mov", "mp4", "m4v", "mxf", "avi", "mkv", "webm", "mts", "m2ts", "mpg", "mpeg", "3gp", "braw", "r3d", "insv", "lrv"],
  audio: ["wav", "aif", "aiff", "mp3", "m4a", "aac", "flac", "ogg", "opus", "caf", "bwf"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "dng", "cr2", "cr3", "arw", "nef", "psd", "exr"],
};
const KIND_BY_EXTENSION = new Map(
  (Object.entries(KINDS) as [MediaKind, readonly string[]][]).flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind] as const)),
);

/** Video, audio or image by extension; null for anything else, which the browser leaves out. */
export function mediaKind(name: string): MediaKind | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return KIND_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

const KIND_ORDER: Record<MediaKind, number> = { video: 0, audio: 1, image: 2 };
const byName = (a: MediaEntry, b: MediaEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/**
 * Folders, then the media files of the kinds asked for (every kind when none
 * is). Other files are not shown: the browser is for footage.
 */
export function filterEntries(entries: readonly MediaEntry[], kinds: ReadonlySet<MediaKind>): MediaEntry[] {
  return entries.filter((entry) => {
    if (entry.kind === "directory") return true;
    const kind = mediaKind(entry.name);
    return kind !== null && (kinds.size === 0 || kinds.has(kind));
  });
}

/**
 * Finder's order: folders first (by name), files by the sort key with name
 * breaking ties. A file whose duration isn't known yet sorts after those
 * that are, whichever way the order runs.
 */
export function sortEntries(entries: readonly MediaEntry[], order: SortOrder, durations: ReadonlyMap<string, number> = new Map()): MediaEntry[] {
  const sign = order.descending ? -1 : 1;
  const compare = (a: MediaEntry, b: MediaEntry): number => {
    switch (order.key) {
      case "date": return a.mtime - b.mtime;
      case "size": return a.size - b.size;
      case "kind": return KIND_ORDER[mediaKind(a.name) ?? "image"] - KIND_ORDER[mediaKind(b.name) ?? "image"];
      default: return 0;
    }
  };
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    if (a.kind === "directory") return byName(a, b);
    if (order.key === "duration") {
      const left = durations.get(a.path);
      const right = durations.get(b.path);
      if (left === undefined || right === undefined) {
        if (left !== right) return left === undefined ? 1 : -1;
        return byName(a, b);
      }
      return sign * (left - right) || byName(a, b);
    }
    if (order.key === "name") return sign * byName(a, b);
    return sign * compare(a, b) || byName(a, b);
  });
}

/** Sidebar places: the system's, then folders the user added, without repeats. */
export function mergePlaces(system: readonly MediaPlace[], added: readonly string[]): BrowserPlace[] {
  const seen = new Set(system.map((place) => place.path));
  const extra: BrowserPlace[] = [];
  for (const path of added) {
    if (seen.has(path)) continue;
    seen.add(path);
    extra.push({ label: baseName(path), path, group: "added" });
  }
  return [...system, ...extra];
}

export const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

const isInside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/** The deepest place that holds `path`, or undefined when none does. */
export function placeFor(path: string, places: readonly BrowserPlace[]): BrowserPlace | undefined {
  let best: BrowserPlace | undefined;
  for (const place of places) {
    if (isInside(path, place.path) && (!best || place.path.length > best.path.length)) best = place;
  }
  return best;
}

export type PathSegment = { label: string; path: string };

/**
 * The path bar: the place that holds `path` named as the sidebar names it,
 * then each folder below it. Outside every place it starts at the root.
 */
export function pathSegments(path: string, places: readonly BrowserPlace[]): PathSegment[] {
  const place = placeFor(path, places);
  const root = place?.path ?? "/";
  const segments: PathSegment[] = [{ label: place?.label ?? "/", path: root }];
  const rest = path.slice(root.length).split("/").filter(Boolean);
  let current = root;
  for (const name of rest) {
    current = current.endsWith("/") ? `${current}${name}` : `${current}/${name}`;
    segments.push({ label: name, path: current });
  }
  return segments;
}

/** The columns view: one column per folder from the place down to `path`. */
export function columnPaths(path: string, places: readonly BrowserPlace[]): string[] {
  return pathSegments(path, places).map((segment) => segment.path);
}

/**
 * Whether opening `path` may make macOS ask for permission: the protected
 * folders in the user's home and any drive under /Volumes. iCloud Drive too.
 */
export function mayAskPermission(path: string, places: readonly BrowserPlace[]): boolean {
  if (/\/Library\/Mobile Documents(\/|$)/.test(path)) return true;
  const volume = path.match(/^\/Volumes\/[^/]+/)?.[0];
  // Every drive but the one the Mac started from, which also appears in /Volumes.
  if (volume) return !places.some((place) => "startup" in place && place.startup && volume === `/Volumes/${place.label}`);
  return places.some((place) => place.group === "favorites" && ["Desktop", "Documents", "Downloads"].includes(place.label) && isInside(path, place.path));
}

/**
 * The place whose permission note covers `path`: the note is shown once per
 * place, before the first read, and never again once seen.
 */
export function permissionNoteFor(path: string, places: readonly BrowserPlace[], seen: readonly string[]): string | null {
  if (!mayAskPermission(path, places)) return null;
  // The deeper of the place and the drive: a drive reached from the startup disk's `/` is its own.
  const candidates = [placeFor(path, places)?.path, path.match(/^\/Volumes\/[^/]+/)?.[0]].filter((item): item is string => !!item);
  const key = candidates.sort((left, right) => right.length - left.length)[0] ?? path;
  return seen.includes(key) ? null : key;
}

export type VisibleRange = { start: number; end: number };

/** Which rows of a fixed-height list are on screen, with `overscan` rows either side; `end` is exclusive. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 8): VisibleRange {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight);
  // A list that shrank under a scrolled view: clamp both ends, never start past the last row.
  const end = Math.min(count, last + overscan);
  return { start: Math.min(end, Math.max(0, first - overscan)), end };
}

/** The same for a grid of `columns` items a row: the range is in items, whole rows at a time. */
export function visibleGridRange(scrollTop: number, viewport: number, rowHeight: number, columns: number, count: number, overscan = 2): VisibleRange {
  const perRow = Math.max(1, columns);
  const rows = visibleRange(scrollTop, viewport, rowHeight, Math.ceil(count / perRow), overscan);
  return { start: rows.start * perRow, end: Math.min(count, rows.end * perRow) };
}

export type Selection = { selected: string[]; anchor: string | null };
export type SelectModifiers = { toggle?: boolean; extend?: boolean };

/** Finder's click rules: a click selects one, ⌘ toggles one, ⇧ selects the run from the anchor. */
export function select(keys: readonly string[], current: Selection, key: string, modifiers: SelectModifiers = {}): Selection {
  if (modifiers.extend && current.anchor !== null && keys.includes(current.anchor)) {
    const from = keys.indexOf(current.anchor);
    const to = keys.indexOf(key);
    const [low, high] = from < to ? [from, to] : [to, from];
    return { selected: keys.slice(low, high + 1), anchor: current.anchor };
  }
  if (modifiers.toggle) {
    const selected = current.selected.includes(key) ? current.selected.filter((item) => item !== key) : [...current.selected, key];
    return { selected, anchor: key };
  }
  return { selected: [key], anchor: key };
}

/**
 * What a drag out of the browser carries: the selection when the dragged
 * item is part of it, the item alone otherwise. Cloud-only files are left
 * out, since linking one would read it, and that would download it.
 */
export function dragPaths(entries: readonly MediaEntry[], selected: readonly string[], dragged: string): string[] {
  const chosen = selected.includes(dragged) ? selected : [dragged];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return chosen.filter((path) => {
    const entry = byPath.get(path);
    return entry !== undefined && !entry.cloud;
  });
}

/** Reads the paths a drag from the browser carries; [] for any other drag. */
export function droppedMediaPaths(transfer: Pick<DataTransfer, "getData"> | null | undefined): string[] {
  const data = transfer?.getData(MEDIA_PATHS_DRAG_TYPE) ?? "";
  return data.split("\n").filter((path) => path.startsWith("/"));
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264", hevc: "HEVC (H.265)", prores: "ProRes", dnxhd: "DNxHD/HR", av1: "AV1", vp9: "VP9", mpeg2video: "MPEG-2",
  aac: "AAC", pcm_s16le: "PCM 16-bit", pcm_s24le: "PCM 24-bit", pcm_s32le: "PCM 32-bit", mp3: "MP3", alac: "ALAC", flac: "FLAC", opus: "Opus",
};
const codecName = (codec: string): string => CODEC_NAMES[codec] ?? codec.toUpperCase();

/** The details panel's rows, in the order an editor reads them; missing facts are left out. */
export function detailRows(details: MediaDetails): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (details.duration !== undefined) rows.push(["Duration", formatDuration(details.duration)]);
  if (details.width !== undefined && details.height !== undefined) rows.push(["Resolution", `${details.width} × ${details.height}`]);
  if (details.frameRate !== undefined) rows.push(["Frame rate", `${Number(details.frameRate.toFixed(3))} fps`]);
  if (details.videoCodec) rows.push(["Video", codecName(details.videoCodec)]);
  if (details.audioCodec) {
    const extra = [details.sampleRate ? `${details.sampleRate / 1000} kHz` : "", details.channels ? `${details.channels} ch` : ""].filter(Boolean).join(", ");
    rows.push(["Audio", extra ? `${codecName(details.audioCodec)} · ${extra}` : codecName(details.audioCodec)]);
  }
  return rows;
}
