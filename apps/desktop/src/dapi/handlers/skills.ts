import { DapiError } from "@diffusionstudio/dapi";
import { agentMemoryStore } from "../../agent-memory";
import { readEditingSkills } from "../../editing-skills";
import type { MainHandler } from "../handler";

/**
 * Bundled guides, plus the user's own skills when the session has them. They
 * are off with CUTROOM_MEMORY=0, and pausing memory in Settings hides them
 * (as it stops `skill_write`). A memory file that can't be read doesn't hide
 * them, matching `skill_write`; Settings lists them either way.
 */
export const skills: MainHandler<"skills"> = async (args, ctx) => {
  if (!ctx.agentSkillsDir || !ctx.agentMemoryFile) return readEditingSkills(ctx.docsDir ?? null, args);
  const paused = await agentMemoryStore(ctx.agentMemoryFile).read().then((doc) => !doc.enabled, () => false);
  return readEditingSkills(ctx.docsDir ?? null, args, paused ? { userSkillsPaused: true } : { userSkillsDir: ctx.agentSkillsDir });
};
export const editingStyle: MainHandler<"editing_style"> = async (args, ctx) => {
  if (!ctx.editingStyle) throw new DapiError("unsupported", "Editing preferences are unavailable in this app session.");
  if (args.action === "get") return ctx.editingStyle.get();
  if (args.notes === undefined || args.expectedRevision === undefined) {
    throw new DapiError("invalid-input", "Saving preferences requires notes and expectedRevision from editing_style get.");
  }
  return ctx.editingStyle.set(args.notes, args.expectedRevision);
};
