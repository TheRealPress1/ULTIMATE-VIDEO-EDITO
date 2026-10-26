/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Renderer-side wrappers for OS shell actions, which only the desktop main
// process can perform. Off the desktop build there is no shell to talk to, so
// these are no-ops rather than errors.

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

import type { EditorId, EditorInfo } from "@desktop/main-channels";

export type { EditorId, EditorInfo };

/**
 * Reveals a file or folder in the OS file manager — Finder on macOS, Explorer
 * on Windows — selecting it inside its parent folder.
 */
export async function revealPath(path: string): Promise<void> {
  if (!window.desktop || !path) return;
  await mainBridge.call(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, { path });
}

// Asked once per session: installing an editor while the app runs is rare
// enough to wait for the next launch, and the menu listing them should not
// fill in a beat after it opens.
let editors: Promise<EditorInfo[]> | undefined;

/** The code editors installed here that a folder can be opened in; none off the desktop. */
export function listEditors(): Promise<EditorInfo[]> {
  if (!window.desktop) return Promise.resolve([]);
  editors ??= mainBridge.call(MAIN_CHANNELS.APP_EDITORS_LIST, undefined).catch((error) => {
    console.warn("[shell] could not list editors", error);
    editors = undefined;
    return [];
  });
  return editors;
}

/** Opens the folder `dir` in the editor `id`. */
export async function openInEditor(id: EditorId, dir: string): Promise<void> {
  if (!window.desktop || !dir) return;
  await mainBridge.call(MAIN_CHANNELS.APP_OPEN_IN_EDITOR, { id, dir });
}
