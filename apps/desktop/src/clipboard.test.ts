/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("electron", () => ({ clipboard: { read } }));

import { clipboardPaths } from "./clipboard";

function item(type: string, text: string) {
  return { types: [type], getType: vi.fn(async () => new Blob([text])) };
}

beforeEach(() => {
  read.mockReset();
});

describe("clipboardPaths", () => {
  it("reads every copied file in order, decoding native paths and Unicode", async () => {
    const paths = ["Clip & one.mov", "été #2.mp4", "third.png"].map((name) => join(tmpdir(), name));
    const urls = paths.map((path) => pathToFileURL(path).href);
    read.mockResolvedValue([
      item("text/uri-list", `${urls[0]}\r\n${urls[1]}\r\n`),
      item("text/uri-list", urls[2]!),
    ]);

    await expect(clipboardPaths()).resolves.toEqual(paths);
  });

  it("does not treat plain text file URLs or images as copied files", async () => {
    const text = item("text/plain", "file:///tmp/clip.mp4");
    const image = item("image/png", "image bytes");
    read.mockResolvedValue([text, image]);

    await expect(clipboardPaths()).resolves.toEqual([]);
    expect(text.getType).not.toHaveBeenCalled();
    expect(image.getType).not.toHaveBeenCalled();
  });

  it("skips comments, remote URLs and malformed paths without losing valid files", async () => {
    const path = join(tmpdir(), "valid.mp4");
    read.mockResolvedValue([item("text/uri-list", [
      "# Files copied from the file manager",
      "https://example.com/clip.mp4",
      "file:///bad%ZZ.mp4",
      "file:///nul%00.mp4",
      pathToFileURL(path).href,
      "",
    ].join("\n"))]);

    await expect(clipboardPaths()).resolves.toEqual([path]);
  });

  it("returns no paths when the clipboard is empty", async () => {
    read.mockResolvedValue([]);
    await expect(clipboardPaths()).resolves.toEqual([]);
  });

  it("passes a native clipboard failure back to the IPC caller", async () => {
    read.mockRejectedValue(new Error("Clipboard unavailable"));
    await expect(clipboardPaths()).rejects.toThrow("Clipboard unavailable");
  });
});
