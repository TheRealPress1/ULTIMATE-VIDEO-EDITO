/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DapiError, isLocalModel, isToolName, toolByName } from "@diffusionstudio/dapi";

// Where tools may write on an agent's behalf. Chats run Cutroom's tools
// without asking anyone, so the tools hold the line themselves, by the rules
// the agents' own file tools follow (packages/agent-chat): anything in the
// open project and the temp folders except Cutroom's and the agents' own
// state; outside them, only a new file in one of the user's content folders.
// Paths are judged where they really lead, symlinks resolved, before the
// tool runs, again after it where `present` writes `capture` and the like
// into `output`, and once more by `present` right before each write. Since
// the open project is where anything goes, which folder `open` may make the
// project is held to rules too, and the project counts only while its path
// still leads where it did when it was opened.

/** Folders under the home folder a new file may be created in. */
const USER_CONTENT = ["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"];

/** Never written for an agent, even inside the project or a temp folder. */
const PROTECTED = new Set([".git", ".claude", ".codex", ".ssh", ".aws", ".cutroom", ".mcp.json"]);

export const REPLACE_OUTSIDE =
  "Files outside the project can't be replaced automatically. Write to a new file name (for example `name-2.ext`) or work on a copy inside the project.";

export const WRITABLE_PLACES =
  "Only the project folder, temporary folders, and new files in Desktop, Documents, Downloads, Movies, Music or Pictures can be written.";

export const OPEN_PLACES =
  "Editing sessions can open an existing Cutroom project, or a new or empty folder in the project, a temporary folder, Desktop, Documents, Downloads, Movies, Music or Pictures. Open a new folder there as the project (for example `~/Movies/<name>`) and use other files by their paths.";

export const OPEN_EXISTING =
  "That folder already holds files and isn't a Cutroom project, so editing sessions can't open it. Open it from Cutroom's dashboard, which makes it a project, or copy its files into a new folder (for example `~/Movies/<name>`) and open that.";

export const PROJECT_MOVED = "The open project's folder changed on disk; reopen the project.";

export const EXPORTS_OUTSIDE =
  "The project's exports folder leads outside the project, so an export can't be written there. Make `exports` a plain folder in the project, or give the export a `path`.";

/**
 * Said with a refused hosted model's output. Main cannot tell whether hosted
 * generation is configured (the renderer refuses the model when it is not),
 * so an agent that would fix the path and then hit that hears it at once.
 */
export const HOSTED_NOTE =
  "Hosted models also need hosted generation configured in Cutroom; where it isn't, use web_media_search then web_media_download for media from the web.";

export function protectedMessage(segment: string): string {
  return `Cutroom keeps ${segment} off-limits to editing sessions. Write project files elsewhere in the project folder.`;
}

// Case-insensitive volumes are the default on macOS and Windows, where
// `.Cutroom` is `.cutroom`. `realpath` spells only what exists as it is on
// disk, so protected names are compared folded, as the agents' policy does.
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

/** The first protected folder or file among `parts`, spelled as the list has it. */
function protectedPart(parts: readonly string[]): string | undefined {
  return parts.map((part) => (FOLD_CASE ? part.toLowerCase() : part)).find((part) => PROTECTED.has(part));
}

/**
 * Why main may not write a download or a render into a library folder of
 * the project (`label`, e.g. `assets/music`), judged by `real`, where the
 * folder really leads; null when it may. The folder must be inside the
 * project (`root`, real too), not the project itself, and not in a protected
 * folder: an agent's shell may make the folder a link to `.git`, and main's
 * writes hold to the same line the agents' own file tools do.
 */
export function libraryFolderRefusal(root: string, real: string, label: string): string | null {
  const inside = relative(root, real);
  if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
    return `The project's ${label} folder leads outside the project. Remove that link and try again.`;
  }
  const segment = protectedPart(inside.split(sep));
  return segment ? `The project's ${label} folder leads into ${segment}, which Cutroom keeps off-limits to editing sessions. Remove that link and try again.` : null;
}

