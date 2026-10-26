/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The system clipboard, for media copied in other apps: files copied in the
// Finder (or a recording a screenshot app put there) and pictures (a
// screenshot, an image copied from a page). A ⌘V brings both in its paste
// event. A paste from a menu has no event: it reads pictures through the web
// clipboard API, which has no files, so those come from the desktop main
// process, and off the desktop a menu can only paste pictures.

import { createSignal } from "solid-js";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

/**
 * Media to paste: files that are on this computer, by path, and pictures
 * that are only bytes. Copied files come alone: a copied file reads as a
 * picture of itself too, and the file is what was copied.
 */
export type ClipboardMedia = { paths: string[]; images: Blob[] };

const NONE: ClipboardMedia = { paths: [], images: [] };

export const hasMedia = (media: ClipboardMedia) => media.paths.length > 0 || media.images.length > 0;

/**
 * What a paste event carries. Rich text from a document app carries a
 * picture of itself alongside, and that is not what was copied.
 */
export function pastedMedia(event: ClipboardEvent): ClipboardMedia {
  const data = event.clipboardData;
  if (!data || data.types.includes("text/rtf")) return NONE;

  const paths: string[] = [];
  const images: Blob[] = [];
  for (const file of Array.from(data.files)) {
    const path = window.desktop?.getPathForFile(file) || null;
    if (path) paths.push(path);
    else if (file.type.startsWith("image/")) images.push(file);
  }
  return paths.length ? { paths, images: [] } : { paths, images };
}

/** What the clipboard holds to paste, read without a paste event; nothing when it cannot be read. */
export async function readClipboardMedia(): Promise<ClipboardMedia> {
  const paths = await readClipboardPaths();
  if (paths.length) {
    setMediaOnClipboard(true);
    return { paths, images: [] };
  }

  const items = await readClipboardItems();
  const images = await Promise.all(
    items.flatMap((item) => {
      const type = imageType(item);
      return type ? [item.getType(type)] : [];
    }),
  );
  setMediaOnClipboard(images.length > 0);
  return { paths, images };
}

async function readClipboardPaths(): Promise<string[]> {
  if (!window.desktop) return [];
  try {
    return await mainBridge.call(MAIN_CHANNELS.CLIPBOARD_PATHS, undefined);
  } catch (error) {
    console.warn("[clipboard] could not read the copied files", error);
    return [];
  }
}

async function readClipboardItems(): Promise<ClipboardItem[]> {
  try {
    return await navigator.clipboard.read();
  } catch {
    // Not allowed, or the window is not focused.
    return [];
  }
}

/**
 * The picture's type in an item. The web clipboard API shows no rich text,
 * so plain text alongside is what gives away a document app's picture of it.
 */
function imageType(item: ClipboardItem): string | undefined {
  if (item.types.includes("text/plain")) return undefined;
  return item.types.find((type) => type.startsWith("image/"));
}

/**
 * Empties the clipboard of what other apps put there, for a copy the editor
 * keeps itself: a paste after it pastes that copy, not the screenshot taken
 * before it.
 */
export function claimClipboard(): void {
  setMediaOnClipboard(false);
  navigator.clipboard?.writeText("").catch((error) => console.warn("[clipboard] could not claim the clipboard", error));
}

const [mediaOnClipboard, setMediaOnClipboard] = createSignal(false);
let watching = false;

/**
 * Whether the clipboard holds media to paste, for a menu to offer Paste by.
 * Looked at again whenever the window comes back into focus or the pointer
 * back over it (the copy was made in another app, perhaps in a panel that
 * never took focus) and when a context menu opens, so it is reactive but a
 * beat behind the clipboard: a paste reads the clipboard itself. Only
 * looked at once reading is allowed: in a browser, a look would otherwise
 * ask the user for it out of the blue.
 */
export function clipboardHasMedia(): boolean {
  if (!watching) {
    watching = true;
    window.addEventListener("focus", look);
    document.documentElement.addEventListener("mouseenter", look);
    window.addEventListener("contextmenu", look, true);
    void look();
  }
  return mediaOnClipboard();
}

async function look(): Promise<void> {
  if (!(await mayRead())) return;
  if ((await readClipboardPaths()).length) {
    setMediaOnClipboard(true);
    return;
  }
  setMediaOnClipboard((await readClipboardItems()).some((item) => imageType(item) !== undefined));
}

async function mayRead(): Promise<boolean> {
  if (window.desktop) return true;
  try {
    const status = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}
