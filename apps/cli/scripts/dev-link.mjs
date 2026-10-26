/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Links this workspace's CLI as `cutroom`, without touching diffusion/dapi.
// macOS: Homebrew bin, or /usr/local/bin; Windows: %LOCALAPPDATA%\Cutroom\bin\cutroom.cmd.
// Explicitly invoked with `npm run link` or `npm run unlink` in apps/cli.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const remove = process.argv.includes("--remove");

const NAMES = ["cutroom"];

if (process.platform === "win32") {
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const dir = join(local, "Cutroom", "bin");
  const shims = NAMES.map((name) => join(dir, `${name}.cmd`));

  if (remove) {
    for (const shim of shims) {
      rmSync(shim, { force: true });
      console.log(`dev-link: removed ${shim}`);
    }
    process.exit(0);
  }

  const batch = (path) => path.replaceAll("%", "%%");
  mkdirSync(dir, { recursive: true });
  for (const shim of shims) {
    writeFileSync(shim, ["@echo off", "setlocal", `node "${batch(script)}" %*`, ""].join("\r\n"));
    console.log(`dev-link: ${shim} -> ${script}`);
  }

  if (addToUserPath(dir)) {
    console.log(`dev-link: added ${dir} to your PATH; open a new terminal to run \`cutroom\`.`);
  }
} else if (process.platform === "darwin") {
  const directories = ["/opt/homebrew/bin", "/usr/local/bin"];
  const present = directories.flatMap((dir) => NAMES.map((name) => join(dir, name)))
    .filter((path) => lstatSync(path, { throwIfNoEntry: false }));
  const owned = (path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()
    && resolve(dirname(path), readlinkSync(path)) === resolve(script);
  const dir = directories.find((path) => existsSync(path));

  if (remove) {
    for (const link of present.filter(owned)) {
      rmSync(link, { force: true });
      console.log(`dev-link: removed ${link}`);
    }
    process.exit(0);
  }

  const conflict = present.find((path) => !owned(path));
  if (conflict) {
    console.error(`dev-link: ${conflict} belongs to another command; nothing was changed.`);
    process.exit(1);
  }
  if (present.length) {
    console.log(`dev-link: already linked at ${present[0]}`);
    process.exit(0);
  }
  if (!dir) {
    console.error("dev-link: no standard command directory exists. Install the CLI from Cutroom.");
    process.exit(1);
  }

  for (const link of NAMES.map((name) => join(dir, name))) {
    symlinkSync(script, link);
    console.log(`dev-link: ${link} -> ${script}`);
  }
} else {
  console.error(`dev-link: no link location for ${process.platform}; put ${script} on your PATH yourself.`);
  process.exit(1);
}

// The user PATH in HKCU\Environment, edited the same way as
// apps/desktop/src/cli-windows.ts: through the registry, so the %VARIABLE%
// entries already there stay unexpanded, with a throwaway variable deletion
// to make .NET broadcast the change to new terminals. Returns whether the
// entry was added.
function addToUserPath(dir) {
  const normalize = (entry) => win32.normalize(entry).replace(/[\\/]+$/, "").toLowerCase();
  const powershell = (script, env) =>
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, ...env }, windowsHide: true, encoding: "utf8" },
    );

  const current = powershell(`
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
[Console]::Out.Write($key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'))
`);
  const entries = current.split(";").filter((entry) => entry.trim() !== "");
  if (entries.some((entry) => normalize(entry) === normalize(dir))) return false;

  powershell(
    `
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }
$key.SetValue('Path', $env:DAPI_USER_PATH, $kind)
[Environment]::SetEnvironmentVariable('DAPI_PATH_BROADCAST', $null, 'User')
`,
    { DAPI_USER_PATH: [...entries, dir].join(";") },
  );
  return true;
}
