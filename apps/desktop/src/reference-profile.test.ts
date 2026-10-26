import { describe, expect, it } from "vitest";
import {
  buildReferenceProfile,
  validateReferenceAnalysis,
  validateReferenceProfile,
} from "./reference-profile";
import type { ReferenceAnalysis } from "./reference-types";
function fixture(duration = 8, sourceStart = 0): ReferenceAnalysis {
  return {
    duration,
    sourceStart,
    analyzedDuration: Math.min(duration, 120),
    width: 1080,
    height: 1920,
    sampleInterval: 0.25,
    samples: Array.from(
      { length: Math.ceil(Math.min(duration, 120) / 0.25) },
      (_, i) => ({
        time: i * 0.25,
        mediaTime: sourceStart + i * 0.25,
        change: i === 8 || i === 16 || i === 24 ? 0.8 : 0,
        text:
          i % 4 === 0
            ? [
                {
                  text: `Here are spoken words ${i}`,
                  confidence: 0.95,
                  x: 0.2,
                  y: 0.76,
                  width: 0.6,
                  height: 0.04,
                },
              ]
            : [],
        palette: ["#202020", "#e0e0e0"],
      }),
    ),
  };
}
describe("reference measurements", () => {
  it("measures cadence and changing captions without claiming recovered typography", () => {
    const a = fixture(),
      p = buildReferenceProfile(a);
    expect(p.cuts.map((c) => c.time)).toEqual([2, 4, 6]);
    expect(p.pacing).toEqual({
      medianShotSeconds: 2,
      cutsPerMinute: 22.5,
      shotCount: 4,
    });
    expect(p.caption).toMatchObject({
      coverage: 1,
      observations: 8,
      distinctTexts: 8,
      y: 0.76,
      suggestedPreset: "whisper",
    });
    expect(p.caption!.fontSizeRatio).toBeCloseTo(0.046);
    expect(p.limitations.join()).toContain("Exact fonts");
    expect(
      p.sampleTimes.every((time) => a.samples.some((s) => s.time === time)),
    ).toBe(true);
    expect(validateReferenceProfile(p, 8, 0)).toEqual(p);
  });
  it("does not mistake persistent logos or upper-screen title text for captions", () => {
    const a = fixture();
    for (const s of a.samples)
      for (const t of s.text) t.text = "Static channel logo";
    expect(buildReferenceProfile(a).caption).toBeNull();
    for (const [i, s] of a.samples.entries())
      for (const t of s.text) {
        t.text = `Title number ${i}`;
        t.y = 0.1;
      }
    expect(buildReferenceProfile(a).caption).toBeNull();
  });
  it("distinguishes no observed cuts from a measured shot length", () => {
    const a = fixture();
    a.samples.forEach((s) => (s.change = 0));
    expect(buildReferenceProfile(a).pacing).toEqual({
      medianShotSeconds: null,
      cutsPerMinute: 0,
      shotCount: 1,
    });
  });
  it("caps long sources to 480 frames and makes truncated coverage explicit", () => {
    const p = buildReferenceProfile(fixture(3600));
    expect(p.analyzedDuration).toBe(120);
    expect(p.limitations.join()).toContain("Only the first 120s");
    expect(p.sampleTimes.length).toBeLessThanOrEqual(12);
  });
  it("preserves actual source-relative sample times for offset tracks", () => {
    const a = fixture(8, 0.033);
    a.samples[1]!.time = 0.266;
    a.samples[1]!.mediaTime = 0.299;
    expect(validateReferenceAnalysis(a, 8, 0.033).samples[1]!.time).toBe(0.266);
    expect(() => validateReferenceAnalysis(a, 8, 0)).toThrow("metadata");
    a.samples[1]!.mediaTime = 0.266;
    expect(() => validateReferenceAnalysis(a)).toThrow("evidence");
  });
  it.each(["samples", "bounds", "clock", "cadence", "caption", "palette"])(
    "rejects damaged %s evidence",
    (kind) => {
      const a = fixture();
      if (kind === "samples") a.samples.pop();
      if (kind === "bounds") a.samples[0]!.text[0]!.x = 0.9;
      if (kind === "clock") a.samples[1]!.time = 0;
      if (["samples", "bounds", "clock"].includes(kind)) {
        expect(() => validateReferenceAnalysis(a)).toThrow();
        return;
      }
      const p = buildReferenceProfile(a);
      if (kind === "cadence") p.pacing.shotCount = 800;
      if (kind === "caption") p.caption!.fontSizeRatio = 2;
      if (kind === "palette") p.palette = ["red"];
      expect(() => validateReferenceProfile(p)).toThrow();
    },
  );
});
