/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), getLibrary: vi.fn(), import: vi.fn(), flush: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ mainBridge: { call: mocks.call } }));
vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: mocks.getLibrary }));

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { toolByName } from "@diffusionstudio/dapi";
import { soundEffects } from "./sound";

import type { SoundEffectsReply } from "@desktop/addons/earshot/types";
import type { ToolContext } from "../handler";
import type { EditorSession } from "../session";

const rendered: Extract<SoundEffectsReply, { action: "render" }> = {
  action: "render", version: "0.4.0", summary: "wrote …: whoosh_fast/crisp seed 420116625: 1.056 s; checks: clean",
  source: "assets/sfx/whoosh-fast-crisp-5c5e09fb.wav", path: "/projects/launch/assets/sfx/whoosh-fast-crisp-5c5e09fb.wav",
  sound: "whoosh_fast/crisp", seed: 420116625, durationSeconds: 1.0561, onsetSeconds: 0.0195, peakSeconds: 0.1305, endSeconds: 0.681, peakDb: -1,
  audit: { ok: true, summary: "whoosh_fast/crisp: clean", warnings: [], notes: [] }, reused: false, creditsFile: "/projects/launch/CREDITS.md",
};
const asset = { id: "a1b2c3d4e5f60718", type: "AUDIO", path: "sfx/whoosh-fast-crisp-5c5e09fb.wav", source: rendered.source, mimeType: "audio/wav", duration: 1.0561 };

let session: EditorSession;
let active: EditorSession | null;
const args = (input: Record<string, unknown>) => toolByName("sound_effects").input.parse(input);
const context = (signal = new AbortController().signal): ToolContext => ({
  signal,
  session: () => active,
  requireSession: () => {
    if (!active) throw Object.assign(new Error("No project open — open one first."), { code: "no-project" });
    return active;
  },
  app: { openProject: vi.fn() },
});
const calls = (channel: string) => mocks.call.mock.calls.filter(([name]) => name === channel).map(([, data]) => data);

beforeEach(() => {
  vi.resetAllMocks();
  session = { world: { id: "world" }, project: { dir: () => "/projects/launch" } } as unknown as EditorSession;
  active = session;
  mocks.getLibrary.mockReturnValue({ import: mocks.import, flush: mocks.flush, get: mocks.get });
  mocks.import.mockResolvedValue({ assets: [{ ...asset }], failed: [] });
  mocks.flush.mockResolvedValue(undefined);
  mocks.call.mockImplementation(async (channel: string, data: { action: string }) => {
    if (channel !== MAIN_CHANNELS.SOUND_EFFECTS_RUN) return undefined;
    if (data.action === "render") return rendered;
    if (data.action === "list") return { action: "list", version: "0.4.0", summary: "252 sounds", bank: "forge_v2r6", categories: [{ category: "whoosh_fast", count: 1, kinds: ["whoosh.short"], ids: ["whoosh_fast/crisp"] }] };
    return { action: "check", version: "0.4.0", summary: "hit.wav: clean", path: "/projects/launch/assets/sfx/hit.wav", audit: { ok: true, summary: "hit.wav: clean", warnings: [], notes: [] } };
  });
});

describe("sound_effects", () => {
  it("has main render the take into the open project and imports it under sfx/", async () => {
    const output = await soundEffects(args({ action: "render", id: "whoosh_fast/crisp", dur: 0.8, seed: 7 }), context());
    expect(calls(MAIN_CHANNELS.SOUND_EFFECTS_RUN)).toEqual([{ id: expect.any(String), action: "render", dir: "/projects/launch", sound: "whoosh_fast/crisp", dur: 0.8, seed: 7 }]);
    expect(mocks.import).toHaveBeenCalledWith([rendered.source], { folder: "sfx" });
    expect(mocks.flush).toHaveBeenCalled();
    expect(output).toEqual({
      action: "render", version: "0.4.0", summary: rendered.summary, src: asset.path, assetId: asset.id, path: rendered.path,
      sound: "whoosh_fast/crisp", seed: 420116625, durationSeconds: 1.0561, onsetSeconds: 0.0195, peakSeconds: 0.1305, endSeconds: 0.681, peakDb: -1,
      audit: rendered.audit, reused: false, creditsFile: rendered.creditsFile,
    });
    expect(toolByName("sound_effects").output.safeParse(output).success).toBe(true);
  });

  it("needs an open project to render, but not to list or check", async () => {
    active = null;
    await expect(soundEffects(args({ action: "render", id: "whoosh_fast/crisp" }), context())).rejects.toMatchObject({ code: "no-project" });
    const listed = await soundEffects(args({ action: "list" }), context());
    expect(listed).toMatchObject({ action: "list", categories: [{ category: "whoosh_fast" }] });
    expect(listed).not.toHaveProperty("sounds");
    await soundEffects(args({ action: "check", path: "/Users/me/Music/hit.wav" }), context());
    expect(calls(MAIN_CHANNELS.SOUND_EFFECTS_RUN).at(-1)).toEqual({ id: expect.any(String), action: "check", dir: null, path: "/Users/me/Music/hit.wav" });
  });

  it("turns main's `[code] message` back into the error it was", async () => {
    mocks.call.mockRejectedValueOnce(new Error("[busy] Audio intelligence is installing (step 3/5, 410 of 2,077 MB). Continue with other work and call this tool again in a few minutes."));
    await expect(soundEffects(args({ action: "list" }), context())).rejects.toMatchObject({ code: "busy", message: "Audio intelligence is installing (step 3/5, 410 of 2,077 MB). Continue with other work and call this tool again in a few minutes." });
    mocks.call.mockRejectedValueOnce(new Error("plain failure"));
    await expect(soundEffects(args({ action: "list" }), context())).rejects.toThrow("plain failure");
  });

  it("refuses to import into a project that changed while the take rendered", async () => {
    mocks.call.mockImplementationOnce(async () => {
      active = { world: { id: "other" }, project: { dir: () => "/projects/other" } } as unknown as EditorSession;
      return rendered;
    });
    await expect(soundEffects(args({ action: "render", id: "whoosh_fast/crisp" }), context())).rejects.toMatchObject({ code: "no-project" });
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it("cancels main's half with the call", async () => {
    const controller = new AbortController();
    mocks.call.mockImplementation(async (channel: string) => {
      if (channel === MAIN_CHANNELS.SOUND_EFFECTS_RUN) {
        controller.abort();
        throw new Error("[canceled] The sound effects call was canceled.");
      }
      return undefined;
    });
    await expect(soundEffects(args({ action: "list" }), context(controller.signal))).rejects.toMatchObject({ code: "canceled" });
    expect(calls(MAIN_CHANNELS.SOUND_EFFECTS_CANCEL)).toEqual([{ id: expect.any(String) }]);
  });
});
