/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ToolOutput } from "@diffusionstudio/dapi";

type Skill = Pick<ToolOutput<"skills">["skills"][number], "available" | "category">;

const LABELS: Record<Skill["category"], string> = {
  editing: "Built in",
  optional: "Optional API",
  addon: "Local add-on",
  reference: "Reference",
};

/**
 * The badge on a skill card: what the guide relies on, so a guide that runs
 * on this Mac through an add-on never reads like a cloud import.
 */
export function skillBadge(skill: Skill): { label: string; tone: "unavailable" | "built-in" | "muted" } {
  if (!skill.available) return { label: "Unavailable", tone: "unavailable" };
  return { label: LABELS[skill.category], tone: skill.category === "editing" ? "built-in" : "muted" };
}
