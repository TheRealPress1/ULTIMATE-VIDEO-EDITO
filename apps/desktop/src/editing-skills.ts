import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { DapiError, EDITING_SKILLS, EDITING_SKILL_VERSION, RESERVED_SKILL_PREFIX, USER_SKILL_FOLDERS, USER_SKILL_ID, USER_SKILL_LIMITS, scanMemoryText } from "@diffusionstudio/dapi";
import type { ToolArgs, ToolOutput } from "@diffusionstudio/dapi";
import { skillFilePath } from "./agent-skills";

type ListedSkill = ToolOutput<"skills">["skills"][number];

/** Text an agent can usefully read back from a bundled skill. */
const TEXT_FILE = /\.(?:md|markdown|txt|json|ya?ml|csv|tsv|srt|vtt|py|sh|js|mjs|cjs|ts|tsx|jsx|css|html?)$/i;
/** The most a bundled supporting file (or a user skill's SKILL.md) may weigh to be listed and read. */
export const SKILL_FILE_LIMIT = 64 * 1024;
/** Supporting files listed per skill. */
const MAX_FILES = 40;
const MAX_USER_SKILLS = 100;

/** Which files beside a SKILL.md are listed and served, and how deep under a support folder they may sit (`references/a.md` is 1). */
type FileRules = { folders: readonly string[]; depth: number; limit: number; accepts: (rel: string) => boolean };
/** The bundled skills' text files. `assets/` is left out: in the app's docs it holds media, not text. */
const BUNDLED_FILES: FileRules = { folders: ["references", "templates", "scripts"], depth: 2, limit: SKILL_FILE_LIMIT, accepts: (rel) => TEXT_FILE.test(rel) };
/**
 * Everything `skill_write` can save in a user skill: any plain name under its
 * four folders, as deep and as large as it allows. All of it was written as
 * text; whether a file still is (or passes the safety scan) is checked on read.
 */
const USER_FILES: FileRules = { folders: USER_SKILL_FOLDERS, depth: 4, limit: USER_SKILL_LIMITS.file, accepts: (rel) => userFilePath(rel) !== null };

/** `rel` as `skill_write` would name it, or null when skill_write could not have saved a file there. */
function userFilePath(rel: string): string | null {
  try { return skillFilePath(rel); } catch { return null; }
}

export type EditingSkillsOptions = {
  /** The user's own skills (`<userData>/agent-skills`), listed with category `user`; omitted when they are off. */
  userSkillsDir?: string | null;
  /** The user paused memory, and with it their saved skills: none are listed, and asking for one says why. */
  userSkillsPaused?: boolean;
};

/**
 * The shared skill library: the bundled guides, then the user's saved skills.
 * Reading opens only files this listing produced — a catalogued SKILL.md, a
 * user skill's SKILL.md, or one of a skill's listed supporting files (for a
 * user skill, any path `skill_write` could have saved) — and each must
 * resolve inside the folder it was listed from, which defeats `..` names and
 * symlinks that point elsewhere. A user skill's text, frontmatter included,
 * passes the same safety scan `skill_write` applies before an agent sees it,
 * so a file changed by hand outside the tool is held back rather than served.
 */
