/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// script_lint in main: the checks are pure (packages/dapi/src/script-lint.ts);
// this side reads what they need. The script file is resolved inside the open
// project only, symlinks included. The creator's memory profile supplies a
// remembered reading rate and words to avoid, read from the memory store's
// file and re-scanned the way the digest is. Voice samples are the project's
// own indexed recordings, read from the footage index without transcribing.

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { BRIEF_FILE, DapiError, lintScript, profileHints, scanMemoryText } from "@diffusionstudio/dapi";
import { loadFootageTranscript } from "../../footage-index";

import type { VoiceSample } from "@diffusionstudio/dapi";
import type { MainHandler } from "../handler";

/** The largest script file read. A brief is a few kilobytes. */
export const SCRIPT_FILE_MAX_BYTES = 512 * 1024;
const MEMORY_FILE_MAX_BYTES = 256 * 1024;
const URL_LIKE = /^[a-z][a-z\d+.-]+:/i;

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** `given` as `/`-separated segments inside the project, or an invalid-input error. */
function projectSegments(given: string): string[] {
  if (given.includes("\0")) throw new DapiError("invalid-input", "path: contains a NUL character.");
  if (given.includes("\\")) throw new DapiError("invalid-input", `path: "${given}" uses backslashes; write it with / like brief.md or drafts/brief.md.`);
  if (isAbsolute(given) || /^[a-z]:/i.test(given) || URL_LIKE.test(given)) {
    throw new DapiError("invalid-input", `path: "${given}" is not inside the project. Pass a project-relative path such as brief.md, or the script as text.`);
  }
  const segments = given.split("/").filter((part) => part && part !== ".");
  if (!segments.length) throw new DapiError("invalid-input", "path: name a markdown file in the project, such as brief.md.");
  if (segments.includes("..")) throw new DapiError("invalid-input", `path: "${given}" leaves the project. Pass a project-relative path such as brief.md.`);
  if (!/\.(?:md|markdown|txt)$/i.test(segments[segments.length - 1]!)) throw new DapiError("invalid-input", `path: "${given}" is not a .md or .txt file.`);
  return segments;
}

/** Reads a project-relative script file, refusing anything whose real path is outside the project. */
export async function readProjectScript(project: string, given: string): Promise<{ path: string; text: string }> {
  const segments = projectSegments(given);
  const path = segments.join("/");
  let root: string;
  try { root = await realpath(project); } catch { throw new DapiError("no-project", "The open project's folder cannot be read. Open the project again."); }
  let real: string;
  try { real = await realpath(join(root, ...segments)); } catch (error) {
    if (missing(error)) {
      throw new DapiError("not-found", path === BRIEF_FILE
        ? `The open project has no ${BRIEF_FILE} yet. Write one (format: docs/reference/brief.md) or pass the script as text.`
        : `No ${path} in the open project.`);
    }
    throw new DapiError("not-found", `${path} cannot be read.`);
  }
  if (real !== root && !real.startsWith(root + sep)) throw new DapiError("invalid-input", `path: ${path} resolves outside the open project.`);
  const info = await stat(real);
  if (!info.isFile()) throw new DapiError("wrong-kind", `${path} is not a file.`);
  if (info.size > SCRIPT_FILE_MAX_BYTES) throw new DapiError("invalid-input", `${path} is over ${SCRIPT_FILE_MAX_BYTES / 1024} KB; pass the script section as text.`);
  return { path, text: await readFile(real, "utf8") };
}

/**
 * The creator's profile entries from the memory store, as a session would
 * see them: none while memory is off or paused, and none that fail the
 * safety re-scan. Unreadable or absent memory is simply no profile.
 */
export async function memoryProfile(file: string | undefined): Promise<string[]> {
  if (!file || process.env.CUTROOM_MEMORY === "0") return [];
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MEMORY_FILE_MAX_BYTES) return [];
    const doc = JSON.parse(await readFile(file, "utf8")) as { enabled?: unknown; profile?: unknown } | null;
    if (!doc || doc.enabled === false || !Array.isArray(doc.profile)) return [];
    return doc.profile
      .map((entry) => (entry && typeof (entry as { text?: unknown }).text === "string" ? (entry as { text: string }).text : null))
      .filter((text): text is string => text !== null && scanMemoryText(text).ok);
  } catch {
    return [];
  }
}

