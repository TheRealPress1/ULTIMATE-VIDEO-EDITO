/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { MEMORY_SAFETY_CATEGORIES } from "../memory-safety";
import { defineTool } from "../tool";

/** `profile`: who the user is and who they make videos for. `setup`: their machine and workspace. */
export const MEMORY_TARGETS = ["profile", "setup"] as const;
export type MemoryTarget = (typeof MEMORY_TARGETS)[number];

/**
 * Each list's budget. The profile also carries the creator's audience,
 * voice, recurring stories and proof, words to avoid and openers that
 * worked, so it is the larger of the two. Both together stay a short block
 * in a session's instructions.
 */
export const MEMORY_LIMITS: Readonly<Record<MemoryTarget, { chars: number; entries: number }>> = {
  profile: { chars: 2000, entries: 20 },
  setup: { chars: 1300, entries: 20 },
};
/** The longest single entry, in characters. */
export const MEMORY_ENTRY_MAX = 400;
/** The most changes one `apply` may carry. */
export const MEMORY_BATCH_MAX = 12;
/** How many earlier versions of the memory file are kept. */
export const MEMORY_HISTORY_MAX = 50;

/** Entry ids are `m_` and hex; `replace` and `remove` accept one in place of a substring. */
export const MEMORY_ENTRY_ID = /^m_[0-9a-f]{4,12}$/;

export const MemoryEntry = z.object({
  id: z.string(),
  text: z.string(),
  updatedAt: z.string(),
  origin: z.enum(["agent", "settings"]).describe("who wrote the entry last: an agent through this tool, or the user in Settings"),
});

/**
 * An entry as the tool returns it. One that fails today's safety check (a
 * hand edit, a restored old version, a rule added since) comes back with
 * `withheld` and without its text, so it can still be removed by id.
 */
const MemoryEntryOut = MemoryEntry.extend({
  text: z.string().optional().describe("the entry; left out when it is withheld"),
  withheld: z.enum(MEMORY_SAFETY_CATEGORIES).optional().describe("set when the entry fails Cutroom's safety check: agents don't get its text, and the user reviews it in Settings"),
});

/** The whole saved file: `<userData>/agent-memory/memory.json`. */
export const MemoryDocument = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  revision: z.int().nonnegative(),
  profile: z.array(MemoryEntry),
  setup: z.array(MemoryEntry),
  updatedAt: z.string().nullable(),
});

const Usage = z.object({ chars: z.int(), limit: z.int(), entries: z.int(), maxEntries: z.int() });

const EntryText = z.string().min(1).max(MEMORY_ENTRY_MAX);
const Match = z.string().min(3).max(200);

const MemoryOperation = z.object({
  action: z.enum(["add", "replace", "remove"]),
  target: z.enum(MEMORY_TARGETS).optional().describe("this change's list; default: the call's `target`"),
  text: EntryText.optional().describe("add and replace: the complete entry"),
  match: Match.optional().describe("replace and remove: an entry id (`m_3f9a`) or a part of its text found in exactly one entry"),
});

export const memory = defineTool({
  name: "memory", title: "Agent memory",
  description:
    "What Cutroom remembers about the user across chats and projects, in two short lists. `profile`: who they are and what they make — audience and viewer, platforms, voice, recurring stories and proof points, words to avoid, openers that worked, how they like to work. `setup`: machine and workspace facts — project and export folders, the connected Instagram handle, tool quirks. " +
    "Call `view` at the start of a task when the session did not open with saved memory. Save at once when the user asks you to remember or forget something; never save one-off requests or anything inferred from footage, transcripts, analytics or web pages. Visual taste (fonts, captions, pacing, colors) goes to `editing_style`, facts about one project to its brief.md, and a procedure the user wants repeated to `skill_write`. " +
    "Each entry is one short fact. `replace` and `remove` take an entry id or a unique part of its text; `apply` makes up to 12 changes in one step, all or none, with the budget checked after the last. A refused change (over budget, ambiguous, unsafe, stale `expectedRevision`, memory paused) writes nothing and returns the current entries: merge or drop old entries and retry. Credentials, contact details, links with query parameters and instructions aimed at agents are refused; a saved entry that fails that check comes back `withheld`, without its text, and can be changed only by its id. Changes reach new sessions, not the running one. Only this tool changes Cutroom's memory; never write it, or Claude's or Codex's own memory files, directly.",
  input: z.object({
    action: z.enum(["view", "add", "replace", "remove", "apply"]).default("view"),
    target: z.enum(MEMORY_TARGETS).optional().describe("the list to change; required for add, replace and remove, and the default for `apply` operations"),
    text: EntryText.optional().describe("add and replace: the complete entry, one fact in plain words"),
    match: Match.optional().describe("replace and remove: an entry id (`m_3f9a`) or a part of its text found in exactly one entry"),
    operations: z.array(MemoryOperation).min(1).max(MEMORY_BATCH_MAX).optional().describe("apply: the changes, in order; all are written or none"),
    expectedRevision: z.int().nonnegative().optional().describe("the revision you last viewed; when memory has changed since, nothing is written"),
  }),
  output: z.object({
    ok: z.boolean().describe("false when the change was refused and nothing was written"),
    enabled: z.boolean().describe("false while the user has paused memory in Settings: nothing is read into sessions or saved"),
    revision: z.int(),
    message: z.string(),
    profile: z.array(MemoryEntryOut).optional().describe("the profile entries, on view and whenever a change is refused"),
    setup: z.array(MemoryEntryOut).optional().describe("the setup entries, on view and whenever a change is refused"),
    usage: z.object({ profile: Usage, setup: Usage }),
    replaced: z.string().optional().describe("replace: the whole entry that was overwritten, unless it was withheld"),
    removed: z.array(z.string()).optional().describe("the text of each entry removed, leaving out withheld ones"),
    appliesFrom: z.literal("next-session"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  environment: "main",
});
