/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MemorySafetyCategory } from "@diffusionstudio/dapi";
import type { AgentMemoryEntryView, AgentMemoryHistoryItem, AgentMemoryTarget, AgentMemoryUsage } from "@desktop/agent-memory-types";

export const MEMORY_LISTS: ReadonlyArray<{ target: AgentMemoryTarget; title: string; hint: string; placeholder: string }> = [
  {
    target: "profile",
    title: "About you",
    hint: "Who you are and who you make videos for: your audience, platforms, voice, recurring stories and proof, words to avoid, openers that worked.",
    placeholder: "For example: Makes French-language cooking Reels for busy parents.",
  },
  {
    target: "setup",
    title: "Your setup",
    hint: "Your machine and workspace: where projects and exports go, the connected Instagram handle, tool quirks.",
    placeholder: "For example: Exports go to ~/Movies/Cutroom.",
  },
];

const WITHHELD: Record<MemorySafetyCategory, string> = {
  "hidden-unicode": "it has hidden characters",
  "control-characters": "it has control characters",
  secret: "it looks like a credential",
  exfiltration: "it looks like a link or command that sends data",
  "instruction-override": "it reads like an instruction to agents",
  "role-markers": "it imitates a chat role marker",
  "contact-details": "it has contact details",
  formatting: "it has Markdown formatting",
};

const number = (n: number) => n.toLocaleString("en-US");

/** "420 / 2,000 characters · 3 of 20 entries". */
export function usageLine(usage: AgentMemoryUsage): string {
  return `${number(usage.chars)} / ${number(usage.limit)} characters · ${usage.entries} of ${usage.maxEntries} ${usage.maxEntries === 1 ? "entry" : "entries"}`;
}

/** How full a list is, 0 to 1, by whichever budget is closer to its end. */
export function usageRatio(usage: AgentMemoryUsage): number {
  const ratio = Math.max(usage.limit ? usage.chars / usage.limit : 0, usage.maxEntries ? usage.entries / usage.maxEntries : 0);
  return Math.min(1, Math.max(0, ratio));
}

export function usageTone(usage: AgentMemoryUsage): "ok" | "near" | "full" {
  const ratio = usageRatio(usage);
  return ratio >= 1 ? "full" : ratio >= 0.85 ? "near" : "ok";
}

/** Why an entry is not shown to chats, for its badge; null when it is. */
export function withheldLabel(entry: Pick<AgentMemoryEntryView, "withheld">): string | null {
  return entry.withheld ? `Not shown to chats: ${WITHHELD[entry.withheld]}. Edit or delete it.` : null;
}

export function originLabel(entry: Pick<AgentMemoryEntryView, "origin">): string {
  return entry.origin === "settings" ? "Added by you" : "Saved by an agent";
}

/** "Revision 4 · 3 entries · replaced Nov 3, 2026, 12:00 PM". */
export function historyLabel(item: AgentMemoryHistoryItem, locale = "en-US", timeZone?: string): string {
  const when = new Date(item.savedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  return `Revision ${item.revision} · ${item.entries} ${item.entries === 1 ? "entry" : "entries"} · replaced ${when}`;
}
