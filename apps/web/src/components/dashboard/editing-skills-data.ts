/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ToolOutput } from "@diffusionstudio/dapi";

type ListedSkill = ToolOutput<"skills">["skills"][number];
type Skill = Pick<ListedSkill, "available" | "category">;
export type SkillBadgeTone = "unavailable" | "built-in" | "user" | "muted";

const LABELS: Record<Skill["category"], string> = {
  editing: "Built in",
  optional: "Optional API",
  addon: "Local add-on",
  reference: "Reference",
  user: "Your skill",
};

/**
 * The badge on a skill card: what the guide relies on, so a guide that runs
 * on this Mac through an add-on never reads like a cloud import, and a skill
 * the user saved never reads like one the app ships.
 */
export function skillBadge(skill: Skill): { label: string; tone: SkillBadgeTone } {
  if (!skill.available) return { label: skill.category === "user" ? "Needs repair" : "Unavailable", tone: "unavailable" };
  const tone = skill.category === "editing" ? "built-in" : skill.category === "user" ? "user" : "muted";
  return { label: LABELS[skill.category], tone };
}

/** The library in the order Settings shows it: what ships with the app, then what the user saved. */
export function groupSkills<T extends Pick<ListedSkill, "category">>(skills: readonly T[] | undefined): { bundled: T[]; user: T[] } {
  const list = skills ?? [];
  return { bundled: list.filter((skill) => skill.category !== "user"), user: list.filter((skill) => skill.category === "user") };
}

/** The small print under a card: the library version for bundled guides, a version only when a saved skill declares one. */
export function skillVersionLabel(skill: Pick<ListedSkill, "category" | "version">): string {
  if (skill.category !== "user") return `v${skill.version}`;
  return /^\d/.test(skill.version) ? `Saved skill · v${skill.version}` : "Saved skill";
}

/** Whether the user's saved skills reach agents: on, paused with agent memory, or off for this app session (CUTROOM_MEMORY=0). */
export type UserSkillsState = "on" | "paused" | "off";

/**
 * Reads the state from Settings' memory snapshot. An unreadable memory file
 * (no snapshot) doesn't stop agents from seeing the skills, so it counts as on.
 */
export function userSkillsState(memory: { available: boolean; enabled: boolean } | null | undefined): UserSkillsState {
  if (!memory) return "on";
  if (!memory.available) return "off";
  return memory.enabled ? "on" : "paused";
}

/** The line under "Your skills": why the list is empty, or that agents can't see what is listed. Null when the cards say it all. */
export function userSkillsNotice(state: UserSkillsState, count: number): string | null {
  if (state === "off") return "Saved skills are turned off in this Cutroom session (CUTROOM_MEMORY=0): agents can't see or save them, and none are shown here.";
  if (state === "paused") {
    return count > 0
      ? "Paused with agent memory: agents don't see these skills and can't save new ones until you turn memory back on under What agents remember."
      : "Paused with agent memory: agents can't save skills until you turn memory back on under What agents remember.";
  }
  return count > 0 ? null : "No saved skills yet. To keep a workflow you repeat, ask your agent to save it as a skill.";
}

/** How a supporting file is named on its button: its path inside the skill, without the `references/` most of them share. */
export function supportingFileLabel(file: string): string {
  return file.replace(/^references\//, "");
}

/** A guide's text as Settings shows it: without the YAML frontmatter agents read the name and description from. */
export function guideText(content: string): string {
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}
