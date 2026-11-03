/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ finish: vi.fn(), measure: vi.fn(), resolveNode: vi.fn(), requireScene: vi.fn(), library: { id: "library" } }));
vi.mock("@diffusionstudio/runtime", () => ({ getAssetFile: vi.fn(), getLibrary: () => mocks.library, Source: "source" }));
vi.mock("@/projects/edits", () => ({ flushProjectEdits: vi.fn() }));
vi.mock("@/lib/local-audio-finishing", () => ({ runLocalAudioFinishing: vi.fn() }));
vi.mock("@/engine/audio-pcm", () => ({ decodeFinishingAudio: vi.fn() }));
vi.mock("@/engine/audio-finishing", () => ({ finishSceneAudio: mocks.finish, measureSceneAudio: mocks.measure }));
vi.mock("../lib/audio-finish", () => ({ encodePcmWav: vi.fn() }));
vi.mock("../lib/assets", () => ({ requireAssetType: vi.fn(), resolveAsset: vi.fn() }));
vi.mock("../lib/scene", () => ({ requireScene: mocks.requireScene }));
vi.mock("../lib/nodes", () => ({ resolveNode: mocks.resolveNode }));

import { toolByName } from "@diffusionstudio/dapi";
import { advancedAudioFinish } from "./audio-finish-advanced";

import type { ToolContext } from "../handler";

const measured = { duration: 30, frames: 1, sampleRate: 48000, channels: 2, samplePeakDb: -8, rmsDb: -18, fullScaleSamples: 0, silenceSpans: [], integratedLufs: -16, truePeakDb: -2, loudnessRangeLu: 2, thresholdLufs: -26 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireScene.mockReturnValue({ id: "scene" });
  mocks.resolveNode.mockImplementation((_world: unknown, id: string) => ({ get: () => ({ value: `project.tsx:${id.split(":").pop()}` }) }));
  mocks.finish.mockResolvedValue({ sceneId: "project.tsx:finished", name: "Main · Audio finished", outputPath: "Finished-dialogue.wav", input: measured, dialogue: measured, mix: measured, musicKeyframeCount: 6, effectCount: 2, warnings: [] });
});

describe("audio_finish scene handler", () => {
  it("resolves effect ids to their clips and reports how many stayed separate", async () => {
    const session = { world: {}, project: { dir: () => "/project" } };
    const ctx = { session: () => session, requireSession: () => session, signal: new AbortController().signal } as unknown as ToolContext;
    const args = toolByName("audio_finish").input.parse({ sceneId: "main", action: "finish", musicIds: ["music"], effectIds: ["whoosh", "pop"] });
    const output = await advancedAudioFinish(args, ctx);
    expect(mocks.finish.mock.calls[0]![3]).toMatchObject({ musicIds: ["project.tsx:music"], effectIds: ["project.tsx:whoosh", "project.tsx:pop"] });
    expect(output).toMatchObject({ createdSceneId: "project.tsx:finished", musicKeyframeCount: 6, effectCount: 2, mixLoudness: measured });
    expect(() => toolByName("audio_finish").output.parse(output)).not.toThrow();
  });
});
