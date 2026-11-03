/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the sound tools may read, and where a name leads. An agent names a
// file the way the other media tools take one: a library path of the open
// project (`music/theme.m4a`), a path inside the project folder, or an
// absolute local path; folders and globs where earshot takes several files.
// Never a URL. Whatever it resolves to is held to the agents' own read rule
// (no credential stores, no private app data), symlinks resolved, because
// these tools run without asking anyone. A folder or glob is expanded here
// the way earshot expands it, and every file in it is held to that rule by
// its real path: the folder passing says nothing about a link inside it.

import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { DapiError } from "@diffusionstudio/dapi";
import { decideRead } from "@diffusionstudio/agent-chat/host/policy";

export type ResolveOptions = {
  /** The open project, or null at the dashboard. */
  project: string | null;
  /** What the path is for, in messages (`path`, `refs`, `video`…). */
  what: string;
  /** Whether a folder or a glob is fine here (expanded as earshot does, every file in it checked). */
  many?: boolean;
  home?: string;
  /** The app's own stores, never read for an agent (chat transcripts, Instagram tokens). */
  privateDirs?: readonly string[];
};

const URL_LIKE = /^[a-z][a-z\d+.-]+:/i;
const GLOB = /[*?[]/;

/** `/`-separated, without `./`, leading or trailing slashes: how the library spells its paths. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
}

type ManifestAsset = { id: string; path: string; source: string };

/** The library's assets, as `assets.yml` lists them; none when it is missing or unreadable. */
async function manifestAssets(project: string): Promise<ManifestAsset[]> {
  try {
    const parsed = parseYaml(await readFile(join(project, "assets.yml"), "utf8")) as { assets?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.assets)) return [];
    return parsed.assets.filter((asset): asset is ManifestAsset => {
      const record = asset as Partial<ManifestAsset> | null;
      return !!record && typeof record.id === "string" && typeof record.path === "string" && typeof record.source === "string";
    });
  } catch {
    return [];
  }
}

const exists = (path: string) => stat(path).then((info) => info, () => null);

/** The part of a glob before its first wildcard segment: the folder it searches. */
export function globRoot(pattern: string): string {
  const parts = pattern.split(sep);
  const at = parts.findIndex((part) => GLOB.test(part));
  return at < 0 ? pattern : parts.slice(0, at).join(sep) || sep;
}

/** A relative name in the open project: a library asset's file, then a project path, then a path under `assets/`. */
async function inProject(project: string, given: string, many: boolean, what: string): Promise<string> {
  const name = normalize(given);
  if (!name || name.split("/").includes("..")) {
    throw new DapiError("invalid-input", `${what}: "${given}" leaves the project. Pass an absolute path for files elsewhere.`);
  }
  if (!GLOB.test(name)) {
    const asset = (await manifestAssets(project)).find((record) => normalize(record.path) === name || record.id === given);
    if (asset) {
      if (URL_LIKE.test(asset.source) && !/^[a-zA-Z]:[\\/]/.test(asset.source)) {
        throw new DapiError("invalid-input", `${what}: the library's ${asset.path} points to remote media. Download it into the project first.`);
      }
      return isAbsolute(asset.source) ? asset.source : join(project, ...normalize(asset.source).split("/"));
    }
  }
  for (const candidate of [join(project, ...name.split("/")), join(project, "assets", ...name.split("/"))]) {
    const probe = many && GLOB.test(candidate) ? globRoot(candidate) : candidate;
    if (await exists(probe)) return candidate;
  }
  throw new DapiError("not-found", `${what}: "${given}" isn't in the open project's library or folder. Use a library path from the asset panel, a path inside the project, or an absolute path.`);
}

// ---------------------------------------------------------------------------
// Folders and globs, as earshot's `audio.list_media` expands them

/** What earshot takes from a folder or glob, by extension: its `audio.MEDIA_EXTS` at the pinned commit. */
const MEDIA_EXTS: ReadonlySet<string> = new Set([
  ".wav", ".flac", ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".aif", ".aiff", ".wma",
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi",
]);

