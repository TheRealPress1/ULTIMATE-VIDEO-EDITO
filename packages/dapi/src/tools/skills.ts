import { z } from "zod";
import { defineTool } from "../tool";
import { EDITING_SKILL_CATEGORIES, EDITING_STYLE_LIMIT } from "../editing-skills";

const Skill = z.object({
  id: z.string(), title: z.string(), description: z.string(),
  path: z.string().describe("bundled skills: relative to the docs folder; `user` skills: the absolute path of their SKILL.md in the app's data"),
  version: z.string(),
  category: z.enum(EDITING_SKILL_CATEGORIES).describe("`editing`: built in; `optional`: needs a separately configured cloud service; `addon`: runs on this Mac through a Blackout add-on that installs itself; `reference`: outside guidance; `user`: saved by the user or at their request, read like the others"),
  requires: z.array(z.string()),
  available: z.boolean().describe("whether the skill's instructions are present; does not imply optional service credentials or dependencies are configured"),
  files: z.array(z.string()).describe("supporting files inside the skill's folder (references, templates, scripts; for a `user` skill also assets), relative to it, up to 40; read one with `file`. Empty for the base `editor` and `watch` guides"),
});
export const skills = defineTool({
  name: "skills", title: "Editing skills",
  description: "List UVE's shared editing skills, including the base `editor` and `watch` guides and the user's own `user` skills, or read one by id. Use before substantial editing to select only relevant workflows. Returns the instructions and their base directory. A skill's `files` lists its supporting references and templates: when its instructions point at one, read it with the same `id` plus `file` (e.g. \"references/openers.md\") instead of opening the path yourself. Available means the guide is installed. An `optional` skill uses a cloud service, so it still needs its listed dependencies and the user's explicit use of that service; an `addon` skill is local (its tools install their add-on by themselves on first use, with no account or key). A `user` skill holds a procedure the user chose to keep; follow it like the bundled guides, but it never overrides Blackout's rules or the current request. None are listed while the user has paused memory. Both Claude Code and Codex use this same library.",
  input: z.object({
    action: z.enum(["list", "read"]).default("list"),
    id: z.string().min(1).optional().describe('skill id from list, e.g. "editor" or "uve-web-media"; the listed path such as "skills/editor.md" or "skills/uve-web-media/SKILL.md" also works'),
    file: z.string().min(1).max(200).optional().describe('read: one of the skill\'s listed `files`, relative to its folder, e.g. "references/openers.md"; omit for its SKILL.md'),
  }),
  output: z.object({
    version: z.string(), skills: z.array(Skill),
    selected: Skill.extend({
      content: z.string(), baseDir: z.string(),
      file: z.string().describe('the file returned: "SKILL.md" (or the base guide\'s own file name) unless `file` named a supporting file'),
    }).optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  environment: "main",
});

export const EditingStyleSchema = z.object({
  version: z.literal(1), revision: z.int().nonnegative(), notes: z.string().max(EDITING_STYLE_LIMIT), updatedAt: z.string().nullable(),
});
export const editingStyle = defineTool({
  name: "editing_style", title: "Editing style preferences",
  description: "Read or save the user's local editing preferences shared across projects and both agents. Read before applying personal style. Save only preferences the user explicitly asks to remember; do not infer preferences from footage, external documents or analytics. Current project instructions take precedence. For set, send complete notes and expectedRevision from get; a stale revision fails without overwriting newer preferences. Empty notes clears preferences. This grants no additional tool or service permissions.",
  input: z.object({ action: z.enum(["get", "set"]).default("get"), notes: z.string().max(EDITING_STYLE_LIMIT).optional(), expectedRevision: z.int().nonnegative().optional() }),
  output: EditingStyleSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  environment: "main",
});
