/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  assembleSections,
  chooseFrames,
  excerpt,
  placeFrames,
  promptHits,
  promptKeywords,
  readAudioEvents,
  sectionBounds,
  sheetSizes,
  suggestChecks,
} from "./analyze-pack";

describe("prompt keywords", () => {
  it("keeps content words only, at most eight", () => {
    expect(promptKeywords("Where does the host laugh about the red bicycles?")).toEqual(["host", "laugh", "red", "bicycle"]);
    expect(promptKeywords(undefined)).toEqual([]);
    expect(promptKeywords("one two three four five six seven eight nine ten eleven")).toHaveLength(8);
  });

  it("finds spoken and seen words and merges nearby hits into one moment", () => {
    const words = [{ text: " the", start: 10, end: 10.2 }, { text: " Bicycle", start: 10.3, end: 10.8 }, { text: " bicycles!", start: 11, end: 11.5 }, { text: " host", start: 50, end: 50.4 }];
    const samples = [{ time: 70, labels: [{ text: "bicycle", confidence: 0.8 }], text: [], people: 0 }];
    const hits = promptHits(["bicycle", "host"], words, samples);
    expect(hits.map((hit) => [hit.time, hit.terms])).toEqual([[10.3, ["bicycle"]], [50, ["host"]], [70, ["bicycle"]]]);
    expect(hits[0]!.score).toBe(2);
  });
});

describe("sections", () => {
  it("cuts at visual changes and keeps every section within the window", () => {
    const bounds = sectionBounds(100, 160, [100.2, 112, 113, 131, 159.5], 24);
    expect(bounds[0]![0]).toBe(100);
    expect(bounds.at(-1)![1]).toBe(160);
    expect(bounds.map(([start]) => start)).toEqual([100, 112, 113, 131]);
  });

  it("uses 30 s blocks where nothing changes, and longer ones to stay under the limit", () => {
    expect(sectionBounds(0, 600, [], 24)).toHaveLength(20);
    const long = sectionBounds(0, 7200, [], 24);
    expect(long).toHaveLength(24);
    expect(long[0]).toEqual([0, 300]);
  });

  it("merges the shortest sections until the count fits", () => {
    const cuts = Array.from({ length: 40 }, (_, i) => 1.5 * (i + 1));
    const bounds = sectionBounds(0, 62, cuts, 12);
    expect(bounds).toHaveLength(12);
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]![0]).toBe(bounds[i - 1]![1]);
  });
});

describe("frames", () => {
  const bounds = sectionBounds(0, 600, [], 24);

  it("never exceeds the budget, covers every section first and stays in the window", () => {
    for (const budget of [12, 24, 48]) {
      const frames = chooseFrames({ from: 0, to: 600, budget, scenes: [], prompt: [], bounds });
      expect(frames.length).toBeLessThanOrEqual(budget);
      expect(frames.every((frame) => frame.time >= 0 && frame.time < 600)).toBe(true);
      expect(frames.map((frame) => frame.time)).toEqual([...frames.map((frame) => frame.time)].sort((a, b) => a - b));
    }
    const covered = chooseFrames({ from: 0, to: 600, budget: 24, scenes: [], prompt: [], bounds });
    for (const [start, end] of bounds) expect(covered.some((frame) => frame.time >= start && frame.time < end)).toBe(true);
  });

  it("puts the prompt's moments and scene changes first", () => {
    const frames = chooseFrames({ from: 0, to: 600, budget: 12, scenes: [45, 46, 300], prompt: [{ time: 222, score: 3, terms: ["dog"] }], bounds });
    expect(frames).toContainEqual({ time: 222, reason: "prompt" });
    expect(frames.some((frame) => frame.reason === "scene-change")).toBe(true);
  });

  it("samples a short clip more thinly than its budget", () => {
    expect(chooseFrames({ from: 0, to: 3, budget: 48, scenes: [], prompt: [], bounds: [[0, 3]] }).length).toBeLessThanOrEqual(6);
  });

  it("lays frames out on balanced sheets of at most twelve", () => {
    expect(sheetSizes(13)).toEqual([7, 6]);
    expect(sheetSizes(48)).toEqual([12, 12, 12, 12]);
    const placed = placeFrames(Array.from({ length: 13 }, (_, i) => ({ time: i, reason: "coverage" as const })));
    expect(placed[6]).toMatchObject({ sheet: 0, cell: 6 });
    expect(placed[7]).toMatchObject({ sheet: 1, cell: 0 });
  });
});

