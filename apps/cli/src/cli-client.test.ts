/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile,
}));

import { launchDarwin } from "./cli-client";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("macOS CLI app launch", () => {
  it.each([false, true])("opens its own packaged app with background=%s", async (background) => {
    const appPath = "/Applications/My Editor's Copies/Cutroom.app";
    vi.stubEnv("CUTROOM_APP_PATH", appPath);
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null));

    expect(await launchDarwin(background)).toBe(true);
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      "open",
      background ? ["-g", "-a", appPath, "--args", "--hidden"] : ["-a", appPath],
      { env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }) },
      expect.any(Function),
    );
  });

  it("uses the registered application name for an unbundled CLI", async () => {
    vi.stubEnv("CUTROOM_APP_PATH", undefined);
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null));

    expect(await launchDarwin(false)).toBe(true);
    expect(execFile.mock.calls[0]?.[1]).toEqual(["-a", "Cutroom"]);
  });

  it("does not launch another app copy if its containing bundle is missing", async () => {
    const appPath = "/Applications/Removed Cutroom.app";
    vi.stubEnv("CUTROOM_APP_PATH", appPath);
    execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error("Application not found")));

    expect(await launchDarwin(true)).toBe(false);
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0]?.[1]).toContain(appPath);
  });
});
