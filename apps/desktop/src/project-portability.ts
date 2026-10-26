/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import { Node, Project, SyntaxKind } from "ts-morph";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createProjectVersion } from "./project-versions";

interface AssetRecord {
  id: string;
  path: string;
  source: string;
  type: string;
  stat?: { size: number; mtime: number };
  [key: string]: unknown;
}
interface Manifest { version: number; assets: AssetRecord[]; [key: string]: unknown }
export interface CollectProjectResult { dir: string; assetCount: number; bytes: number }
export interface RelinkMatch { id: string; path: string; previousSource: string; source: string }
export interface MissingProjectMedia { id: string; path: string; source: string; reason?: string }
export interface AmbiguousProjectMedia extends MissingProjectMedia { candidates: string[] }
export interface RelinkProjectMediaResult {
  /** Binds Apply to the exact manifest, matches, and files shown in a preview. */
  previewToken: string;
  planned: RelinkMatch[];
  missing: MissingProjectMedia[];
  ambiguous: AmbiguousProjectMedia[];
  applied: boolean;
}

interface CopyFile { source: string; destination: string; stat: Stats }
const SKIP = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const URL = /^[a-z][a-z0-9+.-]*:/i;
const windowsAbsolute = (path: string): boolean => /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

async function maybeStat(path: string): Promise<Stats | null> {
  try { return await fs.stat(path); }
  catch (error) { if (missing(error)) return null; throw error; }
}

function projectRelative(path: string): string {
  if (!path || isAbsolute(path) || windowsAbsolute(path) || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => !part || part === ".." || part === "." || part.startsWith(".") || SKIP.has(part.toLowerCase()))) {
    throw new Error(`Unsafe project asset path: ${path}`);
  }
  return path;
}

async function manifestAt(dir: string): Promise<{ manifest: Manifest; text: string | null }> {
  const path = join(dir, "assets.yml");
  let text: string;
  try {
    const info = await fs.lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw new Error("Cannot use an unsafe or oversized asset manifest.");
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return { manifest: { version: 1, folders: [], assets: [] }, text: null };
    throw error;
  }
  const value = parseYaml(text) as Manifest;
  if (!value || typeof value !== "object" || !Array.isArray(value.assets)) throw new Error("Cannot use an invalid assets.yml.");
  const ids = new Set<string>();
  for (const asset of value.assets) {
    if (!asset || typeof asset.id !== "string" || !asset.id || ids.has(asset.id) ||
      typeof asset.path !== "string" || !asset.path || typeof asset.source !== "string" || !asset.source || typeof asset.type !== "string") {
      throw new Error("Cannot use an invalid or duplicate asset record.");
    }
    ids.add(asset.id);
  }
  return { manifest: value, text };
}

function assetLocation(root: string, source: string): string {
  if (windowsAbsolute(source) && process.platform !== "win32") throw new Error(`This asset is linked to another operating system: ${source}`);
  if (URL.test(source) && !windowsAbsolute(source)) throw new Error(`Download this linked asset into the project before collecting: ${source}`);
  return isAbsolute(source) ? source : join(root, projectRelative(source));
}

async function flushDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicText(path: string, content: string, beforeCommit?: () => Promise<void>): Promise<void> {
  const temp = join(dirname(path), `.dstmp-collect-${randomUUID()}`);
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await beforeCommit?.();
    await fs.rename(temp, path);
    await flushDirectory(dirname(path));
  } catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
}