export async function readEditingSkills(docsDir: string | null, args: ToolArgs<"skills">, options: EditingSkillsOptions = {}): Promise<ToolOutput<"skills">> {
  const bundled = await Promise.all(EDITING_SKILLS.map(async (skill): Promise<ListedSkill> => {
    const available = docsDir ? await access(join(docsDir, skill.path)).then(() => true, () => false) : false;
    const files = available && docsDir && isFolderSkill(skill.path) ? await supportingFiles(dirname(join(docsDir, skill.path)), BUNDLED_FILES) : [];
    return { ...skill, available, files };
  }));
  const reserved = new Set(bundled.map((skill) => skill.id));
  const user = options.userSkillsDir && !options.userSkillsPaused ? await listUserSkills(options.userSkillsDir, reserved) : [];
  const skills = [...bundled, ...user];
  if (args.action === "list") return { version: EDITING_SKILL_VERSION, skills };

  const selected = await findSkill(skills, args.id, docsDir);
  if (!selected) {
    const ids = skills.map((skill) => skill.id).join(", ");
    const paused = options.userSkillsPaused ? " The user's saved skills are paused along with agent memory in Cutroom's Settings, so none are offered until they turn it back on." : "";
    throw new DapiError("invalid-input", args.id
      ? `Unknown skill ${JSON.stringify(args.id.slice(0, 80))}. Use one of these ids (or its listed path): ${ids}.${paused}`
      : `Choose a skill id: ${ids}.${paused}`);
  }
  const isUser = selected.category === "user";
  if (isUser ? !selected.available : !docsDir || !selected.available) {
    throw new DapiError("not-found", isUser
      ? `The skill ${selected.id} can't be offered: ${selected.description} Rewrite it with skill_write, or archive it.`
      : "This editing guide is missing from the app. Reinstall the complete UVE build.");
  }
  const root = await realpath(isUser ? options.userSkillsDir! : docsDir!);
  const entry = isUser ? join(root, selected.id, "SKILL.md") : join(root, selected.path);
  const path = await realpath(entry).catch(() => { throw new DapiError("not-found", `The skill ${selected.id} is no longer on disk. List the skills again.`); });
  if (!inside(root, path) || (isUser && !inside(join(root, selected.id), path))) {
    throw new DapiError("invalid-input", isUser ? "A user skill must stay inside its own folder." : "The editing guide must be inside the app's bundled documentation.");
  }

  const file = args.file === undefined ? null : supportingFileName(args.file, selected);
  if (file === null) {
    const content = await readFile(path, "utf8");
    return { version: EDITING_SKILL_VERSION, skills, selected: { ...selected, content: isUser ? checkedUserText(content, selected.id, "SKILL.md") : content, baseDir: dirname(path), file: basename(selected.path) } };
  }
  // The folder the files were listed from, resolved, and kept inside the library it belongs to.
  const skillDir = await realpath(dirname(entry));
  if (!inside(root, skillDir)) throw new DapiError("invalid-input", "The skill's folder must stay inside its library.");
  const target = await realpath(join(skillDir, file)).catch(() => { throw new DapiError("not-found", `${file} is not in ${selected.id}. List the skills again to see its files.`); });
  if (!inside(skillDir, target)) throw new DapiError("invalid-input", `${file} points outside the ${selected.id} skill's folder.`);
  const info = await stat(target);
  const limit = isUser ? USER_FILES.limit : BUNDLED_FILES.limit;
  if (!info.isFile() || info.size > limit) throw new DapiError("invalid-input", `${file} is not a readable text file of at most ${Math.round(limit / 1024)} KB.`);
  const content = isUser ? userText(await readFile(target), selected.id, file) : await readFile(target, "utf8");
  return { version: EDITING_SKILL_VERSION, skills, selected: { ...selected, content, baseDir: skillDir, file } };
}

/** A user skill's supporting file as text that passed the safety scan; a file that isn't UTF-8 text (media put there by hand) is refused. */
function userText(data: Buffer, id: string, file: string): string {
  let text: string | null = null;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { /* not UTF-8 */ }
  if (text === null || text.includes("\0")) throw new DapiError("invalid-input", `${file} in the ${id} skill is not a text file, so it can't be read here.`);
  return checkedUserText(text, id, file);
}

/** A user skill's text as an agent may read it, or a refusal naming the check it failed (never what matched). */
function checkedUserText(text: string, id: string, file: string): string {
  const scan = scanMemoryText(text, { mode: "skill" });
  if (!scan.ok) throw new DapiError("invalid-input", `${file} in the ${id} skill is held back: ${scan.message} Rewrite it with skill_write.`);
  return text;
}

/** The base guides are single pages in `skills/`; every other skill owns a folder around its SKILL.md. */
const isFolderSkill = (path: string) => /(?:^|\/)SKILL\.md$/.test(path);

/** Whether `path` is `root` or sits under it (both already resolved). */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The files a skill keeps beside its SKILL.md that `rules` accepts, as sorted
 * paths relative to its folder. Hidden names, symlinks, rejected names and
 * files over the size limit are left out, so everything listed is something
 * `read` opens (a user skill's text is still scanned then).
 */
async function supportingFiles(dir: string, rules: FileRules): Promise<string[]> {
  const root = await realpath(dir).catch(() => null);
  if (!root) return [];
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (found.length >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < rules.depth) await walk(child, depth + 1);
      } else if (entry.isFile() && rules.accepts(child)) {
        const info = await stat(join(root, child)).catch(() => null);
        if (info && info.size <= rules.limit) found.push(child);
      }
    }
  };
  for (const folder of rules.folders) {
    // A support folder that is itself a symlink is not followed.
    const info = await lstat(join(root, folder)).catch(() => null);
    if (info?.isDirectory()) await walk(folder, 1);
  }
  return found.sort();
}

/**
 * Turns the `file` an agent sent into one of the skill's listed files, or
 * null for its SKILL.md. Absolute paths, backslashes, NUL and `..` segments
 * are refused outright; anything else must name a listed file, except that a
 * user skill also serves any path `skill_write` accepts (its list stops at
 * MAX_FILES, while skill_write may save more).
 */
