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
  const selected = skills.find((skill) => skill.id === args.id);
  if (!selected) throw new DapiError("invalid-input", "Choose a skill id returned by skills with action list.");
  if (!docsDir || !selected.available) throw new DapiError("not-found", "This editing guide is missing from the app. Reinstall the complete UVE build.");
  const root = await realpath(docsDir);
  const path = await realpath(join(root, selected.path));
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new DapiError("invalid-input", "The editing guide must be inside the app's bundled documentation.");
  return { version: EDITING_SKILL_VERSION, skills, selected: { ...selected, content: await readFile(path, "utf8"), baseDir: dirname(path) } };
}
