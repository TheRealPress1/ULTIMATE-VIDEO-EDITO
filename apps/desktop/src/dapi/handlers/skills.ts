import { DapiError } from "@diffusionstudio/dapi";
import { readEditingSkills } from "../../editing-skills";
import type { MainHandler } from "../handler";

export const skills: MainHandler<"skills"> = (args, ctx) => readEditingSkills(ctx.docsDir ?? null, args);
export const editingStyle: MainHandler<"editing_style"> = async (args, ctx) => {
  if (!ctx.editingStyle) throw new DapiError("unsupported", "Editing preferences are unavailable in this app session.");
  if (args.action === "get") return ctx.editingStyle.get();
  if (args.notes === undefined || args.expectedRevision === undefined) {
    throw new DapiError("invalid-input", "Saving preferences requires notes and expectedRevision from editing_style get.");
  }
  return ctx.editingStyle.set(args.notes, args.expectedRevision);
};