/**
 * How a tool writes its target, which is what an existing one outside the
 * project and temp folders comes down to:
 * - `file`: written as named, replacing what is there.
 * - `fresh`: a file written as named, or an existing folder the tool writes a
 *   freshly named file into (`screenshot`, `transcribe`, the previews).
 * - `frames`: a folder of `<timecode>.png` frames, replacing any of the same name.
 * - `numbered`: a file whose extension becomes the made file's, numbered
 *   when there are several (`generatedPath`).
 */
export type OutputKind = "file" | "fresh" | "frames" | "numbered";

const OUTPUT_KINDS: Partial<Record<string, OutputKind>> = {
  capture: "frames",
  grab: "frames",
  screenshot: "fresh",
  filmstrip: "fresh",
  waveform: "fresh",
  transcribe: "fresh",
  generate: "numbered",
};

/** What `capture` and `grab` name their images (`08s10f.png`, `0f-08s10f.png`). */
const FRAME_FILE = /^(?:\d+[hmsf])+(?:-(?:\d+[hmsf])+)?\.png$/i;

export type WritePolicy = {
  /** The project the editor has open (main's `lastProject`); null when none is. */
  project: string | null;
  /**
   * Where `project` really was when the editor opened it (see `pinProject`);
   * null when that could not be told. The project is a root tools may write
   * anywhere in only while its path still leads there: an agent's shell can
   * swap the folder for a link to anywhere after `open` was judged.
   */
  pinned: string | null;
  /** What a relative path resolves against (default: this process's working directory, where `present` would write it). */
  base?: string;
  /** The home folder (default: the user's). */
  home?: string;
  /** The temp folders (default: the system's, `/tmp` and `/private/tmp`). */
  temp?: readonly string[];
};

type Root = { given: string; real: string };

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

/** A path on this machine: not a URL, a UNC share, or anything with control characters. */
function localPath(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/u.test(value) &&
    !/^[a-z][a-z\d+.-]+:/i.test(value) &&
    !value.startsWith("\\\\") &&
    !value.startsWith("//")
  );
}

/** What the renderer takes for an absolute path (`isAbsoluteSource`). */
function looksAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Where `path` really is, symlinks resolved, also when it does not exist yet
 * (`future`): then where its nearest existing folder really is, with the
 * rest appended. A dangling symlink is not a new file: it leads somewhere
 * that cannot be judged, so it is null like any other unresolvable path.
 */
async function canonical(path: string, future: boolean): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!future || (error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try {
      await lstat(path);
      return null;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = dirname(path);
    if (parent === path) return null;
    const resolved = await canonical(parent, true);
    return resolved ? join(resolved, basename(path)) : null;
  }
}

async function root(path: string): Promise<Root | null> {
  const given = resolve(path);
  const real = await canonical(given, false);
  return real ? { given, real } : null;
}

const isRoot = (dir: Root | null): dir is Root => dir !== null;

