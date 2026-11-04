/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ release: () => {} }));
vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: vi.fn() }));
vi.mock("../lib/outputs", () => ({ storeAt: vi.fn() }));
vi.mock("./models", () => ({
  localModels: {
    "sam-2.1": {
      async prepare() {
        return {
          etaSeconds: 5,
          details: { frameRate: 30, start: 0, end: 2, frames: 60 },
          run: (job: { start(): void; report(phase: string, progress: number, eta: number): void }) =>
            new Promise((resolve) => {
              job.start();
              job.report("tracking", 0.5, 2);
              gate.release = () => resolve({ files: [], details: {} });
            }),
        };
      },
    },
  },
}));

import { localJob, localJobRows, startLocalJob } from "./jobs";
import type { ToolContext } from "../handler";

describe("local job rows", () => {
  it("lists a tracking job for context, then as done", async () => {
    const ctx = { signal: new AbortController().signal, session: () => null } as unknown as ToolContext;
    const started = await startLocalJob({ model: "sam-2.1", video: { path: "/m/skater.mp4" }, time: 1, box: [0.1, 0.1, 0.5, 0.5], size: "small" } as never, { kind: "disk", path: null }, ctx);
    const id = (started as { job: { id: string } }).job.id;
    await vi.waitFor(() => expect(localJobRows()[0]).toMatchObject({ id, kind: "segment", model: "sam-2.1-small", state: "running", phase: "tracking", progress: 0.5, path: "/m/skater.mp4" }));
    gate.release();
    await vi.waitFor(() => expect(localJob(id, false).job.status).toBe("succeeded"));
    expect(localJobRows()[0]).toMatchObject({ id, state: "done", progress: 1 });
    expect(localJobRows()[0]).not.toHaveProperty("phase");
    expect(localJobRows(Date.now() + 11 * 60_000)).toEqual([]);
  });
});