/** Whether earshot counts a name as media, by its extension as Python's `splitext` reads it (leading dots belong to the name). */
function isMedia(name: string): boolean {
  const stem = name.replace(/^\.+/, "");
  const dot = stem.lastIndexOf(".");
  return dot >= 0 && MEDIA_EXTS.has(stem.slice(dot).toLowerCase());
}

/** A code point in a RegExp with the `u` flag, whatever it is. */
const codePoint = (char: string): string => (/^[A-Za-z0-9]$/.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);

/** `[...]` as Python's fnmatch translates it (`stuff` is what stands between the brackets, a leading `!` included). */
function charClass(stuff: string[]): string {
  // Split where a `-` makes a range, as fnmatch does: never at the first character, never right after a range.
  const chunks: string[][] = [];
  if (!stuff.includes("-")) chunks.push(stuff);
  else {
    let from = 0;
    for (let at = stuff[0] === "!" ? 2 : 1; ; at += 3) {
      at = stuff.indexOf("-", at);
      if (at < 0) break;
      chunks.push(stuff.slice(from, at));
      from = at + 1;
    }
    const rest = stuff.slice(from);
    if (rest.length) chunks.push(rest);
    else chunks.at(-1)!.push("-");
    // A range running backwards is empty: fnmatch drops it with its ends.
    for (let at = chunks.length - 1; at > 0; at--) {
      const before = chunks[at - 1]!;
      if (before.at(-1)!.codePointAt(0)! > chunks[at]![0]!.codePointAt(0)!) {
        chunks[at - 1] = [...before.slice(0, -1), ...chunks[at]!.slice(1)];
        chunks.splice(at, 1);
      }
    }
  }
  // Characters, with RANGE between chunks, read the way Python's `re` reads the class fnmatch writes.
  const RANGE = null;
  const tokens: Array<string | null> = chunks.flatMap((chunk, index) => (index ? [RANGE, ...chunk] : chunk));
  const negate = tokens[0] === "!";
  if (negate) tokens.shift();
  if (!tokens.length) return negate ? "." : "(?!)";
  let body = "";
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? "-";
    if (tokens[at] !== RANGE && tokens[at + 1] === RANGE && typeof tokens[at + 2] === "string") {
      body += `${codePoint(token)}-${codePoint(tokens[at + 2]!)}`;
      at += 2;
    } else body += codePoint(token);
  }
  return `[${negate ? "^" : ""}${body}]`;
}

/** One segment of a glob as Python's fnmatch matches a name against it (`*`, `?`, `[seq]`, `[!seq]`, case-sensitive). */
export function segmentPattern(segment: string): RegExp {
  const chars = Array.from(segment);
  let source = "";
  let star = false;
  for (let at = 0; at < chars.length; ) {
    const char = chars[at++]!;
    if (char === "*") {
      if (!star) source += ".*";
      star = true;
      continue;
    }
    star = false;
    if (char === "?") source += ".";
    else if (char === "[") {
      let end = at;
      if (chars[end] === "!") end++;
      if (chars[end] === "]") end++;
      while (end < chars.length && chars[end] !== "]") end++;
      if (end >= chars.length) source += codePoint("[");
      else {
        source += charClass(chars.slice(at, end));
        at = end + 1;
      }
    } else source += codePoint(char);
  }
  return new RegExp(`^(?:${source})$`, "su");
}

type Listed = { name: string; dir: boolean; link: boolean };