function sameFile(a: Stats, b: Stats | null): boolean {
  return Boolean(b && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

function staticString(node: Node | undefined, depth = 0): string | undefined {
  if (!node || depth > 8) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isJsxExpression(node) || Node.isParenthesizedExpression(node) || Node.isAsExpression(node)) return staticString(node.getExpression(), depth + 1);
  if (Node.isIdentifier(node)) {
    const declaration = node.getSymbol()?.getDeclarations().find(Node.isVariableDeclaration);
    return declaration ? staticString(declaration.getInitializer(), depth + 1) : undefined;
  }
  return undefined;
}

/** Refuse a "portable" claim if authored code can still bypass the copied asset library. */
async function validateSourceReferences(root: string, files: CopyFile[], assets: AssetRecord[]): Promise<void> {
  const library = new Set(assets.flatMap((asset) => [asset.path, asset.id]));
  const copied = new Set(files.map((file) => file.destination));
  const parser = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { noResolve: true } });
  const mediaReference = (value: string | undefined, file: string): void => {
    if (value === undefined) throw new Error(`Cannot collect dynamic media references in ${file}. Use a literal asset-library path first.`);
    if (library.has(value) || value.startsWith("data:")) return;
    if (isAbsolute(value) || windowsAbsolute(value) || URL.test(value)) {
      throw new Error(`Cannot collect a direct external media reference in ${file}: ${value}. Import it into the asset library first.`);
    }
    const path = projectRelative(value.replace(/^\.\//, ""));
    if (!copied.has(path) && !files.some((entry) => entry.destination.startsWith(`${path}/`))) {
      throw new Error(`Cannot find media referenced by ${file}: ${value}`);
    }
  };
  for (const file of files.filter((entry) => SOURCE.test(entry.destination))) {
    if (file.stat.size > 10 * 1024 * 1024) throw new Error(`Source file is too large to check: ${file.destination}`);
    const source = parser.createSourceFile(file.destination, await fs.readFile(file.source, "utf8"));
    const importReference = (value: string | undefined): void => {
      if (!value) throw new Error(`Cannot collect a dynamic import in ${file.destination}.`);
      if (["solid-js", "@diffusionstudio/jsx"].some((name) => value === name || value.startsWith(`${name}/`))) return;
      if (!value.startsWith(".")) throw new Error(`Cannot collect the external dependency ${value} in ${file.destination}.`);
      const target = resolve(root, dirname(file.destination), value);
      if (!inside(root, target)) throw new Error(`An import leaves the project in ${file.destination}: ${value}`);
      const path = relative(root, target).split(sep).join("/");
      if (![path, ...[".ts", ".tsx", ".js", ".jsx", ".json"].map((ext) => path + ext), ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => `${path}/${name}`)].some((candidate) => copied.has(candidate))) {
        throw new Error(`Cannot find the imported file ${value} in ${file.destination}.`);
      }
    };
    for (const item of source.getImportDeclarations()) if (!item.getImportClause()?.isTypeOnly()) importReference(item.getModuleSpecifierValue());
    for (const item of source.getExportDeclarations()) if (item.getModuleSpecifierValue()) importReference(item.getModuleSpecifierValue());
    for (const item of source.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      if (["src", "poster", "fontSrc"].includes(item.getNameNode().getText())) mediaReference(staticString(item.getInitializer()), file.destination);
    }
    for (const item of source.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (["src", "poster", "fontSrc"].includes(item.getName())) mediaReference(staticString(item.getInitializer()), file.destination);
    }
    for (const item of source.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)) {
      if (["src", "poster", "fontSrc"].includes(item.getName())) mediaReference(staticString(item.getNameNode()), file.destination);
    }
    for (const item of source.getDescendantsOfKind(SyntaxKind.JsxSpreadAttribute)) {
      const parent = item.getParent();
      if ((Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent)) && ["video", "audio", "image", "captions", "sequence", "mask"].includes(parent.getTagNameNode().getText())) {
        throw new Error(`Cannot verify spread media properties in ${file.destination}. Use explicit asset-library paths first.`);
      }
    }
    for (const item of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = item.getExpression().getText();
      if (expression === "import" || expression === "require") importReference(staticString(item.getArguments()[0]));
      if (expression === "fetch") mediaReference(staticString(item.getArguments()[0]), file.destination);
    }
    parser.removeSourceFile(source);
  }
}

