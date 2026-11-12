/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The user's own skills: procedures they asked an agent to keep, one folder
// per skill under the app's data (`agent-skills/<id>/SKILL.md`, with
// optional references/, templates/, scripts/ and assets/). Only
// `skill_write` writes here. Nothing touches the disk until the whole call
// has been validated, each operation seeing the folder as the operations
// before it would leave it; each changed skill is then assembled in a
// staging folder and swapped for the live one, so a refused or interrupted
// call leaves every skill as it was. The folder a call replaces moves to
// `.history/<id>/` (the newest ten per skill), and archiving moves a whole
// skill to `.archive/`. `ledger.json` records who made each skill and when.

import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DapiError,
  EDITING_SKILLS,
  RESERVED_SKILL_PREFIX,
  USER_SKILL_FOLDERS,
  USER_SKILL_ID,
  USER_SKILL_LIMITS,
  scanMemoryText,
} from "@diffusionstudio/dapi";

import type { ToolArgs, ToolOutput } from "@diffusionstudio/dapi";

export const SKILL_FILE = "SKILL.md";
export const ARCHIVE_DIR = ".archive";
export const HISTORY_DIR = ".history";
/** How many replaced versions of each skill `.history/<id>/` keeps. */
export const SKILL_VERSIONS_KEPT = 10;
export const LEDGER_FILE = "ledger.json";

export type UserSkillOrigin = "agent" | "settings" | "review";
export type UserSkillLedger = Record<string, { createdBy: UserSkillOrigin; createdAt: string; updatedAt?: string; archivedAt?: string }>;
export type UserSkillSummary = { id: string; description: string; path: string };

type Operation = ToolArgs<"skill_write">["operations"][number];
type Draft = {
  id: string;
  /** Whether the folder was on disk when the call began. */
  existed: boolean;
  /** Whether it exists once the operations so far are applied. */
  exists: boolean;
  created: boolean;
  /** What is on disk: path inside the folder → size in bytes. */
  disk: Map<string, number>;
  /** What the operations write (text) or remove (null). */
  changes: Map<string, string | null>;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
/** How deep a skill folder is walked, and how many files it may hold. */
const MAX_DEPTH = 6;
const MAX_FILES = 500;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
/** A kept version's folder: when it was replaced, and a counter when two share a millisecond. */
const VERSION_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?$/;
const byVersion = (a: string, b: string) => {
  const [, timeA, countA] = VERSION_NAME.exec(a)!;
  const [, timeB, countB] = VERSION_NAME.exec(b)!;
  return timeA! < timeB! ? -1 : timeA! > timeB! ? 1 : Number(countA ?? 1) - Number(countB ?? 1);
};
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const refuse = (message: string): never => { throw new DapiError("invalid-input", message); };

/** The ids Cutroom keeps for its own skills. */
const BUNDLED = new Set(EDITING_SKILLS.map((skill) => skill.id));

/** Why `id` cannot name a user skill; null when it can. */
export function userSkillIdRefusal(id: string): string | null {
  if (!USER_SKILL_ID.test(id)) return "A skill id is 3-48 lowercase letters, digits and hyphens, starting with a letter.";
  if (id.startsWith(RESERVED_SKILL_PREFIX)) return `Ids starting with \`${RESERVED_SKILL_PREFIX}\` are kept for Blackout's own skills; choose another id.`;
  if (BUNDLED.has(id)) return `\`${id}\` is one of Blackout's own skills, which can't be changed; choose another id.`;
  return null;
}

/** A SKILL.md's YAML frontmatter as an object; null when it has none or it doesn't parse. */
export function skillHeader(text: string): Record<string, unknown> | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  try {
    const data: unknown = parseYaml(match[1]!);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why `text` can't serve as `id`'s SKILL.md (header, name, description, body); null when it can. */
export function skillFileRefusal(id: string, text: string): string | null {
  if (bytes(text) > USER_SKILL_LIMITS.skillFile) return `SKILL.md may be at most ${kb(USER_SKILL_LIMITS.skillFile)}; move detail into references/.`;
  const header = skillHeader(text);
  if (!header) return "SKILL.md must start with YAML frontmatter between two `---` lines, holding `name` and `description`.";
  if (header.name !== id) return `SKILL.md's frontmatter \`name\` must be "${id}", the skill's id.`;
  const description = typeof header.description === "string" ? header.description.trim() : "";
  if (description.length < USER_SKILL_LIMITS.descriptionMin || description.length > USER_SKILL_LIMITS.descriptionMax) {
    return `SKILL.md's frontmatter \`description\` must be ${USER_SKILL_LIMITS.descriptionMin}-${USER_SKILL_LIMITS.descriptionMax} characters saying what the skill does and when to use it.`;
  }
  if (!text.replace(FRONTMATTER, "").trim()) return "SKILL.md needs instructions after its frontmatter.";
  return null;
}

/** A supporting file's path inside a skill, checked: under one of the four folders, plain names, no way out. */
export function skillFilePath(file: string): string {
  const path = file.trim();
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.startsWith("~")) {
    refuse("`file` is a path inside the skill, such as references/checklist.md.");
  }
  const segments = path.split("/");
  if (segments.length < 2 || segments.length > 5 || !(USER_SKILL_FOLDERS as readonly string[]).includes(segments[0]!)) {
    refuse(`Supporting files go under ${USER_SKILL_FOLDERS.map((folder) => `${folder}/`).join(", ")}; SKILL.md itself is changed with rewrite or patch.`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !SEGMENT.test(segment)) {
      refuse("`file` may use letters, digits, spaces, dots, hyphens and underscores, with no hidden names or `..`.");
    }
  }
  return segments.join("/");
}

/** Every regular file in a skill folder, by its path inside it. Links and special files are refused, never followed. */
async function walk(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const visit = async (folder: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) refuse("This skill's folder is nested too deeply to change safely.");
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path, rel, depth + 1);
      else if (entry.isFile()) {
        files.set(rel, (await lstat(path)).size);
        if (files.size > MAX_FILES) refuse(`A skill may hold at most ${MAX_FILES} files.`);
      } else refuse("This skill's folder holds a link or special file, which skill_write leaves alone. Remove it in Finder first.");
    }
  };
  await visit(root, "", 0);
  return files;
}

