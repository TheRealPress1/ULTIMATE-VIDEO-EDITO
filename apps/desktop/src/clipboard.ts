/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The files on the system clipboard: what a copy in Finder or Explorer (or
// of a recording in a screenshot app) leaves there. The renderer reads
// pictures itself, but its clipboard API does not expose real file paths.

import { clipboard } from "electron";
import { fileURLToPath } from "node:url";

/** The files on the clipboard, by path, in the order they were copied. */
export async function clipboardPaths(): Promise<string[]> {
  const paths: string[] = [];
  // Electron 44 maps this MIME type to native copied files: CF_HDROP on
  // Windows, NSFilenamesPboardType on macOS, and text/uri-list on Linux.
  // Unlike FileNameW, it includes every copied file on Windows as well.
  for (const item of await clipboard.read()) {
    if (!item.types.includes("text/uri-list")) continue;
    const blob = await item.getType("text/uri-list");
    for (const line of (await blob.text()).split(/\r?\n/)) {
      const uri = line.trim();
      if (!/^file:/i.test(uri)) continue;
      try {
        const path = fileURLToPath(uri);
        if (!path.includes("\0")) paths.push(path);
      } catch {
        // One malformed URI must not discard the other copied files.
      }
    }
  }
  return paths;
}