/** Caller holds withProjectLock. The destination must be new; the original is read-only. */
export async function collectProject(dir: string, target: string): Promise<CollectProjectResult> {
  const root = await fs.realpath(dir);
  if (!isAbsolute(target)) throw new Error("The collected project destination must be an absolute path.");
  const parent = await fs.realpath(dirname(target));
  const destination = join(parent, basename(target));
  if (inside(root, destination) || inside(destination, root)) throw new Error("Choose a destination outside the original project.");
  try { await fs.lstat(destination); throw new Error("The destination already exists. Choose a new folder."); }
  catch (error) { if (!missing(error)) throw error; }

  const { manifest, text: originalManifest } = await manifestAt(root);
  const plan = new Map<string, CopyFile>();
  const casePaths = new Map<string, string>();
  const addTree = async (source: string, destination: string, projectTree: boolean, depth = 0): Promise<void> => {
    if (depth > 50 || plan.size > 100_000) throw new Error("Project contains too many nested files to collect safely.");
    const info = await fs.lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Cannot collect a symbolic link: ${source}. Import its target as a linked asset instead.`);
    if (info.isDirectory()) {
      for (const item of await fs.readdir(source)) {
        if (projectTree && (item.startsWith(".") || SKIP.has(item.toLowerCase()))) continue;
        if (!projectTree && item.startsWith(".")) continue;
        await addTree(join(source, item), destination ? `${destination}/${item}` : item, projectTree, depth + 1);
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Cannot collect a special file: ${source}`);
    projectRelative(destination);
    const existing = casePaths.get(destination.toLowerCase());
    if (existing && existing !== destination) throw new Error(`Project filenames conflict by case: ${existing} and ${destination}`);
    const previous = plan.get(destination);
    if (previous && previous.source !== source) throw new Error(`Collected asset paths conflict: ${destination}`);
    casePaths.set(destination.toLowerCase(), destination);
    plan.set(destination, { source, destination, stat: info });
  };
  await addTree(root, "", true);
  let externalFolder = "assets/collected";
  if ([...plan.keys()].some((path) => path === externalFolder || path.startsWith(`${externalFolder}/`))) externalFolder += `-${randomUUID().slice(0, 8)}`;
  const rewritten = new Map<string, string>();
  for (const asset of manifest.assets) {
    const source = assetLocation(root, asset.source);
    const info = await maybeStat(source);
    if (!info || (asset.type === "SEQUENCE" ? !info.isDirectory() : !info.isFile())) throw new Error(`Missing media: ${asset.path}. Relink it before collecting.`);
    let rel = relative(root, source).split(sep).join("/");
    if (!inside(root, source)) {
      rel = rewritten.get(source) ?? `${externalFolder}/${createHash("sha256").update(source).digest("hex").slice(0, 12)}-${basename(source)}`;
      rewritten.set(source, rel);
      await addTree(await fs.realpath(source), rel, false);
    } else if (!plan.has(rel) && ![...plan.keys()].some((path) => path.startsWith(`${rel}/`))) {
      throw new Error(`Asset is in an excluded project folder: ${asset.path}`);
    }
    asset.source = rel;
  }
  const files = [...plan.values()];
  await validateSourceReferences(root, files, manifest.assets);
  let pkg: Record<string, unknown> = {};
  const packageFile = plan.get("package.json");
  if (packageFile) {
    pkg = JSON.parse(await fs.readFile(packageFile.source, "utf8")) as Record<string, unknown>;
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("Invalid project package.json.");
  }
  if (typeof pkg.main === "string") projectRelative(pkg.main.replace(/^\.\//, ""));
  const stage = await fs.mkdtemp(join(parent, `.dstmp-collect-${basename(destination)}-`));
  let reserved: Stats | undefined;
  let published = false;
  let bytes = 0;
  try {
    for (const file of files) {
      const path = join(stage, file.destination);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.copyFile(file.source, path, constants.COPYFILE_EXCL);
      if (!sameFile(file.stat, await maybeStat(file.source))) throw new Error(`A file changed during collection: ${file.destination}. Try again after saving.`);
      const handle = await fs.open(path, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      bytes += file.stat.size;
    }
    for (const file of files) {
      if (!sameFile(file.stat, await maybeStat(file.source))) throw new Error(`A file changed during collection: ${file.destination}. Try again after saving.`);
    }
    if ((await manifestAt(root)).text !== originalManifest) throw new Error("The asset library changed during collection. Try again after saving.");
    for (const asset of manifest.assets) {
      const info = await fs.stat(join(stage, asset.source));
      if (info.isFile()) asset.stat = { size: info.size, mtime: info.mtimeMs };
    }
    await atomicText(join(stage, "assets.yml"), stringifyYaml(manifest, { lineWidth: 0 }));
    await atomicText(join(stage, "package.json"), JSON.stringify({ ...pkg, projectId: nanoid(), displayName: `${typeof pkg.displayName === "string" ? pkg.displayName : basename(root)} Copy` }, null, 2) + "\n");
    await createProjectVersion(stage, { label: "Collected project", kind: "automatic" });
    // Reserve only after every byte and the baseline are ready. An existing
    // destination is never replaced, including one created during copying.
    // Publication replaces our own still-empty reservation in one rename.
    await fs.mkdir(destination, { mode: 0o700 });
    reserved = await fs.lstat(destination);
    const reservation = await fs.lstat(destination);
    if (reservation.ino !== reserved.ino || reservation.dev !== reserved.dev || (await fs.readdir(destination)).length) {
      throw new Error("The destination changed during collection. The existing folder was preserved.");
    }
    await fs.rename(stage, destination);
    published = true;
    await flushDirectory(parent);
    return { dir: destination, assetCount: manifest.assets.length, bytes };
  } finally {
    if (!published) {
      await fs.rm(stage, { recursive: true, force: true });
      if (reserved) {
        const current = await fs.lstat(destination).catch(() => null);
        if (current?.ino === reserved.ino && current.dev === reserved.dev) await fs.rmdir(destination).catch(() => {});
      }
    }
  }
}

async function sampleHash(path: string, info: Stats): Promise<string> {
  const hash = createHash("sha256").update(String(info.size));
  const size = 1024 * 1024;
  const handle = await fs.open(path, "r");
  try {
    const chunks = info.size <= size * 3 ? [{ offset: 0, length: info.size }] : [0, Math.floor(info.size / 2 - size / 2), info.size - size].map((offset) => ({ offset, length: size }));
    for (const chunk of chunks) {
      const data = Buffer.alloc(chunk.length);
      let read = 0;
      while (read < data.length) {
        const result = await handle.read(data, read, data.length - read, chunk.offset + read);
        if (!result.bytesRead) throw new Error(`Media changed while checking it: ${path}`);
        read += result.bytesRead;
      }
      hash.update(data);
    }
  } finally { await handle.close(); }
  return hash.digest("hex").slice(0, 16);
}

/** Caller holds withProjectLock. Apply requires the token from a reviewed preview. */
export async function relinkProjectMedia(dir: string, searchDir: string, apply = false, expectedPreview?: string): Promise<RelinkProjectMediaResult> {
  if (apply && !expectedPreview) throw new Error("Search for missing media and review the matches before applying.");
  const root = await fs.realpath(dir);
  const search = await fs.realpath(searchDir);
  if (!(await fs.stat(search)).isDirectory()) throw new Error("Choose a folder to search for missing media.");
  const { manifest, text } = await manifestAt(root);
  const result: RelinkProjectMediaResult = { previewToken: "", planned: [], missing: [], ambiguous: [], applied: false };
  const candidates = new Map<string, Array<{ path: string; stat: Stats }>>();
  let count = 0;
  async function walk(folder: string, depth = 0): Promise<void> {
    if (depth > 50) throw new Error("The media search folder is nested too deeply.");
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (item.name.startsWith(".") || SKIP.has(item.name.toLowerCase()) || item.isSymbolicLink()) continue;
      if (++count > 100_000) throw new Error("Choose a smaller folder to search for missing media.");
      const path = join(folder, item.name);
      if (item.isDirectory()) await walk(path, depth + 1);
      else if (item.isFile()) {
        const key = item.name.toLowerCase();
        const list = candidates.get(key) ?? [];
        list.push({ path, stat: await fs.stat(path) });
        candidates.set(key, list);
      }
    }
  }
  await walk(search);
  const checked = new Map<string, Stats>();
  for (const asset of manifest.assets) {
    if (/^https?:\/\//i.test(asset.source)) continue;
    const source = assetLocation(root, asset.source);
    const existing = await maybeStat(source);
    if (existing && (asset.type === "SEQUENCE" ? existing.isDirectory() : existing.isFile())) continue;
    const missingAsset: MissingProjectMedia = { id: asset.id, path: asset.path, source: asset.source };
    if (asset.type === "SEQUENCE") { result.missing.push({ ...missingAsset, reason: "Relink this image sequence folder individually." }); continue; }
    if (!/^[a-f0-9]{16}$/.test(asset.id)) {
      result.missing.push({ ...missingAsset, reason: "This older asset has no recorded content identity. Relink it individually." });
      continue;
    }
    const matches = [];
    for (const candidate of candidates.get(basename(source).toLowerCase()) ?? []) {
      if (asset.stat?.size !== undefined && asset.stat.size !== candidate.stat.size) continue;
      if (await sampleHash(candidate.path, candidate.stat) !== asset.id) continue;
      matches.push(candidate);
    }
    if (!matches.length) { result.missing.push({ ...missingAsset, reason: "No file with matching name and recorded identity was found." }); continue; }
    if (matches.length > 1) { result.ambiguous.push({ ...missingAsset, candidates: matches.map((match) => match.path).sort() }); continue; }
    const match = matches[0];
    const replacement = inside(root, match.path) ? relative(root, match.path).split(sep).join("/") : match.path;
    result.planned.push({ id: asset.id, path: asset.path, previousSource: asset.source, source: replacement });
    checked.set(match.path, match.stat);
    asset.source = replacement;
    asset.stat = { size: match.stat.size, mtime: match.stat.mtimeMs };
  }
  result.previewToken = createHash("sha256").update(JSON.stringify({
    root, search, manifest: text,
    planned: result.planned, missing: result.missing, ambiguous: result.ambiguous,
    files: [...checked].sort(([a], [b]) => a.localeCompare(b)).map(([path, info]) => ({
      path, ino: info.ino, dev: info.dev, size: info.size, mtime: info.mtimeMs,
    })),
  })).digest("hex");
  if (apply && expectedPreview !== result.previewToken) throw new Error("The media matches changed since your preview. Search again and review the new matches before applying.");
  if (!apply || !result.planned.length) return result;
  const assertUnchanged = async (): Promise<void> => {
    for (const [path, info] of checked) {
      if (!sameFile(info, await maybeStat(path))) throw new Error("Media changed during relinking. Search again before applying.");
    }
    if ((await manifestAt(root)).text !== text) throw new Error("The asset library changed during relinking. Search again before applying.");
    for (const match of result.planned) {
      if (await maybeStat(assetLocation(root, match.previousSource))) throw new Error("An original file reappeared during relinking. Search again before applying.");
    }
  };
  await assertUnchanged();
  await createProjectVersion(root, { label: "Before relinking media", kind: "manual", deduplicate: false });
  // Creating a checkpoint and syncing the replacement can take time. Recheck
  // external files after both, immediately before publishing the new manifest.
  await atomicText(join(root, "assets.yml"), stringifyYaml(manifest, { lineWidth: 0 }), assertUnchanged);
  result.applied = true;
  await createProjectVersion(root, { label: "Relinked media", kind: "automatic" }).catch(() => {});
  return result;
}