type ManifestAsset = { id?: unknown; path?: unknown; source?: unknown; duration?: unknown; type?: unknown };
const normalize = (path: string) => path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");

/** Transcripts of the creator speaking, from the project's footage index; what could not be read becomes a warning. */
export async function voiceSamples(project: string, paths: readonly string[], signal: AbortSignal): Promise<{ samples: VoiceSample[]; warnings: string[] }> {
  const warnings: string[] = [];
  const samples: VoiceSample[] = [];
  let assets: ManifestAsset[] = [];
  try {
    const parsed = parseYaml(await readFile(join(project, "assets.yml"), "utf8")) as { assets?: unknown } | null;
    if (parsed && Array.isArray(parsed.assets)) assets = parsed.assets as ManifestAsset[];
  } catch { /* an unreadable manifest is an empty library */ }
  for (const given of paths) {
    signal.throwIfAborted();
    const name = normalize(given);
    const asset = assets.find((item) => typeof item?.path === "string" && (normalize(item.path) === name || item.id === given));
    if (!asset || typeof asset.source !== "string" || typeof asset.path !== "string") {
      warnings.push(`voiceSample ${given} is not in the project's library; import it and run footage_index first.`);
      continue;
    }
    if (typeof asset.duration !== "number" || !(asset.duration > 0)) {
      warnings.push(`voiceSample ${asset.path} has no audio duration in the library; it needs to be audio or video.`);
      continue;
    }
    if (URL_LIKE.test(asset.source) && !/^[a-z]:[\\/]/i.test(asset.source)) {
      warnings.push(`voiceSample ${asset.path} is remote media; download it into the project and index it first.`);
      continue;
    }
    try {
      const result = await loadFootageTranscript({ dir: project, source: asset.source, duration: asset.duration }, signal);
      if (!result.transcript) warnings.push(`voiceSample ${asset.path} is not indexed yet; run footage_index with that path, then lint again.`);
      else if (!result.transcript.length) warnings.push(`voiceSample ${asset.path} has no recognized speech.`);
      else samples.push({ path: asset.path, segments: result.transcript });
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`voiceSample ${asset.path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { samples, warnings };
}

export const scriptLint: MainHandler<"script_lint"> = async (args, ctx) => {
  if (args.path !== undefined && args.text !== undefined) throw new DapiError("invalid-input", "Pass either path or text, not both.");
  const project = ctx.project?.() ?? null;
  let text: string;
  let source: { kind: "file" | "text"; path?: string };
  if (args.text !== undefined) {
    text = args.text;
    source = { kind: "text" };
  } else {
    if (!project) throw new DapiError("no-project", `No project is open, so there is no ${args.path ?? BRIEF_FILE} to read. Open the video's project, or pass the script as text.`);
    const file = await readProjectScript(project, args.path ?? BRIEF_FILE);
    text = file.text;
    source = { kind: "file", path: file.path };
  }
  const warnings: string[] = [];
  let samples: VoiceSample[] = [];
  if (args.voiceSample?.length && !project) warnings.push("voiceSample needs an open project with indexed footage; it was skipped.");
  else if (args.voiceSample?.length && project) {
    const read = await voiceSamples(project, args.voiceSample, ctx.signal);
    samples = read.samples;
    warnings.push(...read.warnings);
  }
  const hints = profileHints(await memoryProfile(ctx.agentMemoryFile));
  const avoidWords = [...new Set([...(args.avoidWords ?? []).map((word) => word.toLowerCase()), ...hints.avoidWords])];
  return lintScript(text, {
    ...(args.wpm !== undefined ? { wpm: args.wpm, wpmSource: "argument" as const } : hints.wpm !== undefined ? { wpm: hints.wpm, wpmSource: "profile" as const } : {}),
    ...(args.targetSeconds ? { targetSeconds: args.targetSeconds } : {}),
    ...(args.extraStalePhrases?.length ? { extraStalePhrases: args.extraStalePhrases } : {}),
    ...(avoidWords.length ? { avoidWords } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(samples.length ? { voiceSamples: samples } : {}),
    source,
    warnings,
  });
};
