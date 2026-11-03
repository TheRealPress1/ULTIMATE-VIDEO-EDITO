/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `sound_analyze`: one earshot listening tool per action, with the fields
// that action takes passed on under earshot's own names, every path resolved
// (library, project, absolute) and checked first. `sheet` draws into a fresh
// temp folder; its picture comes back inline, and the folder is cleared a
// day later (see cache.ts), or at once when the call fails.

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SOUND_ANALYZE_FIELDS } from "@diffusionstudio/dapi";
import { SHEET_TEMP_PREFIX } from "./cache";
import { resolveCues, resolveSoundFiles, resolveSoundPath } from "./paths";
import { sfxSlug } from "./sound-effects";

import type { SoundAction, ToolArgs, ToolResult } from "@diffusionstudio/dapi";
import type { EarshotService } from "./index";

const MIN = 60 * 1000;

/** How long each action may take, model loading included: long files take minutes to listen through. */
export const ANALYZE_TIMEOUTS: Record<SoundAction, number> = {
  measure: 10 * MIN,
  describe: 15 * MIN,
  match: 15 * MIN,
  compare: 20 * MIN,
  ab: 20 * MIN,
  realness: 20 * MIN,
  find: 30 * MIN,
  rank: 40 * MIN,
  timeline: 60 * MIN,
  sheet: 60 * MIN,
  critique: 60 * MIN,
};

const asList = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);

function tempRoot(): string {
  try { return realpathSync.native(tmpdir()); } catch { return tmpdir(); }
}

/** earshot's arguments for a parsed `sound_analyze` call: paths resolved and checked, nothing an action doesn't take. */
export async function earshotArgs(service: Pick<EarshotService, "privateDirs">, args: ToolArgs<"sound_analyze">, project: string | null): Promise<Record<string, unknown>> {
  const fields = SOUND_ANALYZE_FIELDS[args.action];
  const given = args as Record<string, unknown>;
  const options = { project, privateDirs: service.privateDirs };
  const out: Record<string, unknown> = {};
  for (const field of [...fields.required, ...fields.optional]) {
    const value = given[field];
    if (value === undefined) continue;
    switch (field) {
      case "path":
        // earshot's realness takes one string, so a folder or glob goes on as given, every file in it checked here first.
        out.path = await resolveSoundPath(value as string, { ...options, what: "path", many: args.action === "realness" });
        break;
      case "paths":
      case "refs":
        // Folders and globs become the checked files in them, so earshot reads those and nothing it would find itself.
        out[field] = (await Promise.all(asList(value as string | string[]).map((item) => resolveSoundFiles(item, { ...options, what: field })))).flat();
        break;
      case "a":
      case "b":
      case "video":
      case "profile":
        out[field] = await resolveSoundPath(value as string, { ...options, what: field });
        break;
      case "cues":
        out.cues = await resolveCues(value as number[] | string, options);
        break;
      default:
        out[field] = value;
    }
  }
  return out;
}

export async function analyzeSound(service: EarshotService, args: ToolArgs<"sound_analyze">, project: string | null, signal?: AbortSignal): Promise<ToolResult<"sound_analyze">> {
  const call = await earshotArgs(service, args, project);
  let sheetDir: string | null = null;
  if (args.action === "sheet") {
    sheetDir = await mkdtemp(join(tempRoot(), SHEET_TEMP_PREFIX));
    call.out_png = join(sheetDir, `${sfxSlug(basename(String(call.path)).replace(/\.[^.]+$/, ""))}.png`);
    call.include_image = true;
  }
  let reply;
  try {
    reply = await service.call(args.action, call, signal, ANALYZE_TIMEOUTS[args.action]);
  } catch (error) {
    // No picture to keep; one that worked stays for a day (see cache.ts), its path being in the answer.
    if (sheetDir) await rm(sheetDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const ignored = /\(this earshot version ignored: ([^)]*)\)/.exec(reply.summary)?.[1]?.split(/,\s*/).filter(Boolean);
  return {
    action: args.action,
    version: await service.earshotVersion(),
    summary: reply.summary,
    result: reply.json ?? {},
    ...(args.action === "sheet" && (reply.png ?? call.out_png) ? { sheet: String(reply.png ?? call.out_png) } : {}),
    ...(ignored?.length ? { ignored } : {}),
    ...(reply.image ? { image: reply.image } : {}),
  };
}
