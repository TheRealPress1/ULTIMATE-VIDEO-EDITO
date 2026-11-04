/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flattenSegmentJob, toolByName } from "@diffusionstudio/dapi";

const mocks = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn() }));
vi.mock("../local/jobs", () => ({ startLocalJob: mocks.start, localJob: mocks.poll }));

import { segment } from "./segment";

import type { ToolArgs, ToolInput } from "@diffusionstudio/dapi";
import type { ToolContext } from "../handler";

const session = { world: {}, project: { dir: () => "/p" } };
const ctx = (signal = new AbortController().signal, open = true) => ({ signal, session: () => (open ? session : null) }) as unknown as ToolContext;
const args = (input: ToolInput<"segment">) => toolByName("segment").input.parse(input) as ToolArgs<"segment">;
const job = (status: string, extra: Record<string, unknown> = {}) => ({
  job: { id: "local-1", model: "sam-2.1", status, phase: status === "running" ? "tracking" : null, progress: status === "running" ? 0.5 : null, request: { size: "tiny" }, assets: [], details: { frameRate: 30, start: 2, end: 9, frames: 210 }, error: null, ...extra },
  saveTo: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("segment", () => {
  it("sends generate's sam-2.1 request and answers a preview at once", async () => {
    mocks.start.mockResolvedValue(job("succeeded", { details: { frameRate: 30, start: 2.4, end: 2.433, frames: 1, bbox: [0.4, 0.2, 0.6, 0.9], score: 3, iou: 0.9, area: 0.1 } }));
    const result = await segment(args({ path: "footage/skater.mp4", time: 2.4, box: [0.4, 0.2, 0.65, 0.95], preview: true }), ctx());
    expect(mocks.start).toHaveBeenCalledWith(
      { model: "sam-2.1", video: { path: "footage/skater.mp4" }, time: 2.4, box: [0.4, 0.2, 0.65, 0.95], preview: true },
      { kind: "library", path: null },
      expect.anything(),
    );
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(flattenSegmentJob(result.job, true)).toMatchObject({ state: "previewed", model: "sam-2.1-tiny", bbox: [0.4, 0.2, 0.6, 0.9] });
  });

  it("answers a library track at once, with its job id", async () => {
    mocks.start.mockResolvedValue(job("queued"));
    const result = await segment(args({ path: "footage/skater.mp4", time: 2.4, box: [0.4, 0.2, 0.65, 0.95], start: 2, end: 9 }), ctx());
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(flattenSegmentJob(result.job, false)).toMatchObject({ state: "tracking", jobId: "local-1" });
  });

  it("waits for the track when asked, until it is done", async () => {
    mocks.start.mockResolvedValue(job("running"));
    mocks.poll.mockReturnValueOnce(job("running")).mockReturnValueOnce(job("succeeded", { assets: [{ filename: "Tracking 1.mask", path: "/p/assets/masks/Tracking 1.mask", src: "masks/Tracking 1.mask" }] }));
    const result = await segment(args({ path: "footage/skater.mp4", time: 2.4, box: [0.4, 0.2, 0.65, 0.95], wait: true }), ctx());
    expect(mocks.poll).toHaveBeenCalledTimes(2);
    expect(mocks.poll).toHaveBeenCalledWith("local-1", false);
    expect(flattenSegmentJob(result.job, false)).toMatchObject({ state: "done", src: "masks/Tracking 1.mask" });
  });

  it("waits by default for an absolute output, and answers tracking when the wait runs out", async () => {
    vi.useFakeTimers();
    mocks.start.mockResolvedValue(job("running"));
    mocks.poll.mockReturnValue(job("running"));
    const pending = segment(args({ path: "/Movies/skater.mp4", time: 2.4, box: [0.4, 0.2, 0.65, 0.95], output: "/Users/me/Movies/skater.mask", timeoutSeconds: 2 }), ctx(undefined, false));
    await vi.advanceTimersByTimeAsync(2500);
    const result = await pending;
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ output: "/Users/me/Movies/skater.mask" }), { kind: "disk", path: "/Users/me/Movies/skater.mask" }, expect.anything());
    expect(mocks.poll.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(flattenSegmentJob(result.job, false)).toMatchObject({ state: "tracking", jobId: "local-1", progress: 0.5 });
  });

  it("leaves the job running when the waiting caller goes away", async () => {
    const controller = new AbortController();
    mocks.start.mockResolvedValue(job("running"));
    mocks.poll.mockImplementation(() => { controller.abort(); return job("running"); });
    const result = await segment(args({ path: "footage/skater.mp4", time: 2.4, box: [0.4, 0.2, 0.65, 0.95], wait: true }), ctx(controller.signal));
    expect(result.job.status).toBe("running");
    expect(mocks.poll).toHaveBeenCalledTimes(1);
  });
});
