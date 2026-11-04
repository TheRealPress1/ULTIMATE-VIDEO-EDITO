/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { samRequest } from "../local/sam";
import { flattenSegmentJob, segment, segmentRequest } from "./segment";

const base = { path: "footage/skater.mp4", time: 2.4, box: [0.4, 0.2, 0.65, 0.95] };

describe("segment", () => {
  it("builds the request generate would send for sam-2.1", () => {
    const parsed = segment.input.parse({ ...base, start: 2, end: 9, wait: true, timeoutSeconds: 30, output: "masks/skater.mask" });
    const request = segmentRequest(parsed);
    expect(request).toEqual({ model: "sam-2.1", video: { path: "footage/skater.mp4" }, time: 2.4, box: [0.4, 0.2, 0.65, 0.95], start: 2, end: 9, output: "masks/skater.mask" });
    expect(samRequest.safeParse(request).success).toBe(true);
  });

  it("refuses what the model refuses, naming the tool's own fields", () => {
    const issues = (value: unknown) => {
      const result = segment.input.safeParse(value);
      return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    };
    expect(issues({ path: base.path, time: 1 })).toEqual([expect.objectContaining({ path: "points", message: expect.stringMatching(/points .* or a box/) })]);
    expect(issues({ ...base, box: [0.6, 0.2, 0.4, 0.9] })).toEqual([expect.objectContaining({ path: "box" })]);
    expect(issues({ ...base, preview: true, start: 1 })).toEqual([expect.objectContaining({ path: "start", message: expect.stringMatching(/preview/) })]);
    expect(issues({ ...base, preview: true, output: "masks/a.mask" })).toEqual([expect.objectContaining({ path: "output" })]);
    expect(issues({ ...base, start: 3, end: 9 })).toEqual([expect.objectContaining({ path: "time" })]);
    expect(issues({ ...base, preview: true, wait: true })).toEqual([expect.objectContaining({ path: "wait" })]);
    expect(issues({ ...base, size: "huge" }).length).toBeGreaterThan(0);
    expect(issues({ ...base, timeoutSeconds: 3601 }).length).toBeGreaterThan(0);
  });

  it("flattens a previewed, a tracking and a finished job", () => {
    const preview = flattenSegmentJob(
      { id: "local-1", status: "succeeded", assets: [], request: { size: "small" }, details: { frameRate: 30, start: 2.4, end: 2.433, frames: 1, image: "/tmp/dapi-local-1.png", bbox: [0.41, 0.2, 0.64, 0.94], area: 0.12, score: 4.2, iou: 0.91 } },
      true,
    );
    expect(preview).toEqual({ state: "previewed", jobId: "local-1", model: "sam-2.1-small", image: "/tmp/dapi-local-1.png", frameRate: 30, start: 2.4, end: 2.433, frames: 1, bbox: [0.41, 0.2, 0.64, 0.94], area: 0.12, score: 4.2, iou: 0.91 });

    const tracking = flattenSegmentJob({ id: "local-2", status: "running", phase: "tracking", progress: 0.25, etaRemainingSeconds: 12, assets: [], request: { size: "tiny" }, details: { frameRate: 30, start: 2, end: 9, frames: 210 } }, false);
    expect(tracking).toMatchObject({ state: "tracking", jobId: "local-2", model: "sam-2.1-tiny", phase: "tracking", progress: 0.25, etaRemainingSeconds: 12, frames: 210 });

    const done = flattenSegmentJob(
      { id: "local-2", status: "succeeded", assets: [{ filename: "Tracking 1.mask", path: "/p/assets/masks/skater/Tracking 1.mask", src: "masks/skater/Tracking 1.mask" }], request: { size: "tiny" }, details: { frameRate: 30, start: 2, end: 9, frames: 210, lost: [[4, 4.5]], weak: [] } },
      false,
    );
    expect(done).toMatchObject({ state: "done", path: "/p/assets/masks/skater/Tracking 1.mask", src: "masks/skater/Tracking 1.mask", lost: [[4, 4.5]], weak: [] });
    expect(done).not.toHaveProperty("phase");
    expect(segment.output.safeParse(done).success).toBe(true);

    const failed = flattenSegmentJob({ id: "local-3", status: "failed", assets: [], error: { code: "INTERNAL", message: "No WebGPU" }, request: {} }, false);
    expect(failed).toEqual({ state: "failed", jobId: "local-3", model: "sam-2.1-tiny", error: "No WebGPU" });
  });
});