describe("section contents", () => {
  it("says what was said, seen and heard, and whether it is silent", () => {
    const words = [{ text: " Hello", start: 1, end: 1.4 }, { text: " there.", start: 1.5, end: 2 }, { text: " Later", start: 40, end: 40.5 }];
    const samples = [{ time: 5, labels: [{ text: "dog", confidence: 0.9 }, { text: "grass", confidence: 0.2 }], text: [{ text: "SALE", confidence: 0.8 }], people: 2 }];
    const frames = placeFrames([{ time: 15, reason: "coverage" }, { time: 45, reason: "coverage" }]);
    const sections = assembleSections({
      bounds: [[0, 30], [30, 60]],
      words,
      silences: [{ start: 30, end: 58 }],
      samples,
      events: [{ start: 3, labels: ["Bark"] }],
      frames,
      keywords: ["dog"],
    });
    expect(sections[0]).toMatchObject({ start: 0, end: 30, speech: "Hello there.", words: 2, visual: { labels: ["dog"], text: ["SALE"], people: 2 }, silent: false, audio: ["Bark"], keyframe: { time: 15, sheet: 0, cell: 0 }, match: { terms: ["dog"] } });
    expect(sections[1]).toMatchObject({ speech: "Later", silent: true, audio: [] });
    expect(sections[1]).not.toHaveProperty("match");
  });

  it("marks silence as unmeasured when the audio was not read", () => {
    const [section] = assembleSections({ bounds: [[0, 10]], words: null, silences: null, samples: null, events: null, frames: [], keywords: [] });
    expect(section).toEqual({ index: 0, start: 0, end: 10, words: 0, silent: null });
  });

  it("cuts a long excerpt at a word", () => {
    const words = Array.from({ length: 200 }, (_, i) => ({ text: ` word${i}`, start: i, end: i + 0.5 }));
    const text = excerpt(words);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith("…")).toBe(true);
    expect(words.map((word) => word.text.trim())).toContain(text.slice(0, -1).split(" ").at(-1));
  });
});

describe("audio events", () => {
  it("reads earshot's timeline tolerantly and in source seconds", () => {
    const result = { events: [{ t: 2, dur: 1.5, tags: ["Applause", ["Cheering", 0.4]], db: -18.24 }, { time: 9, label: "Door" }, { nope: true }] };
    expect(readAudioEvents(result, 0, 60)).toEqual([{ start: 2, end: 3.5, labels: ["Applause", "Cheering"], level: -18.2 }, { start: 9, labels: ["Door"] }]);
  });

  it("shifts window-relative times by the window's start", () => {
    expect(readAudioEvents({ events: [{ t: 1, tags: ["Laugh"] }] }, 100, 130)).toEqual([{ start: 101, labels: ["Laugh"] }]);
  });
});

describe("suggested checks", () => {
  it("points grab and listen at the prompt's best sections, and visual_index at an unindexed library file", () => {
    const sections = assembleSections({
      bounds: [[0, 30], [30, 60]],
      words: [{ text: "dog", start: 35, end: 35.4 }],
      silences: [],
      samples: null,
      events: null,
      frames: [],
      keywords: ["dog"],
    });
    const checks = suggestChecks({ path: "footage/a.mp4", from: 0, to: 60, video: true, sections, frames: [], speech: "transcribed", visual: "frames-only", library: true, events: "installing" });
    expect(checks.map((check) => check.tool)).toEqual(["grab", "listen", "visual_index", "analyze"]);
    expect(checks[0]!.args).toEqual({ path: "footage/a.mp4", start: 30, end: 60, count: 6 });
  });
});
