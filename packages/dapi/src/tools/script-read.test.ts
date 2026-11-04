/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolByName } from "../catalog";
import { SCRIPT_READ_FILE, scriptReadCompare } from "./script";

describe("script_read_compare schema", () => {
  it("is a renderer tool in the catalog", () => {
    expect(toolByName("script_read_compare")).toBe(scriptReadCompare);
    expect(scriptReadCompare.environment).toBe("renderer");
    expect(scriptReadCompare.description).toContain(SCRIPT_READ_FILE);
    expect(() => z.toJSONSchema(scriptReadCompare.input, { io: "input" })).not.toThrow();
  });

  it("applies defaults and parses times", () => {
    const parsed = scriptReadCompare.input.parse({ path: "footage/read.mov", start: "1:30", end: 300 });
    expect(parsed).toEqual({ path: "footage/read.mov", start: 90, end: 300, pauseSeconds: 0.6, minCoverage: 0.5, detail: "full" });
  });

  it("refuses a script path and text together, an empty window and out-of-range knobs", () => {
    expect(scriptReadCompare.input.safeParse({ path: "a.mov", script: { path: "brief.md", text: "1. Hi." } }).success).toBe(false);
    expect(scriptReadCompare.input.safeParse({ path: "a.mov", script: { text: "1. Hi." } }).success).toBe(true);
    expect(scriptReadCompare.input.safeParse({ path: "a.mov", start: 10, end: 5 }).success).toBe(false);
    expect(scriptReadCompare.input.safeParse({ path: "a.mov", pauseSeconds: 0.1 }).success).toBe(false);
    expect(scriptReadCompare.input.safeParse({ path: "a.mov", minCoverage: 1.5 }).success).toBe(false);
    expect(scriptReadCompare.input.safeParse({ path: "a.mov", detail: "summary" }).success).toBe(false);
  });
});
