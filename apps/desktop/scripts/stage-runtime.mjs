/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stages the main process's external dependencies into apps/desktop/runtime
// so electron-forge can ship them as an app resource (Contents/Resources/
// runtime). A packaged app has no node_modules of its own: everything else
// is bundled into dist/main.js, but esbuild (native binary) and the babel
// toolchain stay external and are loaded from here at run time (see `load`
// in src/projects.ts). The staged layout:
//   runtime/package.json   the externals, pinned to the workspace's versions
//   runtime/node_modules   a fresh `npm install --omit=dev` of them
//
// The list of externals is read from the build:main script so that it cannot
// drift from what the bundle actually leaves unresolved.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npm } from "../../../scripts/lib/npm.mjs";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(desktopDir, "runtime");
const require = createRequire(join(desktopDir, "package.json"));

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const externals = [...pkg.scripts["build:main"].matchAll(/--external:(\S+)/g)]
  .map((match) => match[1])
  // Electron is provided by the host binary, not installed.
  .filter((name) => name !== "electron");

// Pin what the workspace has installed (and was tested against), not the
// ranges in package.json.
const dependencies = Object.fromEntries(
  externals.map((name) => [name, require(`${name}/package.json`).version]),
);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

writeFileSync(
  join(stageDir, "package.json"),
  JSON.stringify({ name: "desktop-runtime", private: true, dependencies }, null, 2),
);

npm(["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: stageDir });

// Forge's osx-sign pass walks all Mach-O files inside Contents, including
// Resources/runtime. Sign only the finished bundle, with its configured
// identity, so staging never chooses a different certificate implicitly.

console.log(`stage-runtime: staged ${externals.join(", ")} at ${stageDir}`);
