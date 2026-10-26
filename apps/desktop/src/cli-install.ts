/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addShimToPath, removeShimFromPath, shimOnPath, shimPath, writeShim } from "./cli-windows";

import type { CliInstallResult, CliStatus, CliUninstallResult } from "./main-channels";
import { installMacCli, macCliStatus, uninstallMacCli, type MacCliOptions } from "./cli-macos";

export const CLI_LINK_DIR = "/usr/local/bin";

const DEV_LINK_DIR = "/opt/homebrew/bin";

/** Both app builds and terminal linking use the same Cutroom-only locations. */
export function macCliOptions(): MacCliOptions {
  return {
    target: app.isPackaged
      ? join(process.resourcesPath, "cli", "bin", "dapi")
      : join(app.getAppPath(), "..", "cli", "dist", "index.js"),
    directories: app.isPackaged ? [CLI_LINK_DIR, DEV_LINK_DIR] : [DEV_LINK_DIR, CLI_LINK_DIR],
    installDirectory: !app.isPackaged && existsSync(DEV_LINK_DIR) ? DEV_LINK_DIR : CLI_LINK_DIR,
    elevate: elevated,
  };
}

/**
 * Rewrites the Windows shim so it names this executable. Runs on every
 * packaged launch, because an update moved the app to a new folder; the
 * agents' MCP entries point at the shim whether or not it is on PATH.
 */
export function refreshCliShim(): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  writeShim().catch((e) => console.error("cli shim: could not write", e));
}

async function cliStatusWin32(): Promise<CliStatus> {
  const installed = await shimOnPath().catch(() => false);
  if (installed) {
    return { installed: true, path: shimPath(), managed: true, available: true };
  }
  return { installed: false, path: null, managed: false, available: app.isPackaged };
}

/** Where `cutroom` stands on this machine, without asking for a password. */
export async function cliStatus(): Promise<CliStatus> {
  if (process.platform === "win32") return cliStatusWin32();
  if (process.platform === "darwin") return macCliStatus(macCliOptions());

  return { installed: false, path: null, managed: false, available: false };
}

// Only a protected system bin directory needs the standard macOS admin prompt.
function elevated(shell: string): Promise<void> {
  const script = `do shell script ${JSON.stringify(shell)} with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve()));
  });
}

async function installCliWin32(): Promise<CliInstallResult> {
  try {
    await writeShim();
    await addShimToPath();
    return { status: "installed" };
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
}

export async function installCli(): Promise<CliInstallResult> {
  if (process.platform === "darwin") return installMacCli(macCliOptions());
  if (process.platform === "win32" && app.isPackaged) return installCliWin32();
  return {
    status: "error",
    error: process.platform === "win32"
      ? "Install the packaged Cutroom app to use its CLI on Windows."
      : "Installing the CLI is only available on Windows and macOS.",
  };
}

async function uninstallCliWin32(): Promise<CliUninstallResult> {
  try {
    if (!(await shimOnPath())) return { status: "absent" };
    await removeShimFromPath();
    return { status: "removed" };
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
}

/** Removes only links that belong to this Cutroom build. */
export async function uninstallCli(): Promise<CliUninstallResult> {
  if (process.platform === "win32") return uninstallCliWin32();
  if (process.platform === "darwin") return uninstallMacCli(macCliOptions());

  return {
    status: "error",
    error: `Uninstalling the CLI is only available on Windows and macOS.`,
  };
}