async function writeWhole(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

/** The user's skills on disk, by id: each folder with a SKILL.md, its description from the frontmatter. */
export async function listUserSkills(dir: string): Promise<UserSkillSummary[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills = await Promise.all(entries.map(async (entry): Promise<UserSkillSummary | null> => {
    if (!entry.isDirectory() || userSkillIdRefusal(entry.name)) return null;
    const path = join(dir, entry.name, SKILL_FILE);
    try {
      if (!(await lstat(path)).isFile()) return null;
      const header = skillHeader(await readFile(path, "utf8"));
      return { id: entry.name, description: typeof header?.description === "string" ? header.description.trim() : "", path };
    } catch {
      return null;
    }
  }));
  return skills.filter((skill): skill is UserSkillSummary => skill !== null).sort((a, b) => a.id.localeCompare(b.id));
}

export type AgentSkillsStoreOptions = {
  /** For tests. */
  now?: () => Date;
};

export class AgentSkillsStore {
  readonly dir: string;
  private readonly now: () => Date;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(dir: string, options: AgentSkillsStoreOptions = {}) {
    this.dir = dir;
    this.now = options.now ?? (() => new Date());
  }

  list(): Promise<UserSkillSummary[]> {
    return listUserSkills(this.dir);
  }

  /** `skill_write`: every operation checked first, then written all at once. */
  write(operations: readonly Operation[], origin: UserSkillOrigin = "agent"): Promise<ToolOutput<"skill_write">> {
    const run = this.pending.then(() => this.writeNow(operations, origin));
    this.pending = run.catch(() => {});
    return run;
  }

  private async writeNow(operations: readonly Operation[], origin: UserSkillOrigin): Promise<ToolOutput<"skill_write">> {
    if (!operations.length) refuse("skill_write needs at least one operation.");
    if (operations.length > USER_SKILL_LIMITS.operations) refuse(`skill_write takes at most ${USER_SKILL_LIMITS.operations} operations per call.`);
    if (operations.length > 1 && operations.some((operation) => operation.action === "archive")) {
      refuse("archive goes in a call of its own, with no other operations.");
    }
    const drafts = new Map<string, Draft>();
    const changes: string[] = [];
    for (const [index, operation] of operations.entries()) {
      const label = operations.length > 1 ? `Operation ${index + 1} (${operation.action} ${operation.id}): ` : "";
      try {
        const idRefusal = userSkillIdRefusal(operation.id);
        if (idRefusal) refuse(idRefusal);
        let draft = drafts.get(operation.id);
        if (!draft) drafts.set(operation.id, (draft = await this.load(operation.id)));
        changes.push(await this.plan(draft, operation));
      } catch (error) {
        if (error instanceof DapiError && label) throw new DapiError(error.code, `${label}${error.message} Nothing was written.`);
        if (error instanceof DapiError) throw new DapiError(error.code, `${error.message} Nothing was written.`);
        throw error;
      }
    }
    if (operations[0]!.action === "archive") {
      await this.archive(operations[0]!.id);
    } else {
      const changed = [...drafts.values()].filter((draft) => draft.changes.size);
      for (const draft of changed) {
        const total = [...new Set([...draft.disk.keys(), ...draft.changes.keys()])].reduce((sum, rel) => {
          const next = draft.changes.has(rel) ? draft.changes.get(rel) : undefined;
          return sum + (next === undefined ? draft.disk.get(rel) ?? 0 : next === null ? 0 : bytes(next));
        }, 0);
        if (total > USER_SKILL_LIMITS.skill) refuse(`${draft.id} would hold ${kb(total)}, more than a skill's ${kb(USER_SKILL_LIMITS.skill)}. Nothing was written.`);
      }
      await this.commit(changed);
    }
    await this.record(operations, drafts, origin);
    return { skillsDir: this.dir, changes, skills: await this.list() };
  }

  private async load(id: string): Promise<Draft> {
    const root = join(this.dir, id);
    let existed = false;
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory()) refuse(`${id} in the skills folder is not a folder; move it aside first.`);
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { id, existed, exists: existed, created: false, disk: existed ? await walk(root) : new Map(), changes: new Map() };
  }

  /** What `rel` holds once the operations so far are applied; undefined when nothing is there. */
  private async content(draft: Draft, rel: string): Promise<string | undefined> {
    if (draft.changes.has(rel)) return draft.changes.get(rel) ?? undefined;
    if (!draft.disk.has(rel)) return undefined;
    return readFile(join(this.dir, draft.id, ...rel.split("/")), "utf8");
  }

  /** Checks one operation against the draft and records what it would write. Returns its line for `changes`. */
  private async plan(draft: Draft, operation: Operation): Promise<string> {
    const { id } = draft;
    const missing = () => refuse(`There is no user skill named ${id}.`);
    const safe = (rel: string, text: string): string => {
      const scan = scanMemoryText(text, { mode: "skill" });
      if (!scan.ok) refuse(`${id}/${rel}: ${scan.message}`);
      return (scan as { text: string }).text;
    };
    switch (operation.action) {
      case "create":
      case "rewrite": {
        if (operation.action === "create" && draft.exists) refuse(`A user skill named ${id} already exists; use rewrite or patch to change it.`);
        if (operation.action === "rewrite" && !draft.exists) missing();
        if (operation.content === undefined) refuse(`${operation.action} needs \`content\`: the whole SKILL.md.`);
        const text = safe(SKILL_FILE, operation.content!);
        const refusal = skillFileRefusal(id, text);
        if (refusal) refuse(refusal);
        draft.changes.set(SKILL_FILE, text);
        if (operation.action === "create") { draft.exists = true; draft.created = true; return `Created ${id}.`; }
        return `Rewrote ${id}/SKILL.md.`;
      }
      case "patch": {
        if (!draft.exists) missing();
        if (operation.find === undefined || operation.replace === undefined) refuse("patch needs `find` and `replace`.");
        const rel = operation.file === undefined ? SKILL_FILE : skillFilePath(operation.file);
        const current = await this.content(draft, rel);
        if (current === undefined) refuse(`${id} has no file ${rel}.`);
        const find = operation.find!.normalize("NFC");
        const occurrences = current!.split(find).length - 1;
        if (!occurrences) refuse(`The text to find isn't in ${id}/${rel}.`);
        if (occurrences > 1 && !operation.all) refuse(`The text to find appears ${occurrences} times in ${id}/${rel}; pass a longer \`find\` or \`all: true\`.`);
        const replace = operation.replace!.normalize("NFC");
        const patched = operation.all ? current!.split(find).join(replace) : current!.replace(find, () => replace);
        const text = safe(rel, patched);
        if (rel === SKILL_FILE) {
          const refusal = skillFileRefusal(id, text);
          if (refusal) refuse(refusal);
        } else if (bytes(text) > USER_SKILL_LIMITS.file) refuse(`${rel} would be larger than ${kb(USER_SKILL_LIMITS.file)}.`);
        draft.changes.set(rel, text);
        return `Patched ${id}/${rel} (${operation.all ? occurrences : 1} ${operation.all && occurrences !== 1 ? "places" : "place"}).`;
      }
      case "write_file": {
        if (!draft.exists) missing();
        if (operation.file === undefined || operation.fileContent === undefined) refuse("write_file needs `file` and `fileContent`.");
        const rel = skillFilePath(operation.file!);
        if (bytes(operation.fileContent!) > USER_SKILL_LIMITS.file) refuse(`A supporting file may be at most ${kb(USER_SKILL_LIMITS.file)}.`);
        const existed = (await this.content(draft, rel)) !== undefined;
        draft.changes.set(rel, safe(rel, operation.fileContent!));
        return `${existed ? "Replaced" : "Wrote"} ${id}/${rel}.`;
      }
      case "remove_file": {
        if (!draft.exists) missing();
        if (operation.file === undefined) refuse("remove_file needs `file`.");
        const rel = skillFilePath(operation.file!);
        if ((await this.content(draft, rel)) === undefined) refuse(`${id} has no file ${rel}.`);
        draft.changes.set(rel, null);
        return `Removed ${id}/${rel}.`;
      }
      case "archive": {
        if (!draft.existed) missing();
        return `Archived ${id}; it no longer appears in the skill list.`;
      }
    }
  }

  /** Builds each changed skill whole in a staging folder, then swaps it in; on a failure, the live folders are put back. */
  private async commit(drafts: readonly Draft[]): Promise<void> {
    if (!drafts.length) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const staging = join(this.dir, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const draft of drafts) {
        const target = join(staging, draft.id);
        await mkdir(target, { recursive: true, mode: 0o700 });
        for (const rel of draft.disk.keys()) {
          if (draft.changes.has(rel)) continue;
          const to = join(target, ...rel.split("/"));
          await mkdir(dirname(to), { recursive: true, mode: 0o700 });
          await copyFile(join(this.dir, draft.id, ...rel.split("/")), to);
        }
        for (const [rel, text] of draft.changes) {
          if (text !== null) await writeWhole(join(target, ...rel.split("/")), text);
        }
      }
      const swapped: Array<{ id: string; previous: string | null }> = [];
      try {
        for (const draft of drafts) {
          const live = join(this.dir, draft.id);
          const previous = draft.existed ? join(staging, `${draft.id}.previous`) : null;
          if (previous) await rename(live, previous);
          try {
            await rename(join(staging, draft.id), live);
          } catch (error) {
            if (previous) await rename(previous, live).catch(() => {});
            throw error;
          }
          swapped.push({ id: draft.id, previous });
        }
      } catch (error) {
        for (const { id, previous } of swapped.reverse()) {
          const live = join(this.dir, id);
          await rename(live, join(staging, `${id}.failed`)).catch(() => {});
          if (previous) await rename(previous, live).catch(() => {});
        }
        throw error;
      }
      // The call has landed; a version that can't be kept doesn't undo it.
      for (const { id, previous } of swapped) {
        if (previous) await this.keepVersion(id, previous).catch(() => {});
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Moves the folder a call replaced into `.history/<id>/`, then trims that skill's kept versions to the newest ten. */
  private async keepVersion(id: string, previous: string): Promise<void> {
    const folder = join(this.dir, HISTORY_DIR, id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const names = (await readdir(folder)).filter((name) => VERSION_NAME.test(name));
    let name = stamp;
    for (let n = 2; names.includes(name); n++) name = `${stamp}-${n}`;
    await rename(previous, join(folder, name));
    const kept = [...names, name].sort(byVersion);
    for (const old of kept.slice(0, Math.max(0, kept.length - SKILL_VERSIONS_KEPT))) {
      await rm(join(folder, old), { recursive: true, force: true });
    }
  }

  private async archive(id: string): Promise<void> {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const archive = join(this.dir, ARCHIVE_DIR);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await rename(join(this.dir, id), join(archive, `${id}-${stamp}`));
  }

  /** Notes who made each skill and when. A damaged ledger is left as it is rather than replaced. */
  private async record(operations: readonly Operation[], drafts: ReadonlyMap<string, Draft>, origin: UserSkillOrigin): Promise<void> {
    const path = join(this.dir, LEDGER_FILE);
    let ledger: UserSkillLedger = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      ledger = parsed as UserSkillLedger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const now = this.now().toISOString();
    for (const draft of drafts.values()) {
      const entry = Object.hasOwn(ledger, draft.id) ? ledger[draft.id] : undefined;
      if (operations[0]!.action === "archive") {
        ledger[draft.id] = { createdBy: entry?.createdBy ?? origin, createdAt: entry?.createdAt ?? now, ...entry, archivedAt: now };
      } else if (draft.created) {
        ledger[draft.id] = { createdBy: origin, createdAt: now };
      } else if (draft.changes.size) {
        ledger[draft.id] = { createdBy: entry?.createdBy ?? origin, createdAt: entry?.createdAt ?? now, ...entry, updatedAt: now };
      }
    }
    await writeWhole(path, JSON.stringify(ledger, null, 2) + "\n");
  }
}

const stores = new Map<string, AgentSkillsStore>();

/** One store per folder, so every writer shares one queue. */
export function agentSkillsStore(dir: string): AgentSkillsStore {
  let store = stores.get(dir);
  if (!store) stores.set(dir, (store = new AgentSkillsStore(dir)));
  return store;
}
