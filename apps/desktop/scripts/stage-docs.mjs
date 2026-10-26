/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stages the docs into apps/desktop/docs so electron-forge can ship them as
// an app resource (Contents/Resources/docs). The app's MCP server sends
// INSTRUCTIONS.md on connect along with this folder's path; agents read the
// rest as plain files. The tree is copied as it is in the repo, because the
// relative links between the pages assume that layout.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopDir, "..", "..");
const stageDir = join(desktopDir, "docs");

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(join(repoRoot, "docs"), stageDir, {
  recursive: true,
  filter: (path) => !path.endsWith(".DS_Store") && !path.endsWith(".gitkeep") && !path.endsWith("__pycache__") && !path.endsWith(".pyc"),
});
cpSync(join(repoRoot, "LICENSE"), join(stageDir, "LICENSE"));

console.log(`stage-docs: staged the docs at ${stageDir}`);