/** A folder's entries in sorted order, `dir` following links as Python's `DirEntry.is_dir()` does; none when it can't be read. */
async function listFolder(path: string): Promise<Listed[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const listed = await Promise.all(entries.map(async (entry) => {
    const link = entry.isSymbolicLink();
    const dir = link ? await stat(join(path, entry.name)).then((info) => info.isDirectory(), () => false) : entry.isDirectory();
    return { name: entry.name, dir, link };
  }));
  return listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The media `os.walk` finds under `top`, as earshot lists them: every level, hidden names too, links to folders not entered. */
async function walkFolder(top: string, into: string[] = []): Promise<string[]> {
  const entries = await listFolder(top);
  for (const entry of entries) if (!entry.dir && isMedia(entry.name)) into.push(join(top, entry.name));
  for (const entry of entries) if (entry.dir && !entry.link) await walkFolder(join(top, entry.name), into);
  return into;
}

/**
 * What `**` matches from `dir` in Python's recursive glob: the folder itself
 * when more of the pattern follows (then only folders below it), every name
 * below it otherwise; hidden names skipped, links to folders followed. A
 * folder already walked by another way in is not walked again: its files are
 * the same files.
 */
async function descend(dir: string, foldersOnly: boolean, walked: Set<string>, into: string[]): Promise<void> {
  const real = await realpath(dir).catch(() => null);
  if (!real || walked.has(real) || !(await stat(real).then((info) => info.isDirectory(), () => false))) return;
  walked.add(real);
  if (foldersOnly) into.push(dir);
  for (const entry of await listFolder(dir)) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (!foldersOnly) into.push(path);
    if (entry.dir) await descend(path, foldersOnly, walked, into);
  }
}

/** The paths Python's `glob.glob(pattern, recursive=True)` gives for an absolute pattern (hidden names only for a segment that starts with a dot). */
async function expandGlob(pattern: string): Promise<string[]> {
  const parts = pattern.split(sep).filter(Boolean);
  let found: string[] = [sep];
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const next: string[] = [];
    if (!GLOB.test(part)) {
      for (const dir of found) if (await lstat(join(dir, part)).then(() => true, () => false)) next.push(join(dir, part));
    } else if (part === "**") {
      const walked = new Set<string>();
      for (const dir of found) await descend(dir, !last, walked, next);
    } else {
      const matches = segmentPattern(part);
      const hidden = part.startsWith(".");
      for (const dir of found) {
        for (const entry of await listFolder(dir)) {
          if ((hidden || !entry.name.startsWith(".")) && (last || entry.dir) && matches.test(entry.name)) next.push(join(dir, entry.name));
        }
      }
    }
    found = next;
  }
  return found.filter((path) => isMedia(basename(path))).sort();
}

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += size) out.push(...(await Promise.all(items.slice(at, at + size).map(run))));
  return out;
}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The files of a folder or glob, each by its real path once it is clear the
 * sound tools may read it. One that stays inside the folder is covered by the
 * folder's own check; one a link leads out of it is checked where it lands.
 * Broken links, folders and devices with a media name are left out.
 */
async function checkedFiles(found: string[], root: string, options: ResolveOptions & { home: string }): Promise<string[]> {
  const rootReal = await realpath(root);
  const ask = (path: string, recursive: boolean) => decideRead({ cwd: options.project ?? options.home, path, recursive, home: options.home, privateDirs: options.privateDirs });
  // A folder that holds no credential store anywhere vouches for every file directly in it.
  const folders = new Map<string, Promise<boolean>>();
  const folderAllowed = (folder: string) => {
    let allowed = folders.get(folder);
    if (!allowed) folders.set(folder, (allowed = ask(folder, true).then((decision) => decision.allow)));
    return allowed;
  };
  const resolved = await inBatches(found, 32, async (member) => {
    const real = await realpath(member).catch(() => null);
    const file = !!real && (await stat(real).then((info) => info.isFile(), () => false));
    return { member, real: file ? real : null };
  });
  const files = new Set<string>();
  for (const { member, real } of resolved) {
    if (!real || files.has(real)) continue;
    if (!inside(rootReal, real) && !(await folderAllowed(dirname(real)))) {
      const decision = await ask(real, false);
      if (!decision.allow) throw new DapiError("invalid-input", `${options.what}: ${member} leads outside ${root}. ${decision.message}`);
    }
    files.add(real);
  }
  return [...files];
}

