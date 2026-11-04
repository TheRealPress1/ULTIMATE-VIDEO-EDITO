/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What Settings' "What agents remember" panel exchanges with main. Types
// only, so the renderer can import them without Node.

import type { MemorySafetyCategory } from "@diffusionstudio/dapi";

export type AgentMemoryTarget = "profile" | "setup";

export type AgentMemoryEntryView = {
  id: string;
  text: string;
  updatedAt: string;
  origin: "agent" | "settings";
  /** Set when the entry fails today's safety check: it is kept, but never shown to a session. */
  withheld?: MemorySafetyCategory;
};

export type AgentMemoryUsage = { chars: number; limit: number; entries: number; maxEntries: number };

export type AgentMemoryHistoryItem = {
  /** Pass to a `restore`. */
  id: string;
  /** The revision that version was. */
  revision: number;
  /** When it was replaced. */
  savedAt: string;
  /** How many entries it held, both lists together. */
  entries: number;
};

export type AgentMemorySnapshot = {
  /** False when memory is turned off for this app session (CUTROOM_MEMORY=0). */
  available: boolean;
  /** False while the user has paused memory: no digest, and agents can save neither notes nor skills. */
  enabled: boolean;
  revision: number;
  updatedAt: string | null;
  profile: AgentMemoryEntryView[];
  setup: AgentMemoryEntryView[];
  usage: Record<AgentMemoryTarget, AgentMemoryUsage>;
  /** The longest entry, in characters. */
  entryMax: number;
  /** Earlier versions, newest first. */
  history: AgentMemoryHistoryItem[];
};

export type AgentMemoryEdit = {
  action: "add" | "replace" | "remove";
  target: AgentMemoryTarget;
  text?: string;
  /** An entry id, for replace and remove. */
  match?: string;
};

export type AgentMemoryApply =
  | { kind: "edit"; expectedRevision: number; operations: AgentMemoryEdit[] }
  | { kind: "enabled"; expectedRevision: number; enabled: boolean }
  | { kind: "restore"; expectedRevision: number; historyId: string };
