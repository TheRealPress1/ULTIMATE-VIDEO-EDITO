/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LogEntry, ToolArgs, ToolResult } from "@diffusionstudio/dapi";
import type { EditingStyleStore } from "../editing-style";
import type { AudioCatalogStore } from "../audio-catalog";

/** The main window, as the `window` tool drives it. */
export type AppWindow = {
  /** Whether the window is out for the user. */
  visible(): boolean;
  /** Shows and focuses it, creating it when there is none. */
  show(): Promise<void>;
  /** Puts it away; the app keeps running in the background. */
  hide(): void;
};

/** What a main-process handler gets besides its arguments. */
export type MainContext = {
  docsDir?: string | null;
  editingStyle?: EditingStyleStore;
  /** `<userData>/agent-memory/memory.json`, for `memory`; absent when memory is turned off for the session (CUTROOM_MEMORY=0). */
  agentMemoryFile?: string;
  /** `<userData>/agent-skills`: the user's own skills, which `skill_write` writes and `skills` lists. */
  agentSkillsDir?: string;
  /** The music and effect catalog with the user's personal layer. */
  audioCatalog?: AudioCatalogStore;
  /** Fires when the caller cancels or goes away. */
  signal: AbortSignal;
  /** The app's console buffer, oldest first. */
  logs(): LogEntry[];
  /** The app's version. */
  version: string;
  /** The project the editor has open (or last had), when the handler needs it; null when none is. */
  project?(): string | null;
  /** The main window. */
  window: AppWindow;
};

/** The tools that need the file system, a child process or the window itself, not a renderer. */
export type MainToolName = "logs" | "report" | "window" | "instagram_accounts" | "instagram_posts" | "instagram_post_analytics" | "instagram_account_insights" | "skills" | "editing_style" | "audio_catalog" | "web_media_search" | "media_search" | "sound_analyze" | "script_lint" | "memory" | "skill_write";

export type MainHandler<N extends MainToolName> = (args: ToolArgs<N>, ctx: MainContext) => Promise<ToolResult<N>>;

export type MainHandlers = { readonly [N in MainToolName]: MainHandler<N> };