function supportingFileName(raw: string, skill: ListedSkill): string | null {
  const value = raw.trim();
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new DapiError("invalid-input", "file must be a path relative to the skill's folder, such as references/example.md.");
  }
  let parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new DapiError("invalid-input", "file must stay inside the skill's folder; `..` is not allowed.");
  // The skill's own folder in front (`skills/uve-x/references/a.md`) names the same file.
  const own = skill.category === "user" ? [] : dirname(skill.path).split("/");
  if (own.length > 0 && parts.length > own.length && own.every((part, i) => part.toLowerCase() === parts[i]!.toLowerCase())) parts = parts.slice(own.length);
  const name = parts.join("/");
  if (!isFolderSkill(skill.path)) {
    if (name.toLowerCase() === basename(skill.path).toLowerCase()) return null;
    throw new DapiError("invalid-input", `The ${skill.id} guide is a single page with no supporting files; read it without file.`);
  }
  if (name.toLowerCase() === "skill.md") return null;
  const listed = skill.files.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (listed) return listed;
  const saved = skill.category === "user" && skill.available ? userFilePath(name) : null;
  if (saved) return saved;
  throw new DapiError("invalid-input", skill.files.length
    ? `${JSON.stringify(name.slice(0, 120))} is not one of ${skill.id}'s files: ${skill.files.join(", ")}.`
    : `The ${skill.id} skill has no supporting files; read it without file.`);
}

/**
 * The user's saved skills, one folder per id holding a SKILL.md whose
 * frontmatter names it. Hidden entries (the archive, staging folders), the
 * ledger, symlinks, reserved ids and bundled ids are skipped; a folder whose
 * SKILL.md is unreadable is listed as unavailable so it can be repaired.
 */
async function listUserSkills(dir: string, reserved: ReadonlySet<string>): Promise<ListedSkill[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((entry) => entry.isDirectory() && USER_SKILL_ID.test(entry.name) && !entry.name.startsWith(RESERVED_SKILL_PREFIX) && !reserved.has(entry.name))
    .map((entry) => entry.name).sort().slice(0, MAX_USER_SKILLS);
  return Promise.all(ids.map(async (id): Promise<ListedSkill> => {
    const path = join(dir, id, "SKILL.md");
    const info = await lstat(path).catch(() => null);
    const text = info?.isFile() && info.size <= SKILL_FILE_LIMIT ? await readFile(path, "utf8").catch(() => null) : null;
    const meta = text === null ? null : skillFrontmatter(text);
    const scan = text === null ? null : scanMemoryText(text, { mode: "skill" });
    const description = meta?.name === id && meta.description && scan?.ok ? clip(meta.description, 500) : null;
    return {
      id, path, category: "user", requires: [],
      // Frontmatter reaches agents only from a SKILL.md that passed the scan; otherwise the id stands in.
      title: scan?.ok && meta?.title && meta.title.length <= 80 ? meta.title : humanize(id),
      description: description ?? (scan && !scan.ok
        ? `This saved skill fails Cutroom's safety check (${scan.category}), so agents don't get it.`
        : "This saved skill's SKILL.md is missing, too large, or lacks a name and description in its frontmatter."),
      version: meta?.version && /^\d+(?:\.\d+){0,2}$/.test(meta.version) ? meta.version : "local",
      available: description !== null,
      files: description !== null ? await supportingFiles(join(dir, id), USER_FILES) : [],
    };
  }));
}

/**
 * The scalar fields of a SKILL.md's YAML frontmatter (`name`, `description`,
 * optional `title` and `version`), parsed the way `skill_write` parses them.
 * Null when the file does not start with a frontmatter block that parses.
 */
export function skillFrontmatter(text: string): Record<string, string> | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ""));
  if (!block) return null;
  let data: unknown;
  try { data = parseYaml(block[1]!); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") fields[key] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value)) fields[key] = String(value);
  }
  return fields;
}

const humanize = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Agents name a guide by id or by the path INSTRUCTIONS.md lists (`skills/editor.md`,
 * `skills/uve-x/SKILL.md`, with or without the docs folder in front). The name is only
 * compared against strings built from the catalog; the file opened is always the entry's own path.
 */
async function findSkill<T extends { id: string; path: string }>(skills: readonly T[], raw: string | undefined, docsDir: string | null): Promise<T | undefined> {
  if (!raw) return undefined;
  const slashes = (value: string) => value.trim().replace(/\\/g, "/").toLowerCase();
  let key = slashes(raw);
  if (docsDir) {
    for (const dir of new Set([docsDir, await realpath(docsDir).catch(() => docsDir)])) {
      const prefix = `${slashes(dir).replace(/\/+$/, "")}/`;
      if (key.startsWith(prefix)) { key = key.slice(prefix.length); break; }
    }
  }
  key = key.replace(/^(?:\.\/)+/, "");
  return skills.find(({ id, path }) => {
    const lowerId = id.toLowerCase(), lowerPath = slashes(path);
    return [lowerId, lowerPath, lowerPath.replace(/^skills\//, ""), `${lowerId}.md`, `${lowerId}/skill.md`].includes(key);
  });
}
