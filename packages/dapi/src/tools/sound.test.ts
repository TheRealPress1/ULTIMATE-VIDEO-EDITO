/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { SOUND_ACTIONS, SOUND_ANALYZE_FIELDS, soundAnalyze, soundEffects } from "./sound";
import { toolJsonSchemas } from "../json-schema";

const analyze = (input: Record<string, unknown>) => soundAnalyze.input.safeParse(input);
const effects = (input: Record<string, unknown>) => soundEffects.input.safeParse(input);
const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) => result.error?.issues.map((issue) => issue.message) ?? [];

describe("sound_analyze", () => {
  it("knows every action's fields", () => {
    expect(Object.keys(SOUND_ANALYZE_FIELDS)).toEqual([...SOUND_ACTIONS]);
    const declared = new Set(Object.keys(soundAnalyze.input.shape));
    for (const { required, optional } of Object.values(SOUND_ANALYZE_FIELDS)) for (const field of [...required, ...optional]) expect(declared.has(field), field).toBe(true);
  });

  it("needs each action's fields and refuses the ones it doesn't take", () => {
    expect(analyze({ action: "describe", path: "music/theme.m4a" }).success).toBe(true);
    expect(analyze({ action: "match", path: "a.wav", query: "an instrumental without vocals", alts: ["a song with singing"] }).success).toBe(true);
    expect(analyze({ action: "rank", paths: ["sfx", "more/*.wav"], query: "a fast whoosh", top: 3 }).success).toBe(true);
    expect(analyze({ action: "ab", a: "a.wav", b: "b.wav", a_start: 0.2, a_end: 1 }).success).toBe(true);
    expect(analyze({ action: "timeline", path: "mix.wav", cues: [1.2, 3.4], detail: "low" }).success).toBe(true);
    expect(messages(analyze({ action: "match", path: "a.wav" }))).toEqual(["match needs `query`."]);
    expect(messages(analyze({ action: "ab", a: "a.wav" }))).toEqual(["ab needs `b`."]);
    expect(messages(analyze({ action: "describe", path: "a.wav", alts: ["x"] }))).toEqual(["`alts` doesn't apply to describe."]);
    expect(messages(analyze({ action: "measure", path: "a.wav", video: "film.mp4" }))).toEqual(["`video` doesn't apply to measure."]);
  });

  it("keeps earshot's limits", () => {
    expect(messages(analyze({ action: "describe", path: "a.wav", top: 31 }))).toEqual(["describe takes top 1-30."]);
    expect(analyze({ action: "rank", paths: "sfx", query: "x", top: 200 }).success).toBe(true);
    expect(messages(analyze({ action: "find", path: "a.wav", query: "x", top: 51 }))).toEqual(["find takes top 1-50."]);
    expect(analyze({ action: "match", path: "a.wav", query: "x", alts: ["1", "2", "3", "4", "5", "6"] }).success).toBe(false);
    expect(messages(analyze({ action: "describe", path: "a.wav", start: 4, end: 2 }))).toEqual(["end must be after start."]);
    expect(analyze({ action: "compare", path: "a.wav", refs: "refs", k: 0 }).success).toBe(false);
  });

  it("says what it hears and what it doesn't", () => {
    expect(soundAnalyze.description).toContain("what sounds, music and sound effects sound like — not the words spoken (use transcribe/listen for speech)");
    expect(soundAnalyze.description).toContain("is this an instrumental?");
    expect(soundAnalyze.description).toContain("export a draft to a temporary path");
    expect(soundAnalyze.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(soundAnalyze.environment).toBe("main");
  });

  it("publishes as an object schema", () => {
    const { inputSchema, outputSchema } = toolJsonSchemas(soundAnalyze);
    expect(inputSchema.type).toBe("object");
    expect(outputSchema.type).toBe("object");
    expect(Object.keys(outputSchema.properties as object)).not.toContain("image");
  });
});

describe("sound_effects", () => {
  it("lists by default and renders a bank id with its knobs", () => {
    expect(effects({}).data).toEqual({ action: "list" });
    expect(effects({ action: "list", kind: "whoosh" }).success).toBe(true);
    expect(effects({ action: "render", id: "whoosh_fast/crisp", dur: 0.8, apex: 0.32, seed: 7, name: "intro whoosh" }).success).toBe(true);
    expect(effects({ action: "render", id: "pluck/kalimba", pitch: "E5" }).success).toBe(true);
    expect(effects({ action: "render", id: "pluck/kalimba", pitch: "440" }).success).toBe(true);
    expect(effects({ action: "render", id: "fit/hit/door" }).success).toBe(true);
    expect(effects({ action: "check", path: "sfx/hit.wav", role: "hit" }).success).toBe(true);
  });

  it("refuses what doesn't fit the action", () => {
    expect(messages(effects({ action: "render" }))).toEqual(["render needs `id`."]);
    expect(messages(effects({ action: "check" }))).toEqual(["check needs `path`."]);
    expect(messages(effects({ action: "list", id: "whoosh_fast/crisp" }))).toEqual(["`id` doesn't apply to list."]);
    expect(effects({ action: "render", id: "../../etc/passwd" }).success).toBe(false);
    expect(effects({ action: "render", id: "whoosh_fast/crisp", pitch: "loud" }).success).toBe(false);
    expect(effects({ action: "render", id: "whoosh_fast/crisp", dur: 0 }).success).toBe(false);
  });

  it("says how to place a take", () => {
    expect(soundEffects.description).toContain("start = cue − onsetSeconds");
    expect(soundEffects.environment).toBe("renderer");
    expect(soundEffects.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
