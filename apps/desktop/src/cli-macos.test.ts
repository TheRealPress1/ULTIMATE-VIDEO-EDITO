/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMacCli, macCliStatus, uninstallMacCli } from "./cli-macos";
import type { MacCliOptions } from "./cli-macos";

let root: string;
let target: string;
let directories: string[];
let options: MacCliOptions;
const link = (index = 0): string => join(directories[index]!, "cutroom");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cutroom-cli-"));
  target = join(root, "workspace's CLI $node", "index.js");
  directories = [join(root, "first bin's"), join(root, "second bin")];
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
  options = { target, directories, installDirectory: directories[0]! };
});

afterEach(() => {
  for (const directory of directories) {
    if (existsSync(directory)) chmodSync(directory, 0o755);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("macOS CLI installation", () => {
  it("installs and removes an executable workspace build, including spaces and quotes", async () => {
    expect(macCliStatus(options)).toEqual({ installed: false, path: null, managed: false, available: true });
    expect(await installMacCli(options)).toEqual({ status: "installed" });
    expect(readlinkSync(link())).toBe(target);
    expect(macCliStatus(options)).toEqual({ installed: true, path: link(), managed: true, available: true });
    expect(await uninstallMacCli(options)).toEqual({ status: "removed" });
    expect(lstatSync(link(), { throwIfNoEntry: false })).toBeUndefined();
    expect(await uninstallMacCli(options)).toEqual({ status: "absent" });
  });

  it("recognizes a relative owned link in another known directory and leaves it intact on reinstall", async () => {
    mkdirSync(directories[1]!);
    const destination = relative(directories[1]!, target);
    symlinkSync(destination, link(1));
    const inode = lstatSync(link(1)).ino;
    expect(await installMacCli(options)).toEqual({ status: "installed" });
    expect(readlinkSync(link(1))).toBe(destination);
    expect(lstatSync(link(1)).ino).toBe(inode);
    expect(existsSync(link())).toBe(false);
    expect(macCliStatus(options)).toMatchObject({ installed: true, managed: true, path: link(1) });
  });

  it("removes every owned link across known directories", async () => {
    for (const directory of directories) {
      mkdirSync(directory);
      symlinkSync(target, join(directory, "cutroom"));
    }
    expect(await uninstallMacCli(options)).toEqual({ status: "removed" });
    for (const directory of directories) expect(existsSync(join(directory, "cutroom"))).toBe(false);
  });

  it.each(["missing", "not executable", "directory"])("refuses a %s target without creating a link", async (kind) => {
    if (kind === "not executable") chmodSync(target, 0o644);
    else {
      unlinkSync(target);
      if (kind === "directory") mkdirSync(target);
    }
    const elevate = vi.fn();
    expect(macCliStatus(options).available).toBe(false);
    expect(await installMacCli({ ...options, elevate })).toMatchObject({ status: "error", error: expect.stringContaining("missing or not executable") });
    expect(existsSync(options.installDirectory)).toBe(false);
    expect(elevate).not.toHaveBeenCalled();
  });

  it("reports a broken owned link as repairable ownership and can remove it", async () => {
    mkdirSync(directories[0]!);
    symlinkSync(target, link());
    unlinkSync(target);
    expect(macCliStatus(options)).toEqual({ installed: false, path: link(), managed: true, available: false });
    expect(await installMacCli(options)).toMatchObject({ status: "error" });
    expect(await uninstallMacCli(options)).toEqual({ status: "removed" });
    expect(lstatSync(link(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it.each(["regular file", "symlink", "broken symlink", "directory"])("preserves an unrelated %s on install and uninstall", async (kind) => {
    mkdirSync(directories[0]!);
    const foreign = join(root, "foreign-cli");
    if (kind === "regular file") writeFileSync(link(), "foreign command", { mode: 0o755 });
    else if (kind === "directory") mkdirSync(link());
    else {
      if (kind === "symlink") writeFileSync(foreign, "foreign command", { mode: 0o755 });
      symlinkSync(foreign, link());
    }
    const before = lstatSync(link());
    const elevate = vi.fn();
    expect(macCliStatus(options)).toMatchObject({ installed: kind === "regular file" || kind === "symlink", managed: false, path: link() });
    expect(await installMacCli({ ...options, elevate })).toMatchObject({ status: "error", error: expect.stringContaining("left alone") });
    expect(await uninstallMacCli({ ...options, elevate })).toEqual({ status: "absent" });
    expect(lstatSync(link()).ino).toBe(before.ino);
    if (kind === "regular file") expect(readFileSync(link(), "utf8")).toBe("foreign command");
    if (kind.includes("symlink")) expect(readlinkSync(link())).toBe(foreign);
    expect(elevate).not.toHaveBeenCalled();
  });

  it("preserves a foreign link while removing an owned link in a different directory", async () => {
    for (const directory of directories) mkdirSync(directory);
    symlinkSync(join(root, "missing foreign target"), link());
    symlinkSync(target, link(1));
    expect(await uninstallMacCli(options)).toEqual({ status: "removed" });
    expect(lstatSync(link()).isSymbolicLink()).toBe(true);
    expect(lstatSync(link(1), { throwIfNoEntry: false })).toBeUndefined();
  });

  it.each([0, 1])("refuses a foreign command in directory %i even when another directory has an owned link", async (foreignIndex) => {
    for (const directory of directories) mkdirSync(directory);
    writeFileSync(link(foreignIndex), "foreign command", { mode: 0o755 });
    symlinkSync(target, link(1 - foreignIndex));
    const inodes = directories.map((_, index) => lstatSync(link(index)).ino);
    const elevate = vi.fn();
    expect(await installMacCli({ ...options, elevate })).toMatchObject({ status: "error", error: expect.stringContaining("left alone") });
    expect(readFileSync(link(foreignIndex), "utf8")).toBe("foreign command");
    expect(readlinkSync(link(1 - foreignIndex))).toBe(target);
    expect(directories.map((_, index) => lstatSync(link(index)).ino)).toEqual(inodes);
    expect(elevate).not.toHaveBeenCalled();
  });
});

// Permission-denied behavior uses only temporary directories and a fake prompt.
// Root bypasses filesystem mode restrictions, so these cases need an ordinary user.
describe.skipIf(process.getuid?.() === 0)("administrator fallback", () => {
  it("quotes paths and requires an absent destination before elevated installation", async () => {
    mkdirSync(directories[0]!);
    chmodSync(directories[0]!, 0o555);
    const elevate = vi.fn(async (shell: string) => {
      expect(shell).toContain(`[ ! -e ${quote(link())} ] && [ ! -L ${quote(link())} ] && ln -s ${quote(target)} ${quote(link())}`);
      expect(shell).not.toContain("ln -sf");
      chmodSync(directories[0]!, 0o755);
      symlinkSync(target, link());
    });
    expect(await installMacCli({ ...options, elevate })).toEqual({ status: "installed" });
    expect(elevate).toHaveBeenCalledOnce();
  });

  it("requires the same raw relative target before elevated removal", async () => {
    mkdirSync(directories[0]!);
    const destination = relative(directories[0]!, target);
    symlinkSync(destination, link());
    chmodSync(directories[0]!, 0o555);
    const elevate = vi.fn(async (shell: string) => {
      expect(shell).toContain(`[ -L ${quote(link())} ] && [ "$(readlink ${quote(link())})" = ${quote(destination)} ]`);
      expect(shell).toContain(`elif [ -e ${quote(link())} ] || [ -L ${quote(link())} ]; then exit 1`);
      chmodSync(directories[0]!, 0o755);
      unlinkSync(link());
    });
    expect(await uninstallMacCli({ ...options, elevate })).toEqual({ status: "removed" });
    expect(elevate).toHaveBeenCalledOnce();
  });

  it("reports cancellation without installing anything", async () => {
    mkdirSync(directories[0]!);
    chmodSync(directories[0]!, 0o555);
    const elevate = vi.fn(async () => { throw new Error("User cancelled. (-128)"); });
    expect(await installMacCli({ ...options, elevate })).toEqual({ status: "cancelled" });
    expect(lstatSync(link(), { throwIfNoEntry: false })).toBeUndefined();
  });
});
