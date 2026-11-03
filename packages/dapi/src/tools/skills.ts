import { z } from "zod";
import { defineTool } from "../tool";
import { EDITING_SKILL_CATEGORIES, EDITING_STYLE_LIMIT } from "../editing-skills";

const Skill = z.object({
  id: z.string(), title: z.string(), description: z.string(), path: z.string(), version: z.string(),
  category: z.enum(EDITING_SKILL_CATEGORIES).describe("`editing`: built in; `optional`: needs a separately configured cloud service; `addon`: runs on this Mac through a Cutroom add-on that installs itself; `reference`: outside guidance"),
  requires: z.array(z.string()),
  available: z.boolean().describe("whether the skill's instructions are bundled; does not imply optional service credentials or dependencies are configured"),
});
export const skills = defineTool({
  name: "skills", title: "Editing skills",
  description: "List UVE's shared editing skills, including the base `editor` and `watch` guides, or read one by id. Use before substantial editing to select only relevant workflows. Returns bundled instructions and their base directory for relative references/scripts. Available means the guide is installed. An `optional` skill uses a cloud service, so it still needs its listed dependencies and the user's explicit use of that service; an `addon` skill is local (its tools install their add-on by themselves on first use, with no account or key). Both Claude Code and Codex use this same library.",
  input: z.object({
    action: z.enum(["list", "read"]).default("list"),
    id: z.string().min(1).optional().describe('skill id from list, e.g. "editor" or "uve-web-media"; the listed path such as "skills/editor.md" or "skills/uve-web-media/SKILL.md" also works'),
  }),
  output: z.object({ version: z.string(), skills: z.array(Skill), selected: Skill.extend({ content: z.string(), baseDir: z.string() }).optional() }),
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
