/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { check, CheckIssueCode } from "./check";
import { qualityReview } from "./quality-review";
import { waveform } from "./waveform";

describe("silence thresholds", () => {
  it("lets waveform set the silent level and minimum length within bounds", () => {
    expect(waveform.input.parse({ path: "/a.wav" }).silence).toBeUndefined();
    expect(waveform.input.parse({ path: "/a.wav", silence: { thresholdDb: -40, minSeconds: 0.12 } }).silence).toEqual({ thresholdDb: -40, minSeconds: 0.12 });
    for (const silence of [{ thresholdDb: -75 }, { thresholdDb: -10 }, { minSeconds: 0.01 }, { minSeconds: 6 }]) {
      expect(waveform.input.safeParse({ path: "/a.wav", silence }).success, JSON.stringify(silence)).toBe(false);
    }
    expect(waveform.output.safeParse({ path: "/tmp/w.png", silences: [], silenceThresholdDb: -53.1, silenceMinSeconds: 0.4 }).success).toBe(true);
  });

  it("keeps quality_review's audio switch and adds pause thresholds with the old defaults", () => {
    expect(qualityReview.input.parse({ id: "reel" }).audio).toBe(true);
    expect(qualityReview.input.parse({ id: "reel", audio: false }).audio).toBe(false);
    expect(qualityReview.input.parse({ id: "reel", audio: {} }).audio).toEqual({ pauseThresholdDb: -60, minPauseSeconds: 1 });
    expect(qualityReview.input.parse({ id: "reel", audio: { pauseThresholdDb: -45, minPauseSeconds: 0.25 } }).audio).toEqual({ pauseThresholdDb: -45, minPauseSeconds: 0.25 });
    expect(qualityReview.input.safeParse({ id: "reel", audio: { pauseThresholdDb: -10 } }).success).toBe(false);
    expect(qualityReview.input.safeParse({ id: "reel", audio: { minPauseSeconds: 0.05 } }).success).toBe(false);
  });
});

describe("check minimum visible stretch", () => {
  it("defaults to 0.4 s, allows 0 to turn it off and caps it at 2 s", () => {
    expect(check.input.parse({ id: "reel" })).toEqual({ id: "reel", minVisibleSeconds: 0.4 });
    expect(check.input.parse({ id: "reel", minVisibleSeconds: 0 }).minVisibleSeconds).toBe(0);
    expect(check.input.safeParse({ id: "reel", minVisibleSeconds: 2.5 }).success).toBe(false);
    expect(check.input.safeParse({ id: "reel", minVisibleSeconds: -1 }).success).toBe(false);
  });

  it("reports the new issue code and the pass's stats", () => {
    expect(CheckIssueCode.options).toContain("short-visible-stretch");
    const stats = { nodes: 4, byKind: { scene: 1, video: 3 }, depth: 1, duration: 10 };
    const visibility = { minVisibleSeconds: 0.4, stretches: 4, shortStretches: 1, evaluatedLayers: 3, skippedLayers: 1, skipped: [{ node: "index.tsx:broll", reason: "masked" }] };
    const issue = { code: "short-visible-stretch", severity: "warning", message: "On screen for only 0.2s", node: "index.tsx:head-2", ranges: [{ start: 5, end: 5.2 }] };
    expect(check.output.safeParse({ stats: { ...stats, visibility }, issues: [issue] }).success).toBe(true);
    expect(check.output.safeParse({ stats, issues: [] }).success).toBe(true);
  });
});
