import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DapiError, EDITING_SKILLS, EDITING_SKILL_VERSION } from "@diffusionstudio/dapi";
import type { ToolArgs, ToolOutput } from "@diffusionstudio/dapi";

export async function readEditingSkills(docsDir: string | null, args: ToolArgs<"skills">): Promise<ToolOutput<"skills">> {
  const skills = await Promise.all(EDITING_SKILLS.map(async (skill) => ({
    ...skill,
    available: docsDir ? await access(join(docsDir, skill.path)).then(() => true, () => false) : false,
  })));
  if (args.action === "list") return { version: EDITING_SKILL_VERSION, skills };
  const selected = await findSkill(skills, args.id, docsDir);
  if (!selected) {
    const ids = skills.map((skill) => skill.id).join(", ");
    throw new DapiError("invalid-input", args.id
      ? `Unknown skill ${JSON.stringify(args.id.slice(0, 80))}. Use one of these ids (or its listed path): ${ids}.`
      : `Choose a skill id: ${ids}.`);
  }
  if (!docsDir || !selected.available) throw new DapiError("not-found", "This editing guide is missing from the app. Reinstall the complete UVE build.");
  const root = await realpath(docsDir);
  const path = await realpath(join(root, selected.path));
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new DapiError("invalid-input", "The editing guide must be inside the app's bundled documentation.");
  return { version: EDITING_SKILL_VERSION, skills, selected: { ...selected, content: await readFile(path, "utf8"), baseDir: dirname(path) } };
}

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
    const lowerId = id.toLowerCase(), lowerPath = path.toLowerCase();
    return [lowerId, lowerPath, lowerPath.replace(/^skills\//, ""), `${lowerId}.md`, `${lowerId}/skill.md`].includes(key);
  });
}