function tempRoots(policy: WritePolicy): Promise<Root[]> {
  const temps = policy.temp ?? [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/private/tmp"])];
  return Promise.all(temps.map(root)).then((dirs) => dirs.filter(isRoot));
}

async function contentRoots(home: Root | null): Promise<Root[]> {
  return home ? (await Promise.all(USER_CONTENT.map((name) => root(join(home.given, name))))).filter(isRoot) : [];
}

/** Where `dir` really is, for `WritePolicy.pinned`: main pins it when the editor opens a project. Null when it cannot be resolved. */
export function pinProject(dir: string): string | null {
  try {
    return realpathSync.native(resolve(dir));
  } catch {
    return null;
  }
}

/**
 * The open project as a root, never by its path alone: only while that path
 * still leads where it was pinned, to a folder rather than a link. One whose
 * folder has changed on disk since is `moved`, which is no project at all.
 */
async function projectRoot(policy: Pick<WritePolicy, "project" | "pinned">): Promise<Root | "moved" | null> {
  if (!policy.project) return null;
  if (!policy.pinned) return "moved";
  const given = resolve(policy.project);
  const [real, entry] = await Promise.all([canonical(given, false), lstat(policy.pinned).catch(() => null)]);
  return real === policy.pinned && entry?.isDirectory() ? { given, real } : "moved";
}

/** Whether `dir` still really is the folder pinned as `pinned`; what reopening a project in a new window asks first. */
export async function stillPinned(dir: string, pinned: string | null): Promise<boolean> {
  return (await projectRoot({ project: dir, pinned })) !== "moved";
}

type Roots = {
  /** The open project, when it is still where it was pinned and could be a project at all. */
  project: Root | null;
  /** The ways the open project was known, when its folder has changed on disk since; null when it has not. */
  moved: string[] | null;
  temps: Root[];
  home: Root | null;
  content: Root[];
};

async function writeRoots(policy: WritePolicy): Promise<Roots> {
  const [project, temps, home] = await Promise.all([projectRoot(policy), tempRoots(policy), root(policy.home ?? homedir())]);
  const content = await contentRoots(home);
  if (project === "moved") {
    const moved = [resolve(policy.project!), ...(policy.pinned ? [policy.pinned] : [])];
    return { project: null, moved, temps, home, content };
  }
  // A folder the user could not mean as one project is none, however it was opened.
  const fit = project !== null && !unfitRoot(project.real, home, [...temps, ...content]);
  return { project: fit ? project : null, moved: null, temps, home, content };
}

/** The disk's root, the home folder or a folder holding it, or a content or temp folder itself: never a project. */
function unfitRoot(path: string, home: Root | null, roots: readonly Root[]): boolean {
  const named = ({ given, real }: Root) => path === given || path === real;
  const holdsHome = home !== null && (within(path, home.real) || within(path, home.given));
  return dirname(path) === path || holdsHome || roots.some(named);
}

/** The part of `path` below the innermost of `roots` holding it, by either spelling; null when none does. */
function below(roots: readonly Root[], path: string): string[] | null {
  let best: string | null = null;
  for (const { given, real } of roots) {
    for (const spelling of [real, given]) {
      if (within(spelling, path) && (best === null || spelling.length > best.length)) best = spelling;
    }
  }
  return best === null ? null : relative(best, path).split(sep).filter(Boolean);
}

/** A sibling the job's files could land on: `stem`, numbered or not, with any extension. */
async function holdsNumbered(target: string): Promise<boolean> {
  const name = basename(target);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(?:-\\d+)?(?:\\.[^.]+)?$`, "i");
  const entries = await readdir(dirname(target)).catch(() => [] as string[]);
  return entries.some((entry) => pattern.test(entry));
}

async function holdsFrames(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.some((entry) => FRAME_FILE.test(entry));
}

/**
 * Why a tool may not write `path` for an agent, or null when it may. Inside
 * the project or a temp folder anything goes but the protected folders;
 * outside them, a new file in one of the user's content folders (not in a
 * hidden folder there), or a fresh file in an existing such folder. While the
 * open project's folder has changed on disk, a path in it is refused as such.
 */
export async function writeRefusal(path: string, kind: OutputKind, policy: WritePolicy): Promise<string | null> {
  if (!localPath(path)) return WRITABLE_PLACES;
  const requested = resolve(policy.base ?? process.cwd(), path);
  const [target, roots] = await Promise.all([canonical(requested, true), writeRoots(policy)]);
  const refusal = target ? await judgeWrite(requested, target, kind, roots) : WRITABLE_PLACES;
  const inMoved = roots.moved?.some((spelling) => within(spelling, requested) || (target !== null && within(spelling, target)));
  return refusal && inMoved ? PROJECT_MOVED : refusal;
}

async function judgeWrite(requested: string, target: string, kind: OutputKind, roots: Roots): Promise<string | null> {
  const writable = [roots.project, ...roots.temps].filter(isRoot);
  const inside = below(writable, target);
  if (inside) {
    const segment = protectedPart([...inside, ...(below(writable, requested) ?? [])]);
    return segment ? protectedMessage(segment) : null;
  }

  const { home, content } = roots;
  const hidden = (parts: string[] | null) => parts?.some((part) => part.startsWith(".")) ?? false;
  const inContentFolder = below(content, target);
  const inContent = inContentFolder !== null && !hidden(inContentFolder) && !hidden(home && below([home], requested));

  const existing = await stat(target).catch(() => null);
  if (!existing) {
    if (!inContent) return WRITABLE_PLACES;
    return kind === "numbered" && (await holdsNumbered(target)) ? REPLACE_OUTSIDE : null;
  }
  if (existing.isDirectory() && (kind === "fresh" || kind === "frames")) {
    if (!inContent) return WRITABLE_PLACES;
    return kind === "frames" && (await holdsFrames(target)) ? REPLACE_OUTSIDE : null;
  }
  return REPLACE_OUTSIDE;
}

/** Throws `writeRefusal`'s refusal of `path` as the tool error agents read: what `present` asks right before each write. */
export async function assertWritable(path: string, kind: OutputKind, policy: WritePolicy): Promise<void> {
  const refusal = await writeRefusal(path, kind, policy);
  if (refusal) throw new DapiError("invalid-input", refusal);
}

/**
 * Why `export` may not write where it does without a `path`, the project's
 * `exports/<id>.<format>`, or null when it may. The file is renamed into
 * place, so a link at its own name is replaced rather than followed; but a
 * link in place of `exports` itself would carry the export out of the
 * project, so that folder must really be in it. With no project open the
 * export refuses itself.
 */
async function defaultExportRefusal(policy: WritePolicy): Promise<string | null> {
  if (!policy.project) return null;
  const { project, moved } = await writeRoots(policy);
  if (moved) return PROJECT_MOVED;
  const exportsDir = join(resolve(policy.project), "exports");
  if (!project) return writeRefusal(exportsDir, "fresh", policy);
  const real = await canonical(exportsDir, true);
  const inside = real ? below([project], real) : null;
  if (!inside) return EXPORTS_OUTSIDE;
  const segment = protectedPart(inside);
  return segment ? protectedMessage(segment) : null;
}

/** What a folder can hold that nobody put there. */
const FOLDER_LITTER = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

async function isEmptyFolder(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => null);
  return entries !== null && entries.every((entry) => FOLDER_LITTER.has(entry));
}

/** Whether `dir`'s package.json records a project id: a folder the app has opened as a project before. */
async function isProject(dir: string): Promise<boolean> {
  try {
    const pkg: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const id = typeof pkg === "object" && pkg !== null ? (pkg as { projectId?: unknown }).projectId : undefined;
    return typeof id === "string" && id.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Why `open` may not make `dir` the project for an agent, or null when it
 * may. Whatever is in the open project can be written, and opening a folder
 * writes its entry file and package.json record, so an agent may open the
 * project again, an existing Cutroom project, any folder in the project or a
 * temp folder, or a new or empty folder where a new file could go. Never the
 * disk's root, the home folder or a folder holding it, a content or temp
 * folder itself, or a path through a protected folder.
 */
export async function openRefusal(dir: string, policy: WritePolicy): Promise<string | null> {
  // A relative folder is the renderer's to refuse, with its own message.
  if (!looksAbsolute(dir)) return null;
  if (!localPath(dir)) return OPEN_PLACES;
  const requested = resolve(dir);
  const target = await canonical(requested, true);
  if (!target) return OPEN_PLACES;
  const segment = protectedPart([...target.split(sep), ...requested.split(sep)]);
  if (segment) return protectedMessage(segment);

  const { project, temps, home, content } = await writeRoots(policy);
  const named = ({ given, real }: Root) => target === given || target === real;
  if (project && named(project)) return null;
  if (unfitRoot(target, home, [...temps, ...content])) return OPEN_PLACES;
  if (below([project, ...temps].filter(isRoot), target)) return null;

  const existing = await stat(target).catch(() => null);
  // A file is not a folder, which opening it says itself.
  if (existing && !existing.isDirectory()) return null;
  if (existing && (await isProject(target))) return null;
  if (existing && !(await isEmptyFolder(target))) return OPEN_EXISTING;
  return (await writeRefusal(target, "fresh", policy)) === null ? null : OPEN_PLACES;
}

/**
 * Refuses a call whose `output`, or `export`'s `path` (or, without one, its
 * default folder), would write where tools may not for an agent, or whose
 * `open` would make such a folder the project. A relative `generate` output
 * is a library path, so it lands under the project's `assets/`; with no
 * project open the renderer refuses it. A relative `export` path or `open`
 * folder is the renderer's to refuse, as it is not absolute. While the open
 * project's folder has changed on disk, every renderer tool but `open` is
 * refused: they work on the open project and write into it by its path,
 * which may now lead anywhere, and `open` is how to get back.
 */
export async function checkToolOutputs(tool: string, args: unknown, policy: WritePolicy): Promise<void> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const { output, path, dir, model, folder } = args as Record<string, unknown>;
  const checks: Array<Promise<string | null>> = [];
  if (typeof output === "string") {
    const library = tool === "generate" && localPath(output) && !looksAbsolute(output);
    if (!library) checks.push(writeRefusal(output, outputKind(tool), policy));
    else if (policy.project) checks.push(writeRefusal(output, "numbered", { ...policy, base: join(policy.project, "assets") }));
  }
  if (tool === "export" && typeof path === "string" && (looksAbsolute(path) || !localPath(path))) {
    checks.push(writeRefusal(path, "file", policy));
  }
  if (tool === "export" && path === undefined) checks.push(defaultExportRefusal(policy));
  if (tool === "open" && typeof dir === "string") checks.push(openRefusal(dir, policy));
  // A library folder is the download's to check against the project; an absolute one is a place on disk the file is made in.
  if (tool === "media_download" && typeof folder === "string" && (looksAbsolute(folder) || !localPath(folder))) {
    checks.push(writeRefusal(folder, "fresh", policy));
  }
  if (policy.project && tool !== "open" && isToolName(tool) && toolByName(tool).environment === "renderer") {
    checks.push(projectRoot(policy).then((project) => (project === "moved" ? PROJECT_MOVED : null)));
  }
  const hosted = tool === "generate" && typeof model === "string" && !isLocalModel(model);
  for (const refusal of await Promise.all(checks)) {
    if (refusal) throw new DapiError("invalid-input", hosted ? `${refusal} ${HOSTED_NOTE}` : refusal);
  }
}

/** How `tool` writes its `output` (see `OutputKind`). */
export function outputKind(tool: string): OutputKind {
  return OUTPUT_KINDS[tool] ?? "file";
}

/** The tools whose files `present` writes into `output` once they have run. */
const PRESENTED = new Set(["capture", "grab", "screenshot", "filmstrip", "waveform", "transcribe"]);

/**
 * Runs a tool for an agent with its outputs held to the rules: checked
 * before it runs and, where `present` writes its files after it has run,
 * checked again right before that, against the same project. A transcript
 * or a capture can take minutes, and an agent's shell may write anywhere in
 * the project: a link planted at the target meanwhile must not carry the
 * write to a file outside it.
 */
export async function guardToolOutputs<T>(tool: string, args: unknown, policy: WritePolicy, run: () => Promise<T>): Promise<T> {
  await checkToolOutputs(tool, args, policy);
  const result = await run();
  if (PRESENTED.has(tool)) await checkToolOutputs(tool, args, policy);
  return result;
}
