/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Portable editing history. Original footage and project identity are never rewritten. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { inspectSourceLayers, restoreLayerSource } from "./project-version-layers";
import type { VersionLayerSource } from "./project-version-layers";
import { planVersionAssets } from "./project-version-assets";
import { validateVersionPreview } from "./project-version-preview";

export type ProjectVersionKind = "automatic" | "manual" | "before-restore";
export interface ProjectVersion {
  id: string;
  createdAt: string;
  label: string;
  kind: ProjectVersionKind;
  fingerprint: string;
  fileCount: number;
  bytes: number;
  /** Linked captions outside the project remain linked, just like original footage. */
  externalTranscripts: number;
}

interface SnapshotFile { path: string; content: string; hash: string }
interface Snapshot extends ProjectVersion { schema: 1; files: SnapshotFile[]; preview?: string }
export interface ProjectVersionCreateOptions {
  label?: string;
  kind?: ProjectVersionKind;
  deduplicate?: boolean;
  preview?: string;
  expectedFingerprint?: string;
}
export interface ProjectVersionInspection {
  version: ProjectVersion;
  fingerprint: string;
  preview?: string;
  files: Array<{ path: string; status: "added" | "removed" | "changed" | "unchanged"; before?: string; after?: string; truncated?: boolean }>;
  layers: Array<Omit<VersionLayerSource, "dependencies"> & { truncated?: boolean }>;
  /** Very large projects retain complete restore data; only this display is bounded. */
  truncated?: boolean;
}
export interface ProjectVersionRestoreResult { version: ProjectVersion; checkpoint: ProjectVersion; paths: string[] }
interface RestoreFile { path: string; before: string | null; after: string | null }
interface RestoreJournal {
  schema: 1;
  phase: "applying" | "committed";
  versionId: string;
  checkpointId: string;
  files: RestoreFile[];
}

export const PROJECT_VERSION_LIMIT = 50;
export const PROJECT_VERSION_BYTES_LIMIT = 100 * 1024 * 1024;
const SNAPSHOT_BYTES_LIMIT = 20 * 1024 * 1024;
const FILE_BYTES_LIMIT = 10 * 1024 * 1024;
const FILE_COUNT_LIMIT = 2000;
const STORE = ".cutroom/versions";
const JOURNAL = "restore-journal.json";
/** A virtual snapshot entry; it is merged into package.json, never written as a file. */
const SETTINGS = "@project-settings.json";
const ID = /^\d{13}-[a-f0-9-]{36}$/;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const queues = new Map<string, Promise<unknown>>();
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

async function serial<T>(dir: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.realpath(dir);
  const previous = queues.get(root) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => run(root));
  queues.set(root, work);
  try { return await work; }
  finally { if (queues.get(root) === work) queues.delete(root); }
}

function validatePath(path: string): string {
  if (path === SETTINGS) return path;
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.includes(":")) {
    throw new Error(`Unsafe project history path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
    parts.some((part) => SKIP_DIRS.has(part.toLowerCase()))) {
    throw new Error(`Unsafe project history path: ${path}`);
  }
  if (path !== "assets.yml" && !SOURCE.test(path) && !/\.json$/i.test(path)) {
    throw new Error(`Unsupported project history file: ${path}`);
  }
  // A damaged or hand-edited snapshot must never replace the project record.
  if (["package.json", "package-lock.json", "tsconfig.json"].includes(parts[parts.length - 1].toLowerCase())) {
    throw new Error(`Project history cannot replace ${path}.`);
  }
  return path;
}

/** Reject symlinks in every existing component, including the final file. */
async function safePath(root: string, path: string, internal = false): Promise<string> {
  if (!internal) validatePath(path);
  if (path === SETTINGS) path = "package.json";
  const parts = path.split("/");
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    const info = await fs.lstat(cursor).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Project history refuses a symbolic link: ${path}`);
    if (info && i < parts.length - 1 && !info.isDirectory()) throw new Error(`Not a folder: ${cursor}`);
  }
  return cursor;
}

