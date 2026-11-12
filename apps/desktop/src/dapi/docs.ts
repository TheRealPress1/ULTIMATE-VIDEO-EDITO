/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

/**
 * The most the assembled instructions may run to. Claude Code keeps only the
 * first 4,096 characters of a server's instructions and drops the rest
 * silently, so the whole text — docs path included — stays under that with
 * room for a long install path. Detail belongs in the skills and reference
 * pages the text points to, not here.
 */
export const INSTRUCTIONS_LIMIT = 3900;

const FALLBACK_INSTRUCTIONS =
  "Blackout, a video editor, is running on this machine and you are connected to it. The tools are the whole API; their descriptions are authoritative.";

/**
 * The text every client gets on connect: where the docs sit on disk, then
 * INSTRUCTIONS.md from the docs. The path goes first so a client that cuts
 * long instructions short still learns where the pages are. The page names
 * the skills and everything else it wants read — adding one is editing that
 * file, not this one; the paths in it are relative to the docs, and the
 * sentence below is what anchors them.
 */
export function instructions(docsDir: string | null): string {
  const text = docsDir ? readText(join(docsDir, INSTRUCTIONS_FILE)) : null;
  const body = text?.trim() || FALLBACK_INSTRUCTIONS;
  if (!docsDir) return body;
  return [
    `Blackout's docs are the files at \`${docsDir}\`: the skills, the tool and JSX reference, guides, runnable examples, and the brand kit (fonts, imagery, components to copy). Every page path below is relative to that folder. They belong to the app; read them, never edit them.`,
    body,
  ].join("\n\n");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
