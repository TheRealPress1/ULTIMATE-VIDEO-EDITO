/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What a chat session is told it remembers. Read fresh from the app's files
// each time a session opens or resumes, so a saved change reaches the next
// session and never the running one, and rendered by the same rules that
// let entries in: anything that fails today's safety check is withheld and
// counted, and nothing at all is said while memory is paused.

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EDITING_SKILLS } from "@diffusionstudio/dapi/editing-skills";
import { renderMemoryDigest, scanMemoryText } from "@diffusionstudio/dapi/memory-safety";

import type { MemoryDigestDocument } from "@diffusionstudio/dapi/memory-safety";

export type MemorySources = {
  /** `<userData>/agent-memory/memory.json`. */
  file: string;
  /** `<userData>/editing-style.json`, for the pointer to the editing style. */
  editingStyleFile?: string;
  /** `<userData>/agent-skills`, for the list of the user's own skills. */
  skillsDir?: string;
};

/** How many user skills are looked at; the digest lists only as many as fit its share anyway. */
const SKILLS_READ_MAX = 40;
const SKILL_ID = /^[a-z][a-z0-9-]{2,47}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** The largest SKILL.md `skills` will serve. */
const SKILL_FILE_MAX = 64 * 1024;
/** Cutroom's own ids, which a folder in the user's skills can't take over. */
const BUNDLED_IDS = new Set(EDITING_SKILLS.map((skill) => skill.id));

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function memoryDocument(value: unknown): MemoryDigestDocument | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as MemoryDigestDocument) : null;
}

async function editingStyle(path: string | undefined): Promise<{ revision: number; chars: number } | null> {
  if (!path) return null;
  const value = (await readJson(path)) as { revision?: unknown; notes?: unknown } | null;
  if (!value || typeof value.revision !== "number" || typeof value.notes !== "string" || !value.notes.trim()) return null;
  return { revision: value.revision, chars: value.notes.length };
}

/**
 * The user's skills by their SKILL.md headers, in id order: only the ones
 * `skills` would serve, by the same checks. A bundled or `uve-` id, a
 * SKILL.md that is a link, too large, misnamed or without a description, and
 * one whose text fails the safety check are all left out, so the digest
 * never points at a skill that `skills` would refuse or swap for its own.
 */
async function userSkills(dir: string | undefined): Promise<Array<{ id: string; description: string }>> {
  if (!dir) return [];
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SKILL_ID.test(entry.name) && !entry.name.startsWith("uve-") && !BUNDLED_IDS.has(entry.name))
      .map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  const skills = await Promise.all(names.slice(0, SKILLS_READ_MAX).map(async (id) => {
    const path = join(dir, id, "SKILL.md");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > SKILL_FILE_MAX) return null;
      const text = await readFile(path, "utf8");
      if (!scanMemoryText(text, { mode: "skill" }).ok) return null;
      const header = FRONTMATTER.exec(text.replace(/^\uFEFF/, ""));
      const data = header ? (parseYaml(header[1]!) as { name?: unknown; description?: unknown } | null) : null;
      if (!data || data.name !== id || typeof data.description !== "string" || !data.description.trim()) return null;
      return { id, description: data.description.trim() };
    } catch {
      return null;
    }
  }));
  return skills.filter((skill): skill is { id: string; description: string } => skill !== null);
}

/**
 * The block for a session's instructions, or null: when memory is turned off
 * (CUTROOM_MEMORY=0) or paused, when there is nothing saved, or when the
 * memory file can't be read (a damaged file is left for Settings to report).
 */
export async function readMemoryDigest(sources: MemorySources | null | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!sources || env.CUTROOM_MEMORY === "0") return null;
  let doc: MemoryDigestDocument | null = null;
  try {
    doc = memoryDocument(JSON.parse(await readFile(sources.file, "utf8")));
    if (!doc) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  if (doc?.enabled === false) return null;
  const [style, skills] = await Promise.all([editingStyle(sources.editingStyleFile), userSkills(sources.skillsDir)]);
  return renderMemoryDigest(doc, {
    ...(style ? { editingStyleRevision: style.revision, editingStyleChars: style.chars } : {}),
    userSkills: skills,
  });
}
