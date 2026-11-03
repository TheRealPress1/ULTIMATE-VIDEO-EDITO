/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { audioFinish } from "./audio-finish";

describe("audio_finish effectIds", () => {
  const scene = { sceneId: "index.tsx:main", action: "finish" as const };

  it("takes sound effect clips beside music on a scene finish", () => {
    expect(audioFinish.input.parse({ ...scene, musicIds: ["index.tsx:music"], effectIds: ["index.tsx:whoosh", "index.tsx:pop"] })).toMatchObject({ effectIds: ["index.tsx:whoosh", "index.tsx:pop"] });
    expect(audioFinish.output.parse({ action: "finish", source: "s", duration: 1, sampleRate: 48000, channels: 2, samplePeakDb: null, rmsDb: null, fullScaleSamples: 0, outputPath: null, appliedGainDb: null, outputSamplePeakDb: null, warnings: [], effectCount: 2 }).effectCount).toBe(2);
  });

  it("refuses effects outside a scene finish, a clip in both lists, and too many", () => {
    expect(audioFinish.input.safeParse({ path: "a.wav", action: "finish", effectIds: ["x"] }).success).toBe(false);
    expect(audioFinish.input.safeParse({ ...scene, action: "measure", effectIds: ["x"] }).success).toBe(false);
    const both = audioFinish.input.safeParse({ ...scene, musicIds: ["index.tsx:a"], effectIds: ["index.tsx:a"] });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toMatch(/not both/);
    expect(audioFinish.input.safeParse({ ...scene, effectIds: Array.from({ length: 65 }, (_, i) => `c${i}`) }).success).toBe(false);
    expect(audioFinish.input.safeParse({ ...scene, effectIds: [""] }).success).toBe(false);
  });
});
