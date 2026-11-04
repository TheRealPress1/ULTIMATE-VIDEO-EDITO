/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { ANALYZE_FRAME_BUDGET, analyze } from "./analyze";
import { context } from "./context";
import { transcribe } from "./transcribe";

describe("analyze", () => {
  it("starts by path and follows or stops a job by id", () => {
    expect(analyze.input.safeParse({ path: "/m/talk.mp4" }).success).toBe(true);
    expect(analyze.input.safeParse({ path: "/m/talk.mp4", prompt: "where the host laughs", depth: "thorough", focus: ["speech", "visual"], start: "1:00", end: 600 }).success).toBe(true);
    expect(analyze.input.safeParse({ action: "status", jobId: "analyze-1" }).success).toBe(true);
    expect(analyze.input.safeParse({ action: "cancel", jobId: "analyze-1" }).success).toBe(true);
  });

  it("refuses a start without a path, a job call without an id and an inverted window", () => {
    expect(analyze.input.safeParse({}).success).toBe(false);
    expect(analyze.input.safeParse({ action: "status" }).success).toBe(false);
    expect(analyze.input.safeParse({ path: "/m/a.mp4", jobId: "analyze-1" }).success).toBe(false);
    expect(analyze.input.safeParse({ path: "/m/a.mp4", start: 40, end: 20 }).success).toBe(false);
    expect(analyze.input.safeParse({ path: "/m/a.mp4", depth: "deep" }).success).toBe(false);
    expect(analyze.input.safeParse({ path: "/m/a.mp4", focus: [] }).success).toBe(false);
    expect(analyze.input.safeParse({ path: "/m/a.mp4", prompt: "x".repeat(2001) }).success).toBe(false);
  });

  it("budgets at most four sheets of twelve frames", () => {
    expect(ANALYZE_FRAME_BUDGET).toEqual({ quick: 12, standard: 24, thorough: 48 });
    expect(Math.max(...Object.values(ANALYZE_FRAME_BUDGET))).toBeLessThanOrEqual(4 * 12);
  });

  it("answers with sheet paths over MCP, and with their bytes from the renderer", () => {
    const sheet = { index: 0, timecode: "0f-10s", start: 0, end: 10, cells: 12 };
    expect(analyze.output.safeParse({ state: "done", method: "local-evidence", sheets: [{ ...sheet, path: "/tmp/0.jpg" }] }).success).toBe(true);
    expect(analyze.result!.safeParse({ state: "done", method: "local-evidence", sheets: [{ ...sheet, bytes: new Uint8Array(1), mimeType: "image/jpeg" }] }).success).toBe(true);
    expect(analyze.output.safeParse({ state: "running", jobId: "analyze-1", method: "local-evidence", progress: { phase: "speech", fraction: 0.03 } }).success).toBe(true);
  });
});

describe("transcribe parity", () => {
  it("takes a window, a language and a quality", () => {
    const parsed = transcribe.input.parse({ path: "/m/a.mp4", start: "0:30", end: 90, language: "FR", quality: "accurate" });
    expect(parsed).toMatchObject({ start: 30, end: 90, language: "fr", quality: "accurate" });
  });

  it("rejects an inverted window, an unknown quality and a language that is not a code", () => {
    expect(transcribe.input.safeParse({ path: "/m/a.mp4", start: 90, end: 30 }).success).toBe(false);
    expect(transcribe.input.safeParse({ path: "/m/a.mp4", quality: "best" }).success).toBe(false);
    expect(transcribe.input.safeParse({ path: "/m/a.mp4", language: "french" }).success).toBe(false);
  });

  it("says what the accurate model downloads, and that only a call asking for it does", () => {
    expect(transcribe.description).toMatch(/quality: "accurate"/);
    expect(transcribe.description).toMatch(/about 1\.6 GB/);
    expect(transcribe.description).toMatch(/only when a call asks for it/);
  });

  it("reports the window and model beside the counts", () => {
    expect(transcribe.output.safeParse({ path: "/tmp/t.json", segments: 1, words: 2, start: 30, end: 90, model: "whisper-base" }).success).toBe(true);
  });
});

describe("context jobs", () => {
  it("lists background jobs, and still reads without them", () => {
    const base = { rootDir: "/p", projectDir: null, currentTime: null, fontFamilies: [] };
    expect(context.output.safeParse(base).success).toBe(true);
    expect(context.output.safeParse({ ...base, jobs: [{ id: "local-1", kind: "segment", model: "sam-2.1-tiny", state: "running", phase: "tracking", progress: 0.4, path: "footage/a.mp4" }] }).success).toBe(true);
    expect(context.output.safeParse({ ...base, jobs: [{ id: "x", kind: "export", state: "running", progress: null }] }).success).toBe(false);
  });
});
