/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { parse as parseYaml, parseDocument, isSeq } from "yaml";
import type { LayerDependency } from "./project-version-layers";

type Record = { id: string; path: string; source: string; type: string; [key: string]: unknown };
type Manifest = { assets: Record[]; [key: string]: unknown };
export type VersionAssetPlan = { remap: Map<string, string>; files: Map<string, string>; changed: boolean };

function manifest(text: string | undefined): Manifest {
  if (!text) return { version: 1, folders: [], assets: [] };
  const parsed = parseYaml(text) as Manifest;
  if (!parsed || !Array.isArray(parsed.assets) || parsed.assets.some((asset) => !asset || [asset.id, asset.path, asset.source, asset.type].some((value) => typeof value !== "string" || !value))) {
    throw new Error("The asset library cannot be compared safely. Restore the whole version instead.");
  }
  return parsed;
}

function captionPath(source: string): string {
  if (/^(?:[a-z]+:|\/|\\)/i.test(source) || source.includes("\\") || source.includes("\0")) throw new Error("This caption file is linked outside the project. Its earlier words were not saved in this version.");
  const path = posix.normalize(source);
  if (path.split("/").some((part) => part === ".." || part.startsWith(".")) || !/\.json$/i.test(path)) throw new Error("This caption has an unsupported saved file path.");
  return path;
}

/** Same sampled identity as assets/hash.ts, without depending on browser Blob APIs. */
function captionIdentity(content: string): string {
  const bytes = Buffer.from(content);
  const hash = createHash("sha256").update(String(bytes.length));
  const sample = 1024 * 1024;
  if (bytes.length <= sample * 3) hash.update(bytes);
  else {
    const middle = Math.floor(bytes.length / 2 - sample / 2);
    hash.update(bytes.subarray(0, sample)).update(bytes.subarray(middle, middle + sample)).update(bytes.subarray(bytes.length - sample));
  }
  return hash.digest("hex").slice(0, 16);
}

/** Merge just a restored layer's dependencies. Existing assets and their bytes are never replaced. */
export function planVersionAssets(savedFiles: Map<string, string>, currentFiles: Map<string, string>, dependencies: LayerDependency[]): VersionAssetPlan {
  const result: VersionAssetPlan = { remap: new Map(), files: new Map(), changed: false };
  try {
  if (!dependencies.length) return result;
  const saved = manifest(savedFiles.get("assets.yml"));
  const current = manifest(currentFiles.get("assets.yml"));
  const additions: Record[] = [];
  for (const { path, tag } of dependencies) {
    if (result.remap.has(path)) continue;
    const candidates = saved.assets.filter((asset) => asset.path === path || asset.id === path || asset.source === path);
    if (candidates.length !== 1) throw new Error(`The saved media link “${path}” is missing or ambiguous. Restore the whole version instead.`);
    const asset = candidates[0];
    if (tag === "captions" && asset.type !== "TRANSCRIPT") throw new Error(`The saved caption “${path}” is not a transcript.`);
    const available = [...current.assets, ...additions];
    const matches = available.filter((entry) => entry.path === path || entry.id === path || entry.source === path);
    if (matches.length > 1) throw new Error(`The current media link “${path}” is ambiguous.`);
    const existing = matches[0];
    let savedCaption: string | undefined;
    if (asset.type === "TRANSCRIPT") {
      savedCaption = savedFiles.get(captionPath(asset.source));
      if (savedCaption === undefined) throw new Error(`The saved caption file for “${path}” was unavailable. Restore the whole version or relink its file.`);
      const identical = available.find((entry) => {
        if (entry.type !== "TRANSCRIPT") return false;
        try { return (result.files.get(captionPath(entry.source)) ?? currentFiles.get(captionPath(entry.source))) === savedCaption; }
        catch { return false; }
      });
      if (identical) {
        // The library is keyed by content identity. Reuse a renamed or shared
        // transcript instead of adding a duplicate that would disappear on reload.
        result.remap.set(path, existing === identical ? path : identical.path);
        if (existing !== identical) result.changed = true;
        continue;
      }
    } else {
      const identical = available.find((entry) => entry.type === asset.type && entry.source === asset.source);
      if (identical) {
        result.remap.set(path, existing === identical ? path : identical.path);
        if (existing !== identical) result.changed = true;
        continue;
      }
      if (available.some((entry) => entry.id === asset.id)) throw new Error(`The saved media identity for “${path}” now names a different source. Relink that media or restore the whole version.`);
    }
    result.changed = true;
    // Distinct names and sources avoid changing another current layer that
    // happens to share the saved caption or a now-relinked media name.
    const token = randomUUID().replaceAll("-", "").slice(0, 12);
    const extension = posix.extname(asset.path);
    const base = posix.basename(asset.path, extension);
    const recoveredPath = `Recovered/${base} (${token})${extension}`;
    const recovered: Record = { ...asset, path: recoveredPath };
    if (savedCaption !== undefined) {
      recovered.id = captionIdentity(savedCaption);
      if (available.some((entry) => entry.id === recovered.id)) throw new Error(`The saved caption identity for “${path}” conflicts with another current asset. Reload the project before restoring.`);
      recovered.source = `assets/recovered-${token}.json`;
      delete recovered.stat;
      result.files.set(recovered.source, savedCaption);
    }
    additions.push(recovered);
    result.remap.set(path, recoveredPath);
  }
  if (additions.length) {
    const document = parseDocument(currentFiles.get("assets.yml") ?? "version: 1\nfolders: []\nassets: []\n");
    if (document.errors.length) throw new Error("The current asset library could not be parsed.");
    const assets = document.get("assets", true);
    if (!isSeq(assets)) throw new Error("The current asset library is missing its asset list.");
    for (const asset of additions) assets.add(asset);
    const folders = document.get("folders", true);
    if (isSeq(folders) && !folders.toJSON().includes("Recovered")) folders.add("Recovered");
    result.files.set("assets.yml", document.toString());
  }
  return result;
  } catch (error) {
    if (error instanceof Error && result.changed) Object.assign(error, { assetsChanged: true });
    throw error;
  }
}
