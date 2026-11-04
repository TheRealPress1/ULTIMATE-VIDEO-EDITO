/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import { checkToolOutputs, pinProject, WRITABLE_PLACES } from "./output-policy";
import { present, toCallToolResult } from "./present";

import type { WritePolicy } from "./output-policy";

const root = mkdtempSync(join(tmpdir(), "dapi-present-analysis-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const jpeg = (byte: number, size = 16) => new Uint8Array(size).fill(byte);

describe("analyze presentation", () => {
  it("writes the contact sheets to a fresh temp folder, names them, and inlines them", async () => {
    const sheets = [0, 1].map((index) => ({ index, timecode: `${index * 10}s-${index * 10 + 9}s`, start: index * 10, end: index * 10 + 9, cells: 12, bytes: jpeg(index + 1), mimeType: "image/jpeg" }));
    const presented = await present("analyze", { path: "/m/talk.mp4" }, { state: "done", method: "local-evidence", sheets, limitations: ["sampled"] });
    const output = presented.output as { sheets: Array<{ index: number; path: string; cells: number }>; limitations: string[] };
    expect(output.limitations).toEqual(["sampled"]);
    expect(output.sheets.map((sheet) => sheet.index)).toEqual([0, 1]);
    expect(output.sheets[0]).not.toHaveProperty("bytes");
    expect(output.sheets[1]!.path).toMatch(/dapi-analyze-.*[\\/]1\.jpg$/);
    expect(readFileSync(output.sheets[1]!.path)).toEqual(Buffer.from(jpeg(2)));
    expect(toolByName("analyze").output.safeParse(output).success).toBe(true);
    const result = toCallToolResult(presented);
    expect(result.content.filter((part) => part.type === "image").map((part) => (part as { mimeType: string }).mimeType)).toEqual(["image/jpeg", "image/jpeg"]);
    rmSync(dirname(output.sheets[0]!.path), { recursive: true, force: true });
  });

  it("passes a running job through untouched", async () => {
    const running = { state: "running", jobId: "analyze-1", method: "local-evidence", progress: { phase: "speech", fraction: 0.03 } };
    expect((await present("analyze", { action: "status", jobId: "analyze-1" }, running)).output).toEqual(running);
  });
});

describe("segment presentation", () => {
  it("writes a preview's picture once and answers flat", async () => {
    const result = {
      job: { id: `local-${Date.now()}`, status: "succeeded", request: { size: "tiny" }, assets: [], details: { frameRate: 30, start: 1, end: 1.033, frames: 1, bbox: [0.1, 0.1, 0.5, 0.9], score: 2, iou: 0.9, area: 0.2 } },
      saveTo: null,
      image: jpeg(7),
    };
    const presented = await present("segment", { path: "/m/a.mp4", time: 1, box: [0.1, 0.1, 0.5, 0.9], preview: true }, result);
    const output = presented.output as Record<string, unknown>;
    expect(output).toMatchObject({ state: "previewed", jobId: result.job.id, model: "sam-2.1-tiny", frames: 1, bbox: [0.1, 0.1, 0.5, 0.9] });
    expect(readFileSync(output.image as string)).toEqual(Buffer.from(jpeg(7)));
    expect(presented.images).toHaveLength(1);
    expect(toolByName("segment").output.safeParse(output).success).toBe(true);
    rmSync(output.image as string, { force: true });
  });

  it("saves a finished mask bound for disk where the call said", async () => {
    const target = join(root, "out", "skater.mask");
    const result = {
      job: { id: `local-disk-${Date.now()}`, status: "succeeded", request: { size: "small" }, assets: [{ filename: "Tracking 1.mask", bytes: jpeg(9) }], details: { frameRate: 30, start: 2, end: 9, frames: 210, lost: [], weak: [] } },
      saveTo: target,
    };
    const presented = await present("segment", { path: "/m/a.mp4", time: 3, box: [0.1, 0.1, 0.5, 0.9], output: target }, result);
    expect(presented.output).toMatchObject({ state: "done", path: target, model: "sam-2.1-small", lost: [], weak: [] });
    expect(readFileSync(target)).toEqual(Buffer.from(jpeg(9)));
  });

  it("judges a relative mask output as a library path, as generate's", async () => {
    const home = join(root, "home"), project = join(home, "Documents", "Show"), elsewhere = join(root, "elsewhere");
    for (const dir of [join(project, "assets"), elsewhere, join(home, "Movies")]) mkdirSync(dir, { recursive: true });
    const policy: WritePolicy = { project, pinned: pinProject(project), home, temp: [join(root, "tmp")], base: elsewhere };
    await expect(checkToolOutputs("segment", { path: "footage/a.mp4", output: "masks/a.mask" }, policy)).resolves.toBeUndefined();
    await expect(checkToolOutputs("segment", { path: "footage/a.mp4", output: join(elsewhere, "a.mask") }, policy)).rejects.toThrow(WRITABLE_PLACES);
  });
});
