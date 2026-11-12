/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { EDITING_SKILLS } from "@diffusionstudio/dapi";
import { groupSkills, guideText, skillBadge, skillVersionLabel, supportingFileLabel, userSkillsNotice, userSkillsState } from "./editing-skills-data";

const badge = (id: string) => {
  const skill = EDITING_SKILLS.find((entry) => entry.id === id);
  if (!skill) throw new Error(`no skill ${id}`);
  return skillBadge({ ...skill, available: true });
};

describe("the skill card badge", () => {
  it("marks the earshot guides as a local add-on, not a cloud API", () => {
    for (const id of ["earshot-listening", "earshot-real-sound"]) expect(badge(id), id).toEqual({ label: "Local add-on", tone: "muted" });
  });

  it("keeps the cloud imports, the built-in guides and the reference apart", () => {
    expect(badge("uve-cloud-transcribe").label).toBe("Optional API");
    expect(badge("uve-cloud-speech").label).toBe("Optional API");
    expect(badge("editor")).toEqual({ label: "Built in", tone: "built-in" });
    expect(badge("uve-remotion-reference").label).toBe("Reference");
  });

  it("says a guide that isn't bundled is unavailable, whatever its category", () => {
    expect(skillBadge({ category: "addon", available: false })).toEqual({ label: "Unavailable", tone: "unavailable" });
  });

  it("gives every skill in the library a badge", () => {
    for (const skill of EDITING_SKILLS) expect(skillBadge({ ...skill, available: true }).label, skill.id).toBeTruthy();
  });

  it("lists the scripting and clean-edit guides as built in", () => {
    for (const id of ["uve-scripting", "uve-clean-edit"]) expect(badge(id), id).toEqual({ label: "Built in", tone: "built-in" });
  });

  it("marks the user's saved skills as theirs, and a broken one as needing repair", () => {
    expect(skillBadge({ category: "user", available: true })).toEqual({ label: "Your skill", tone: "user" });
    expect(skillBadge({ category: "user", available: false })).toEqual({ label: "Needs repair", tone: "unavailable" });
  });
});

describe("the skill library in Settings", () => {
  it("shows the bundled guides first and the user's skills in their own group", () => {
    const skills = [{ id: "editor", category: "editing" }, { id: "weekly-recap", category: "user" }, { id: "earshot-listening", category: "addon" }] as const;
    expect(groupSkills(skills)).toEqual({ bundled: [skills[0], skills[2]], user: [skills[1]] });
    expect(groupSkills(undefined)).toEqual({ bundled: [], user: [] });
  });

  it("labels versions and supporting files plainly", () => {
    expect(skillVersionLabel({ category: "editing", version: "1.7.0" })).toBe("v1.7.0");
    expect(skillVersionLabel({ category: "user", version: "local" })).toBe("Saved skill");
    expect(skillVersionLabel({ category: "user", version: "2" })).toBe("Saved skill · v2");
    expect(supportingFileLabel("references/openers.md")).toBe("openers.md");
    expect(supportingFileLabel("templates/brief.md")).toBe("templates/brief.md");
  });

  it("says when saved skills are paused with memory or off for the session, instead of inviting a save", () => {
    expect(userSkillsState({ available: true, enabled: true })).toBe("on");
    expect(userSkillsState({ available: true, enabled: false })).toBe("paused");
    expect(userSkillsState({ available: false, enabled: false })).toBe("off");
    // Agents still see the skills when the memory file can't be read, so Settings doesn't claim they are paused.
    expect(userSkillsState(null)).toBe("on");
    expect(userSkillsNotice("on", 0)).toMatch(/^No saved skills yet/);
    expect(userSkillsNotice("on", 2)).toBeNull();
    for (const count of [0, 2]) {
      expect(userSkillsNotice("paused", count), String(count)).toMatch(/^Paused with agent memory: agents .*What agents remember\.$/);
      expect(userSkillsNotice("off", count), String(count)).toMatch(/turned off in this Blackout session/);
      for (const state of ["paused", "off"] as const) expect(userSkillsNotice(state, count)).not.toMatch(/ask your agent to save/);
    }
    expect(userSkillsNotice("paused", 2)).toMatch(/don't see these skills/);
  });

  it("shows a guide without its frontmatter", () => {
    expect(guideText("---\nname: x\ndescription: y\n---\n# Title\n\nBody\n")).toBe("# Title\n\nBody");
    expect(guideText("# Plain page\n")).toBe("# Plain page");
  });
});
