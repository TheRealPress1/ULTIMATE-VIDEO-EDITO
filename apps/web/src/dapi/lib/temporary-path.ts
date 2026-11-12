/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const POSIX_TEMP = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const WINDOWS_TEMP = /^[a-z]:[\\/](?:windows[\\/]temp|.*[\\/]appdata[\\/]local[\\/]temp)[\\/]/i;

/**
 * Whether an absolute path is in a temporary folder, where an agent puts what
 * it does not mean to keep, such as the review drafts of an export. It mirrors
 * the temp roots of the desktop output policy (`tmpdir()`, `/tmp` and
 * `/private/tmp`); a macOS `TMPDIR` lives under `/var/folders`, a Windows one
 * in `AppData\Local\Temp`. Only the screen an export gets depends on it, so a
 * path it misjudges costs a dialog, never a file. One that climbs out with
 * `..` is not judged by where it starts.
 */
export function isTemporaryPath(path: string): boolean {
  if (path.split(/[\\/]/).includes("..")) return false;
  return POSIX_TEMP.some((root) => path.startsWith(root)) || WINDOWS_TEMP.test(path);
}

/**
 * Whether an export to `path` is a throwaway draft: in a temporary folder, and
 * not in the project itself. What an export writes into the open project is its
 * delivery, wherever that project happens to live.
 */
export function isDraftPath(path: string, projectDir: string): boolean {
  const root = projectDir.replace(/[\\/]+$/, "");
  const inProject = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
  return isTemporaryPath(path) && !inProject;
}