/** Where `value` leads, checked; for a folder or glob, also the checked files in it. */
async function locate(value: string, options: ResolveOptions): Promise<{ path: string; files: string[] | null }> {
  const given = value.trim();
  const what = options.what;
  if (!given || /[\x00-\x1f\x7f]/u.test(given)) throw new DapiError("invalid-input", `${what}: give a file path.`);
  if ((URL_LIKE.test(given) && !/^[a-zA-Z]:[\\/]/.test(given)) || given.startsWith("//")) {
    throw new DapiError("invalid-input", `${what}: the sound tools read local files, not URLs. Download it first (media_download or web_media_download) and pass its library path.`);
  }
  const home = options.home ?? homedir();
  let path: string;
  if (given === "~" || given.startsWith("~/")) path = join(home, given.slice(2));
  else if (isAbsolute(given)) path = resolve(given);
  else if (options.project) path = await inProject(options.project, given, !!options.many, what);
  else throw new DapiError("no-project", `${what}: "${given}" is a library or project path, and no project is open. Open the project, or pass an absolute path.`);

  const pattern = !!options.many && GLOB.test(path);
  const probe = pattern ? globRoot(path) : path;
  const info = await exists(probe);
  if (!info) throw new DapiError("not-found", `${what}: nothing is at ${probe}.`);
  if (!options.many && info.isDirectory()) throw new DapiError("wrong-kind", `${what}: ${path} is a folder; give a file.`);
  const decision = await decideRead({ cwd: options.project ?? home, path: probe, recursive: pattern || info.isDirectory(), home, privateDirs: options.privateDirs });
  if (!decision.allow) throw new DapiError("invalid-input", `${what}: ${decision.message}`);
  if (!pattern && !info.isDirectory()) return { path, files: null };
  const files = await checkedFiles(pattern ? await expandGlob(path) : await walkFolder(path), probe, { ...options, home });
  if (!files.length) throw new DapiError("not-found", `${what}: no audio or video files in ${path}.`);
  return { path, files };
}

/**
 * The absolute path (or glob) `value` names, once it is clear the sound
 * tools may read there, every file of a folder or glob included. Throws a
 * DapiError the agent can act on otherwise.
 */
export async function resolveSoundPath(value: string, options: ResolveOptions): Promise<string> {
  return (await locate(value, options)).path;
}

/**
 * The files `value` names where earshot takes several, for earshot to read
 * exactly those: a file as it is, a folder or glob as the real paths of the
 * media in it, each checked.
 */
export async function resolveSoundFiles(value: string, options: Omit<ResolveOptions, "many">): Promise<string[]> {
  const { path, files } = await locate(value, { ...options, many: true });
  return files ?? [path];
}

/** One number as Python's `float` reads it in a cue list (`1.2`, `.5`, `-0.25`, `3e1`). */
const SECONDS = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
/** `"1.2,3.4"` or `"1.2; 3.4"`: what earshot splits into seconds. */
const CUE_TIMES = new RegExp(String.raw`^${SECONDS}(?:\s*[,;]\s*${SECONDS})*\s*[,;]?$`, "i");

/** Whether `text` is cue times themselves rather than the name of a cues file. */
function isCueText(text: string): boolean {
  if (CUE_TIMES.test(text)) return true;
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * `cues` as earshot takes them: times (a list, `"1.2,3.4"`, JSON text) stay
 * as given; anything else names a cues file and is resolved and checked like
 * any other path, `./cues.json` and `2026-cues.json` included. earshot itself
 * would open such a name relative to its own folder, unchecked.
 */
export async function resolveCues(cues: number[] | string, options: Omit<ResolveOptions, "what" | "many">): Promise<number[] | string> {
  if (Array.isArray(cues)) return cues;
  const text = cues.trim();
  if (isCueText(text)) return text;
  try {
    return await resolveSoundPath(text, { ...options, what: "cues" });
  } catch (error) {
    if (error instanceof DapiError && error.code === "not-found") {
      throw new DapiError("not-found", `${error.message} Cue times are a list of seconds, "1.2,3.4" or JSON text.`);
    }
    throw error;
  }
}
