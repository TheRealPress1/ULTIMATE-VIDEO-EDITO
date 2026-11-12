/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { accessSync, constants, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CliInstallResult, CliStatus, CliUninstallResult } from "./main-channels";

export type MacCliOptions = {
  target: string;
  directories: readonly string[];
  installDirectory: string;
  elevate?: (shell: string) => Promise<void>;
};

const linkPaths = (options: MacCliOptions): string[] => [...new Set(options.directories.map((dir) => join(dir, "cutroom")))];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const permissionError = (error: unknown): boolean => ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
const cancelled = (error: unknown): boolean => message(error).includes("-128");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Returns the original link text only when this build owns the target. */
function ownedLink(path: string, target: string): string | null {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  const destination = readlinkSync(path);
  return resolve(dirname(path), destination) === resolve(target) ? destination : null;
}

// Builds before Blackout were called Cutroom.app and linked the command into their own bundle.
const EARLIER_TARGET = /\/Cutroom\.app\/Contents\/Resources\/cli\/bin\/dapi$/;

/** The original link text when an earlier build made the link and that build's app is gone: this build's to replace. */
function staleLink(path: string): string | null {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  const destination = readlinkSync(path);
  const resolved = resolve(dirname(path), destination);
  return EARLIER_TARGET.test(resolved) && !executable(resolved) ? destination : null;
}

export function macCliStatus(options: MacCliOptions): CliStatus {
  const available = executable(options.target);
  for (const path of linkPaths(options)) {
    try {
      if (!lstatSync(path, { throwIfNoEntry: false })) continue;
      return { installed: executable(path), path, managed: ownedLink(path, options.target) !== null || staleLink(path) !== null, available };
    } catch {
      // An inaccessible location is not evidence of an install we can manage.
    }
  }
  return { installed: false, path: null, managed: false, available };
}

export async function installMacCli(options: MacCliOptions): Promise<CliInstallResult> {
  if (!executable(options.target)) {
    return { status: "error", error: "The Blackout command-line tool is missing or not executable. Rebuild or reinstall Blackout, then try again." };
  }
  const target = resolve(options.target);
  const path = join(options.installDirectory, "cutroom");
  try {
    let installed = false;
    const stale: string[] = [];
    for (const candidate of new Set([...linkPaths(options), path])) {
      if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
      if (staleLink(candidate) !== null) {
        stale.push(candidate);
        continue;
      }
      if (ownedLink(candidate, target) === null) {
        return { status: "error", error: `${candidate} already exists and belongs to another installation. It was left alone.` };
      }
      installed = true;
    }
    for (const candidate of stale) {
      unlinkSync(candidate);
      symlinkSync(target, candidate);
      installed = true;
    }
    if (installed) return { status: "installed" };
    mkdirSync(options.installDirectory, { recursive: true });
    symlinkSync(target, path);
    return { status: "installed" };
  } catch (error) {
    if (!permissionError(error) || !options.elevate) return { status: "error", error: message(error) };
  }
  try {
    // Never replace an entry that appeared while the administrator prompt was open. The one exception is a
    // dangling link into an earlier Cutroom.app, which is what a build before Blackout left behind.
    await options.elevate!(
      `[ -f ${quote(target)} ] && [ -x ${quote(target)} ] && ` +
      `mkdir -p ${quote(options.installDirectory)} && ` +
      `{ if [ -L ${quote(path)} ] && [ ! -e ${quote(path)} ]; then case "$(readlink ${quote(path)})" in */Cutroom.app/Contents/Resources/cli/bin/dapi) rm ${quote(path)};; esac; fi; } && ` +
      `[ ! -e ${quote(path)} ] && [ ! -L ${quote(path)} ] && ln -s ${quote(target)} ${quote(path)}`,
    );
    if (ownedLink(path, target) === null || !executable(path)) throw new Error("The Blackout CLI link could not be verified.");
    return { status: "installed" };
  } catch (error) {
    return cancelled(error) ? { status: "cancelled" } : { status: "error", error: message(error) };
  }
}

export async function uninstallMacCli(options: MacCliOptions): Promise<CliUninstallResult> {
  let removed = false;
  try {
    for (const path of linkPaths(options)) {
      const destination = ownedLink(path, options.target) ?? staleLink(path);
      if (destination === null) continue;
      try {
        unlinkSync(path);
      } catch (error) {
        if (!permissionError(error) || !options.elevate) throw error;
        // Compare the exact link again after the prompt, including relative targets.
        await options.elevate(
          `if [ -L ${quote(path)} ] && [ "$(readlink ${quote(path)})" = ${quote(destination)} ]; then ` +
          `rm ${quote(path)}; elif [ -e ${quote(path)} ] || [ -L ${quote(path)} ]; then exit 1; fi`,
        );
        if (ownedLink(path, options.target) !== null || staleLink(path) !== null) throw new Error("The Blackout CLI link could not be removed.");
      }
      removed = true;
    }
    return { status: removed ? "removed" : "absent" };
  } catch (error) {
    return cancelled(error) ? { status: "cancelled" } : { status: "error", error: message(error) };
  }
}
