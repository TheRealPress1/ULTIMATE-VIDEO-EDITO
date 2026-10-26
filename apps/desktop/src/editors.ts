/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Code editors a project folder can be opened in. A project is a folder of
// JSX, so editing it by hand is a real way of working on it, and the app's
// watcher puts whatever the editor saves on the canvas.

import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export type EditorId = "vscode" | "cursor" | "zed";

export type EditorInfo = { id: EditorId; label: string };

/**
 * The editors offered, in menu order. Each is found by the URL scheme it
 * registers with the OS when installed: asking who handles it answers both
 * whether the editor is there and where, on macOS and Windows alike, without
 * knowing where anyone keeps their applications.
 */
const EDITORS: Array<EditorInfo & { protocol: string }> = [
  { id: "vscode", label: "VS Code", protocol: "vscode://" },
  { id: "cursor", label: "Cursor", protocol: "cursor://" },
  { id: "zed", label: "Zed", protocol: "zed://" },
];

/** Where the app handling `protocol` lives (the .app on macOS, the .exe on Windows), or null when none does. */
async function handlerPath(protocol: string): Promise<string | null> {
  try {
    return (await app.getApplicationInfoForProtocol(protocol)).path || null;
  } catch {
    return null;
  }
}

/** The editors installed here, in menu order. */
export async function installedEditors(): Promise<EditorInfo[]> {
  const found = await Promise.all(EDITORS.map(async (editor) => ((await handlerPath(editor.protocol)) ? editor : null)));
  return found.filter((editor) => editor !== null).map(({ id, label }) => ({ id, label }));
}

/** Opens the folder `dir` in the editor `id`. */
export async function openInEditor(id: EditorId, dir: string): Promise<void> {
  const editor = EDITORS.find((candidate) => candidate.id === id);
  if (!editor) throw new Error(`Unknown editor "${id}".`);
  if (!isAbsolute(dir)) throw new Error(`The folder must be an absolute path (got "${dir}").`);

  const path = await handlerPath(editor.protocol);
  if (!path) throw new Error(`${editor.label} is not installed.`);

  if (process.platform === "darwin") {
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/open", ["-a", path, dir], (error) => (error ? reject(error) : resolve()));
    });
    return;
  }

  // Windows: the editor's own executable takes a folder to open, and outlives the app.
  const child = spawn(path, [dir], { detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error(`[editors] could not start ${editor.label}:`, error));
  child.unref();
}
