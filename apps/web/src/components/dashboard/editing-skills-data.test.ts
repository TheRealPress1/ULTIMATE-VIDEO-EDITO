/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { EDITING_SKILLS } from "@diffusionstudio/dapi";
import { skillBadge } from "./editing-skills-data";

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
});
