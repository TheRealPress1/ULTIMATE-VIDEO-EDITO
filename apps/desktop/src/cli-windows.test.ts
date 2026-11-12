/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parts of the Windows CLI install that are decisions rather than system
// calls: where the shim lives, what it says, and how the user's PATH is
// edited without disturbing the entries around ours.

import { describe, expect, it } from "vitest";

import { pathHas, pathWith, pathWithout, shimContent, shimDir, shimPath, stagedScript } from "./cli-windows";

const local = "C:\\Users\\me\\AppData\\Local";
const exe = `${local}\\Cutroom\\app-1.2.0\\Blackout.exe`;
const dir = `${local}\\Cutroom\\bin`;

describe("shim", () => {
  it("lives outside the versioned app folder", () => {
    expect(shimDir({ LOCALAPPDATA: local })).toBe(dir);
    expect(shimPath({ LOCALAPPDATA: local })).toBe(`${dir}\\cutroom.cmd`);
  });

  it("runs the staged CLI on the app's executable in Node mode", () => {
    expect(stagedScript(exe)).toBe(`${local}\\Cutroom\\app-1.2.0\\resources\\cli\\dapi.js`);
    expect(shimContent(exe).split("\r\n")).toEqual([
      "@echo off",
      "setlocal",
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${exe}" "${stagedScript(exe)}" %*`,
      "",
    ]);
  });

  it("escapes percent signs, which batch files would expand", () => {
    expect(shimContent("C:\\Users\\100%me\\app.exe", "C:\\x\\dapi.js")).toContain('"C:\\Users\\100%%me\\app.exe"');
  });
});

describe("user PATH", () => {
  const path = "%USERPROFILE%\\.cargo\\bin;C:\\Tools";

  it("appends the folder once, leaving other entries as written", () => {
    expect(pathWith(path, dir)).toBe(`${path};${dir}`);
    expect(pathWith(`${path};${dir}`, dir)).toBe(`${path};${dir}`);
    expect(pathWith("", dir)).toBe(dir);
  });

  it("matches without case and trailing separators", () => {
    expect(pathHas(`${path};${dir.toUpperCase()}\\`, dir)).toBe(true);
    expect(pathHas(path, dir)).toBe(false);
  });

  it("removes every spelling of the folder and nothing else", () => {
    expect(pathWithout(`${dir}\;${path};${dir.toLowerCase()}`, dir)).toBe(path);
    expect(pathWithout(path, dir)).toBe(path);
  });
});
