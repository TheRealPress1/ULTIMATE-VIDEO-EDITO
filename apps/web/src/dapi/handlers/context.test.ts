/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ local: vi.fn(), analyze: vi.fn() }));
vi.mock("@/projects", () => ({ saveFolder: () => "/Users/me/Movies/Cutroom" }));
vi.mock("@diffusionstudio/runtime", () => ({ Computed: {}, Fonts: {}, FrameRate: {}, getActiveEntity: () => null }));
vi.mock("../local/jobs", () => ({ localJobRows: mocks.local }));
vi.mock("./analyze", () => ({ analyzeJobRows: mocks.analyze }));

import { context } from "./context";
import type { ToolContext } from "../handler";

describe("context jobs", () => {
  it("lists background jobs, running ones first, with or without a project open", async () => {
    mocks.local.mockReturnValue([
      { id: "local-2", kind: "segment", model: "sam-2.1-tiny", state: "done", progress: 1, path: "footage/a.mp4", src: "masks/a/Tracking 1.mask" },
      { id: "local-1", kind: "segment", model: "sam-2.1-tiny", state: "running", phase: "tracking", progress: 0.4, path: "footage/a.mp4" },
    ]);
    mocks.analyze.mockReturnValue([{ id: "analyze-1", kind: "analyze", model: "local-evidence", state: "queued", phase: "queued", progress: null, path: "footage/b.mp4" }]);
    const closed = await context({}, { signal: new AbortController().signal, session: () => null } as unknown as ToolContext);
    expect(closed).toMatchObject({ rootDir: "/Users/me/Movies/Cutroom", projectDir: null, fontFamilies: [] });
    expect(closed.jobs!.map((job) => job.id)).toEqual(["local-1", "analyze-1", "local-2"]);

    const world = { get: () => undefined };
    const open = await context({}, { signal: new AbortController().signal, session: () => ({ world, project: { dir: () => "/p" } }) } as unknown as ToolContext);
    expect(open).toMatchObject({ projectDir: "/p", currentTime: null, fontFamilies: ["Inter"] });
    expect(open.jobs).toHaveLength(3);
  });
});
