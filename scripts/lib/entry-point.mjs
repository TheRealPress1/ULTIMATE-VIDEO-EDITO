/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whether a module is the script node was started with, so a script can both
// run from the command line and be imported by its tests.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when `moduleUrl` (a module's `import.meta.url`) is the file node was
 * started with. Node gives the module its real path but keeps
 * `process.argv[1]` as typed, so both are resolved through symlinks before
 * they are compared; comparing them as URLs fails, and the script silently
 * does nothing, when it is run through a linked path such as macOS's `/tmp`.
 */
export function isEntryPoint(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