async function storePath(root: string): Promise<string> {
  const path = await safePath(root, STORE, true);
  await fs.mkdir(path, { recursive: true });
  return path;
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not permit opening directories for fsync. File fsync + rename
  // is still used there; supported platforms also flush the directory entry.
  if (process.platform === "win32") return;
  const handle = await fs.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableWrite(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.dstmp-version-${randomUUID()}`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readMaybe(root: string, path: string): Promise<string | null> {
  if (path === SETTINGS) {
    const pkg = await readPackage(root);
    return JSON.stringify({ present: Object.hasOwn(pkg, "diffusion"), value: pkg.diffusion ?? null });
  }
  const target = await safePath(root, path);
  try {
    const info = await fs.stat(target);
    if (!info.isFile()) throw new Error(`Project history expected a file: ${path}`);
    if (info.size > FILE_BYTES_LIMIT) throw new Error(`Project history file exceeds 10 MB: ${path}`);
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readPackage(root: string): Promise<Record<string, unknown>> {
  const path = await safePath(root, "package.json", true);
  try {
    if ((await fs.stat(path)).size > FILE_BYTES_LIMIT) throw new Error("Project package.json exceeds 10 MB.");
    const pkg: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("Project package.json must contain an object.");
    return pkg as Record<string, unknown>;
  } catch (error) { if (isMissing(error)) return {}; throw error; }
}

function settings(content: string): { present: boolean; value: unknown } {
  const value = JSON.parse(content) as { present?: unknown; value?: unknown };
  if (!value || typeof value.present !== "boolean" || !Object.hasOwn(value, "value")) throw new Error("Invalid project settings snapshot.");
  return { present: value.present, value: value.value };
}

async function capture(root: string): Promise<{ files: SnapshotFile[]; fingerprint: string; bytes: number; externalTranscripts: number }> {
  const names = new Set<string>([SETTINGS]);
  async function walk(folder: string): Promise<void> {
    for (const item of await fs.readdir(join(root, folder), { withFileTypes: true })) {
      if (item.name.startsWith(".") || SKIP_DIRS.has(item.name.toLowerCase())) continue;
      const path = folder ? `${folder}/${item.name}` : item.name;
      if (item.isSymbolicLink()) {
        if (SOURCE.test(item.name)) throw new Error(`Project history refuses a symbolic link: ${path}`);
        continue;
      }
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && SOURCE.test(item.name)) names.add(path);
      if (names.size > FILE_COUNT_LIMIT) throw new Error("Project history exceeds 2,000 editing files.");
    }
  }
  await walk("");
  const manifest = await readMaybe(root, "assets.yml");
  let externalTranscripts = 0;
  if (manifest !== null) {
    names.add("assets.yml");
    const data = parseYaml(manifest) as { assets?: Array<{ type?: string; source?: string }> } | null;
    if (data?.assets !== undefined && !Array.isArray(data.assets)) throw new Error("Cannot save history: assets.yml has an invalid asset list.");
    for (const asset of data?.assets ?? []) {
      if (asset?.type !== "TRANSCRIPT" || typeof asset.source !== "string") continue;
      const target = resolve(root, asset.source);
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        if (!isAbsolute(asset.source)) throw new Error(`Caption path leaves the project: ${asset.source}`);
        externalTranscripts++;
        continue;
      }
      const path = rel.split(sep).join("/");
      validatePath(path);
      if (path === SETTINGS) throw new Error("A caption cannot use the reserved project settings path.");
      if (!/\.json$/i.test(path)) throw new Error(`Unsupported caption history file: ${path}`);
      names.add(path);
    }
  }
  const files: SnapshotFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const path of [...names].sort()) {
    if (seen.has(path.toLowerCase())) throw new Error(`Project history contains case-conflicting paths: ${path}`);
    seen.add(path.toLowerCase());
    const content = path === "assets.yml" ? manifest : await readMaybe(root, path);
    // Missing linked caption files remain missing; history still protects the
    // source and manifest so a broken media link never disables all recovery.
    if (content === null) continue;
    bytes += Buffer.byteLength(content);
    if (bytes > SNAPSHOT_BYTES_LIMIT) throw new Error("Project history exceeds 20 MB of editing data.");
    files.push({ path, content, hash: digest(content) });
  }
  if (files.length > FILE_COUNT_LIMIT) throw new Error("Project history exceeds 2,000 editing files.");
  const fingerprint = digest(JSON.stringify(files.map(({ path, hash }) => [path, hash])));
  return { files, fingerprint, bytes, externalTranscripts };
}

function publicVersion(snapshot: Snapshot): ProjectVersion {
  const { files: _files, schema: _schema, preview: _preview, ...version } = snapshot;
  return version;
}

function parseSnapshot(text: string, expectedId: string): Snapshot {
  const value = JSON.parse(text) as Snapshot;
  if (value?.schema !== 1 || value.id !== expectedId || !ID.test(value.id) || !Array.isArray(value.files) ||
    value.files.length > FILE_COUNT_LIMIT || !["automatic", "manual", "before-restore"].includes(value.kind) ||
    typeof value.label !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isInteger(value.externalTranscripts) || value.externalTranscripts < 0) {
    throw new Error("Invalid project version.");
  }
  const names = new Set<string>();
  let bytes = 0;
  for (const file of value.files) {
    validatePath(file.path);
    const key = file.path.toLowerCase();
    if (names.has(key) || typeof file.content !== "string" || digest(file.content) !== file.hash) throw new Error("Project version is damaged.");
    if (file.path === SETTINGS) settings(file.content);
    names.add(key);
    bytes += Buffer.byteLength(file.content);
    if (Buffer.byteLength(file.content) > FILE_BYTES_LIMIT || bytes > SNAPSHOT_BYTES_LIMIT) throw new Error("Project version is too large.");
  }
  if (value.preview !== undefined) bytes += Buffer.byteLength(validateVersionPreview(value.preview));
  if (bytes > SNAPSHOT_BYTES_LIMIT) throw new Error("Project version is too large.");
  const fingerprint = digest(JSON.stringify(value.files.map(({ path, hash }) => [path, hash])));
  if (value.fingerprint !== fingerprint || value.bytes !== bytes || value.fileCount !== value.files.length) throw new Error("Project version is damaged.");
  return value;
}

async function load(root: string, id: string): Promise<Snapshot> {
  if (!ID.test(id)) throw new Error("Invalid project version identifier.");
  const path = await safePath(root, `${STORE}/${id}.json`, true);
  if ((await fs.stat(path)).size > SNAPSHOT_BYTES_LIMIT * 6) throw new Error("Project version is too large.");
  return parseSnapshot(await fs.readFile(path, "utf8"), id);
}

async function snapshots(root: string): Promise<Snapshot[]> {
  const dir = await storePath(root);
  const result: Snapshot[] = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
    // One damaged version should not conceal other usable recovery points.
    try { result.push(await load(root, name.slice(0, -5))); }
    catch { /* Restoring a damaged id still gives an explicit error. */ }
  }
  return result.sort((a, b) => b.id.localeCompare(a.id));
}

async function prune(root: string, protectedIds: string[] = []): Promise<void> {
  const versions = await snapshots(root);
  const protectedVersions = versions.filter((version) => protectedIds.includes(version.id));
  let count = protectedVersions.length;
  let bytes = protectedVersions.reduce((total, version) => total + version.bytes, 0);
  for (const version of versions) {
    if (protectedIds.includes(version.id)) continue;
    if (count + 1 > PROJECT_VERSION_LIMIT || bytes + version.bytes > PROJECT_VERSION_BYTES_LIMIT) {
      await fs.rm(await safePath(root, `${STORE}/${version.id}.json`, true));
    } else { count++; bytes += version.bytes; }
  }
}

async function create(root: string, options: ProjectVersionCreateOptions, captured?: Awaited<ReturnType<typeof capture>>, protect: string[] = []): Promise<Snapshot> {
  const state = captured ?? await capture(root);
  if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== state.fingerprint) throw new Error("The project changed while the version preview was captured. Save your changes and try again.");
  if (options.preview !== undefined && !options.expectedFingerprint) throw new Error("A version preview needs the fingerprint of the saved project it depicts.");
  const preview = options.preview === undefined ? undefined : validateVersionPreview(options.preview);
  const bytes = state.bytes + (preview ? Buffer.byteLength(preview) : 0);
  if (bytes > SNAPSHOT_BYTES_LIMIT) throw new Error("Project version and its preview exceed 20 MB.");
  const previous = (await snapshots(root))[0];
  if (options.deduplicate !== false && previous?.fingerprint === state.fingerprint) return previous;
  const now = new Date();
  const snapshot: Snapshot = {
    schema: 1,
    id: `${Math.max(now.getTime(), previous ? Number(previous.id.slice(0, 13)) + 1 : 0)}-${randomUUID()}`,
    createdAt: now.toISOString(),
    label: options.label?.trim().slice(0, 160) || "Saved version",
    kind: options.kind ?? "automatic",
    fileCount: state.files.length,
    ...state,
    bytes,
    ...(preview ? { preview } : {}),
  };
  const dir = await storePath(root);
  await durableWrite(join(dir, `${snapshot.id}.json`), JSON.stringify(snapshot));
  // A full history disk must not report a successfully saved snapshot as lost.
  await prune(root, [...protect, snapshot.id]).catch(() => {});
  return snapshot;
}

async function assertNoPendingRestore(root: string): Promise<void> {
  const journal = await safePath(root, `${STORE}/${JOURNAL}`, true);
  try { await fs.access(journal); }
  catch (error) { if (isMissing(error)) return; throw error; }
  throw new Error("An interrupted version restore needs recovery before editing can continue.");
}

export async function listProjectVersions(dir: string): Promise<ProjectVersion[]> {
  return serial(dir, async (root) => (await snapshots(root)).map(publicVersion));
}

export async function createProjectVersion(dir: string, options: ProjectVersionCreateOptions = {}): Promise<ProjectVersion> {
  return serial(dir, async (root) => {
    await assertNoPendingRestore(root);
    return publicVersion(await create(root, options));
  });
}

export async function projectVersionFingerprint(dir: string): Promise<string> {
  return serial(dir, async (root) => {
    await assertNoPendingRestore(root);
    return (await capture(root)).fingerprint;
  });
}

const PREVIEW_TEXT_LIMIT = 512_000;
const PREVIEW_ENTRY_LIMIT = 8_000;
const PREVIEW_LAYER_LIMIT = 500;

/** Read-only comparison. Historical project code is parsed, never compiled or run. */
export async function inspectProjectVersion(dir: string, id: string): Promise<ProjectVersionInspection> {
  return serial(dir, async (root) => {
    await assertNoPendingRestore(root);
    const version = await load(root, id);
    const current = await capture(root);
    const savedFiles = new Map(version.files.map((file) => [file.path, file.content]));
    const currentFiles = new Map(current.files.map((file) => [file.path, file.content]));
    const result: ProjectVersionInspection = { version: publicVersion(version), fingerprint: current.fingerprint, preview: version.preview, files: [], layers: [] };
    let remaining = PREVIEW_TEXT_LIMIT;
    const snippet = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
      const limit = Math.min(remaining, PREVIEW_ENTRY_LIMIT);
      const text = value.slice(0, limit);
      remaining -= text.length;
      if (text.length < value.length) result.truncated = true;
      return text;
    };
    // Layer previews first: these are the user's recovery choices. File
    // previews use the remaining budget; full snapshots remain untouched.
    for (const [file, source] of savedFiles) {
      if (!SOURCE.test(file)) continue;
      for (const layer of inspectSourceLayers(file, source, currentFiles.get(file))) {
        if (result.layers.length >= PREVIEW_LAYER_LIMIT) { result.truncated = true; break; }
        if (layer.canRestore) {
          try {
            const assets = planVersionAssets(savedFiles, currentFiles, layer.dependencies);
            if (assets.changed && layer.status === "unchanged") layer.status = "changed";
          } catch (error) {
            layer.canRestore = false; layer.reason = (error as Error).message;
            if ((error as Error & { assetsChanged?: boolean }).assetsChanged && layer.status === "unchanged") layer.status = "changed";
          }
        }
        const { dependencies: _dependencies, ...entry } = layer;
        const savedSource = snippet(entry.savedSource)!;
        const currentSource = snippet(entry.currentSource);
        result.layers.push({ ...entry, savedSource, currentSource, truncated: savedSource.length !== entry.savedSource.length || currentSource?.length !== entry.currentSource?.length });
      }
      if (result.layers.length >= PREVIEW_LAYER_LIMIT) break;
    }
    for (const path of [...new Set([...savedFiles.keys(), ...currentFiles.keys()])].sort()) {
      const saved = savedFiles.get(path);
      const now = currentFiles.get(path);
      const before = snippet(saved);
      const after = snippet(now);
      result.files.push({ path, status: saved === now ? "unchanged" : saved === undefined ? "added" : now === undefined ? "removed" : "changed", before, after, truncated: before?.length !== saved?.length || after?.length !== now?.length });
    }
    return result;
  });
}

export async function restoreProjectVersionLayer(dir: string, id: string, options: { file: string; layerId: string; expectedFingerprint: string }): Promise<ProjectVersionRestoreResult> {
  return serial(dir, async (root) => {
    await assertNoPendingRestore(root);
    validatePath(options.file);
    if (!SOURCE.test(options.file) || !options.layerId || typeof options.expectedFingerprint !== "string" || !options.expectedFingerprint) throw new Error("A saved layer and current project fingerprint are required.");
    const version = await load(root, id);
    const current = await capture(root);
    if (current.fingerprint !== options.expectedFingerprint) throw new Error("The project changed while version history was open. Refresh the comparison before restoring a layer.");
    const savedFiles = new Map(version.files.map((file) => [file.path, file.content]));
    const currentFiles = new Map(current.files.map((file) => [file.path, file.content]));
    const savedSource = savedFiles.get(options.file);
    const currentSource = currentFiles.get(options.file);
    if (savedSource === undefined || currentSource === undefined) throw new Error("The layer's source file is missing. Restore the whole version instead.");
    const draft = restoreLayerSource(savedSource, currentSource, options.layerId);
    const assets = planVersionAssets(savedFiles, currentFiles, draft.dependencies);
    const source = restoreLayerSource(savedSource, currentSource, options.layerId, assets.remap).source;
    if (source === currentSource && !assets.changed) throw new Error("This layer already matches the saved version.");
    const merged = new Map(currentFiles);
    for (const [path, content] of assets.files) {
      validatePath(path);
      // A randomly named recovery asset must never overwrite an orphan file
      // absent from the current manifest (nor follow a symbolic link).
      if (path !== "assets.yml" && await readMaybe(root, path) !== null) throw new Error("A recovered caption filename is already in use. Try restoring again.");
      merged.set(path, content);
    }
    merged.set(options.file, source);
    const files = [...merged].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, content]) => ({ path, content, hash: digest(content) }));
    const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    if (files.length > FILE_COUNT_LIMIT || bytes > SNAPSHOT_BYTES_LIMIT || files.some((file) => Buffer.byteLength(file.content) > FILE_BYTES_LIMIT)) throw new Error("Restoring this layer would exceed the project history limits.");
    const fingerprint = digest(JSON.stringify(files.map(({ path, hash }) => [path, hash])));
    // Existing crash recovery validates both sides against preserved
    // snapshots. Store the merged after-state in that same history first.
    const target = await create(root, { label: `Restore layer ${options.layerId} from ${version.label}`, kind: "automatic", deduplicate: false }, { files, fingerprint, bytes, externalTranscripts: current.externalTranscripts }, [version.id]);
    return restoreCapturedVersion(root, target, current, { expectedFingerprint: options.expectedFingerprint });
  });
}

async function apply(root: string, file: RestoreFile, direction: "before" | "after"): Promise<void> {
  const path = await safePath(root, file.path);
  const content = file[direction];
  if (file.path === SETTINGS) {
    // Read again at the last moment: unrelated package metadata can change
    // while history is open and must survive an editing-settings restore.
    const pkg = await readPackage(root);
    const value = content === null ? { present: false, value: null } : settings(content);
    if (value.present) pkg.diffusion = value.value;
    else delete pkg.diffusion;
    await durableWrite(path, JSON.stringify(pkg, null, 2) + "\n");
    return;
  }
  if (content === null) {
    await fs.rm(path, { force: true });
    await syncDirectory(dirname(path));
  } else await durableWrite(path, content);
}

async function rollback(root: string, journal: RestoreJournal): Promise<void> {
  // Check every file before changing any. An external edit made during a
  // crash/restart must never be silently overwritten by automatic recovery.
  for (const file of journal.files) {
    const current = await readMaybe(root, file.path);
    if (current !== file.before && current !== file.after) {
      throw new Error(`Restore recovery stopped because ${file.path} changed outside UVE. Your current file and the before-restore version are preserved.`);
    }
  }
  for (const file of [...journal.files].reverse()) {
    const current = await readMaybe(root, file.path);
    if (current !== file.before) {
      if (current !== file.after) throw new Error(`Restore recovery stopped: ${file.path} changed outside UVE.`);
      await apply(root, file, "before");
    }
  }
}

async function validateJournalSnapshots(root: string, journal: RestoreJournal): Promise<void> {
  const before = new Map((await load(root, journal.checkpointId)).files.map((file) => [file.path, file.content]));
  const after = new Map((await load(root, journal.versionId)).files.map((file) => [file.path, file.content]));
  for (const file of journal.files) {
    if (file.before !== (before.get(file.path) ?? null) || file.after !== (after.get(file.path) ?? null)) {
      throw new Error("The restore recovery journal does not match its preserved versions. No project files were changed.");
    }
  }
}

function parseJournal(text: string): RestoreJournal {
  const value = JSON.parse(text) as RestoreJournal;
  if (value?.schema !== 1 || !["applying", "committed"].includes(value.phase) || !ID.test(value.versionId) || !ID.test(value.checkpointId) ||
    !Array.isArray(value.files) || value.files.length > FILE_COUNT_LIMIT * 2) throw new Error("Invalid restore recovery journal.");
  const paths = new Set<string>();
  for (const file of value.files) {
    validatePath(file.path);
    if (paths.has(file.path.toLowerCase()) || (file.before !== null && typeof file.before !== "string") || (file.after !== null && typeof file.after !== "string")) {
      throw new Error("Invalid restore recovery journal.");
    }
    paths.add(file.path.toLowerCase());
  }
  return value;
}

export async function recoverProjectVersionRestore(dir: string): Promise<{ recovered: boolean; paths: string[] }> {
  return serial(dir, async (root) => {
    const path = await safePath(root, `${STORE}/${JOURNAL}`, true);
    let text: string;
    try {
      if ((await fs.stat(path)).size > SNAPSHOT_BYTES_LIMIT * 12) throw new Error("Restore recovery journal is too large.");
      text = await fs.readFile(path, "utf8");
    }
    catch (error) { if (isMissing(error)) return { recovered: false, paths: [] }; throw error; }
    const journal = parseJournal(text);
    await validateJournalSnapshots(root, journal);
    if (journal.phase === "applying") await rollback(root, journal);
    await fs.rm(path);
    await syncDirectory(dirname(path));
    return { recovered: true, paths: journal.files.map((file) => file.path === SETTINGS ? "package.json" : file.path) };
  });
}

async function restoreCapturedVersion(root: string, version: Snapshot, current: Awaited<ReturnType<typeof capture>>, options: { expectedFingerprint?: string }): Promise<ProjectVersionRestoreResult> {
    const id = version.id;
    if (options.expectedFingerprint && options.expectedFingerprint !== current.fingerprint) {
      throw new Error("The project changed while version history was open. Save your changes and try restoring again.");
    }
    // A caption from an older version can still exist on disk after its
    // manifest entry was removed. Preserve those bytes too before replacing
    // it; otherwise restoring that version would either lose the orphan or
    // falsely report an external-write conflict.
    for (const file of version.files) {
      if (current.files.some((existing) => existing.path === file.path)) continue;
      const content = await readMaybe(root, file.path);
      if (content !== null) {
        current.files.push({ path: file.path, content, hash: digest(content) });
        current.bytes += Buffer.byteLength(content);
        if (current.bytes > SNAPSHOT_BYTES_LIMIT) throw new Error("Project history exceeds 20 MB of editing data.");
      }
    }
    current.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    current.fingerprint = digest(JSON.stringify(current.files.map(({ path, hash }) => [path, hash])));
    const before = new Map(current.files.map((file) => [file.path, file.content]));
    const after = new Map(version.files.map((file) => [file.path, file.content]));
    const files: RestoreFile[] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      await safePath(root, path);
      const old = before.get(path) ?? null;
      const next = after.get(path) ?? null;
      if (old !== next) files.push({ path, before: old, after: next });
    }
    const checkpoint = await create(root, { label: `Before restoring ${version.label}`, kind: "before-restore", deduplicate: false }, current, [id]);
    const journal: RestoreJournal = { schema: 1, phase: "applying", versionId: id, checkpointId: checkpoint.id, files };
    const path = await safePath(root, `${STORE}/${JOURNAL}`, true);
    await durableWrite(path, JSON.stringify(journal));
    try {
      for (const file of files) {
        if (await readMaybe(root, file.path) !== file.before) throw new Error(`Restore stopped because ${file.path} changed outside UVE.`);
        await apply(root, file, "after");
      }
      journal.phase = "committed";
      await durableWrite(path, JSON.stringify(journal));
    } catch (error) {
      try {
        // A directory fsync can fail after the commit marker's rename. Put
        // the journal back into rollback mode durably before undoing files,
        // so a second crash cannot misclassify a partial rollback as committed.
        if (journal.phase === "committed") {
          journal.phase = "applying";
          await durableWrite(path, JSON.stringify(journal));
        }
        await rollback(root, journal);
        await fs.rm(path);
        await syncDirectory(dirname(path));
      } catch (recoveryError) {
        throw new Error(`${(error as Error).message} Recovery is pending: ${(recoveryError as Error).message}`, { cause: error });
      }
      throw error;
    }
    // After the commit marker, cleanup failure is safe to finish at next open.
    await fs.rm(path).then(() => syncDirectory(dirname(path))).catch(() => {});
    return { version: publicVersion(version), checkpoint: publicVersion(checkpoint), paths: files.map((file) => file.path === SETTINGS ? "package.json" : file.path) };
 }

export async function restoreProjectVersion(dir: string, id: string, options: { expectedFingerprint?: string } = {}): Promise<ProjectVersionRestoreResult> {
  return serial(dir, async (root) => {
    await assertNoPendingRestore(root);
    return restoreCapturedVersion(root, await load(root, id), await capture(root), options);
  });
}
