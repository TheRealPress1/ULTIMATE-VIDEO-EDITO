/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import { present, toCallToolResult } from "../../dapi/present";
import { ANALYZE_TIMEOUTS, analyzeSound, earshotArgs } from "./analyze";

import type { EarshotReply, EarshotService } from "./index";

let project: string;
let replies: EarshotReply[];
let fake: EarshotService & { call: ReturnType<typeof vi.fn> };

const parse = (input: Record<string, unknown>) => toolByName("sound_analyze").input.parse(input);

beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "earshot-analyze-")));
  await mkdir(join(project, "assets", "sfx"), { recursive: true });
  await mkdir(join(project, "assets", "music"), { recursive: true });
  for (const name of ["sfx/a.wav", "sfx/b.wav", "music/song.m4a", "music/ref.wav"]) await writeFile(join(project, "assets", name), "audio");
  await writeFile(join(project, "cut.mp4"), "video");
  await writeFile(join(project, "cues.json"), "{}");
  replies = [];
  fake = {
    privateDirs: [],
    call: vi.fn(async () => replies.shift() ?? { summary: "ok", json: { ok: true } }),
    earshotVersion: async () => "0.4.0",
  } as unknown as EarshotService & { call: ReturnType<typeof vi.fn> };
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("earshotArgs", () => {
  it("passes on only what the action takes, under earshot's names, every path resolved", async () => {
    expect(await earshotArgs(fake, parse({ action: "describe", path: "music/song.m4a", top: 12 }), project)).toEqual({ path: join(project, "assets", "music", "song.m4a"), top: 12 });
    expect(await earshotArgs(fake, parse({ action: "match", path: "sfx/a.wav", query: "an instrumental without vocals", alts: ["a song with singing"], start: 1, end: 9 }), project)).toEqual({
      path: join(project, "assets", "sfx", "a.wav"), query: "an instrumental without vocals", alts: ["a song with singing"], start: 1, end: 9,
    });
    // Folders and globs go to earshot as the checked files in them.
    expect(await earshotArgs(fake, parse({ action: "rank", paths: ["sfx", "music/*.wav"], query: "a fast whoosh", top: 3 }), project)).toEqual({
      paths: [join(project, "assets", "sfx", "a.wav"), join(project, "assets", "sfx", "b.wav"), join(project, "assets", "music", "ref.wav")], query: "a fast whoosh", top: 3,
    });
    expect(await earshotArgs(fake, parse({ action: "ab", a: "sfx/a.wav", b: "sfx/b.wav", refs: "music/ref.wav", a_start: 0.5, b_end: 2 }), project)).toEqual({
      a: join(project, "assets", "sfx", "a.wav"), b: join(project, "assets", "sfx", "b.wav"), refs: [join(project, "assets", "music", "ref.wav")], a_start: 0.5, b_end: 2,
    });
    expect(await earshotArgs(fake, parse({ action: "timeline", path: "music/song.m4a", video: "cut.mp4", cues: "cues.json", detail: "low" }), project)).toEqual({
      path: join(project, "assets", "music", "song.m4a"), video: join(project, "cut.mp4"), cues: join(project, "cues.json"), detail: "low",
    });
    expect(await earshotArgs(fake, parse({ action: "realness", path: "sfx" }), project)).toEqual({ path: join(project, "assets", "sfx") });
  });

  it("refuses before earshot is asked anything", async () => {
    await expect(earshotArgs(fake, parse({ action: "describe", path: "https://example.com/a.mp3" }), project)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(earshotArgs(fake, parse({ action: "describe", path: "sfx" }), project)).rejects.toMatchObject({ code: "wrong-kind" });
    await expect(earshotArgs(fake, parse({ action: "describe", path: "sfx/a.wav" }), null)).rejects.toMatchObject({ code: "no-project" });
    expect(fake.call).not.toHaveBeenCalled();
  });

  it("refuses a folder or glob with a link to a protected file in it, whichever field takes it", async () => {
    const store = join(project, "private-store");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "voice.m4a"), "audio");
    await symlink(join(store, "voice.m4a"), join(project, "assets", "sfx", "c.m4a"));
    const guarded = { ...fake, privateDirs: [store] } as unknown as typeof fake;
    for (const args of [
      { action: "realness", path: "sfx" },
      { action: "realness", path: "sfx/*" },
      { action: "rank", paths: ["music", "sfx"], query: "a whoosh" },
      { action: "compare", path: "sfx/a.wav", refs: "sfx/**/*.m4a" },
      { action: "ab", a: "sfx/a.wav", b: "sfx/b.wav", refs: ["sfx"] },
    ]) {
      await expect(analyzeSound(guarded, parse(args), project)).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("c.m4a leads outside") });
    }
    expect(fake.call).not.toHaveBeenCalled();
  });
});

describe("analyzeSound", () => {
  it("returns earshot's summary and JSON with its version, within the action's time", async () => {
    replies.push({ summary: "a.wav: a fast whoosh (z +4.0).", json: { top_tags: ["a fast whoosh"] } });
    const output = await analyzeSound(fake, parse({ action: "describe", path: "sfx/a.wav" }), project);
    expect(output).toEqual({ action: "describe", version: "0.4.0", summary: "a.wav: a fast whoosh (z +4.0).", result: { top_tags: ["a fast whoosh"] } });
    expect(fake.call).toHaveBeenCalledWith("describe", { path: join(project, "assets", "sfx", "a.wav") }, undefined, ANALYZE_TIMEOUTS.describe);
  });

  it("names what this earshot version ignored", async () => {
    replies.push({ summary: "summary\n\n(this earshot version ignored: light, music)", json: {} });
    expect((await analyzeSound(fake, parse({ action: "measure", path: "sfx/a.wav", light: true, music: true }), project)).ignored).toEqual(["light", "music"]);
  });

  it("draws a sheet into a fresh temp folder and inlines its picture", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    fake.call.mockImplementationOnce(async (_tool: string, args: Record<string, unknown>) => ({ summary: "song.m4a: 4 sections.", json: { png: args.out_png }, png: args.out_png as string, image: { bytes: jpeg, mimeType: "image/jpeg" } }));
    const result = await analyzeSound(fake, parse({ action: "sheet", path: "music/song.m4a", detail: "low" }), project);
    const [, args] = fake.call.mock.calls[0]!;
    expect(args).toMatchObject({ path: join(project, "assets", "music", "song.m4a"), detail: "low", include_image: true });
    expect(args.out_png).toMatch(/\/cutroom-sound-sheet-[^/]+\/song\.png$/);
    expect(result.sheet).toBe(args.out_png);

    const shown = toCallToolResult(await present("sound_analyze", {}, result));
    expect(shown.content).toEqual([
      { type: "text", text: JSON.stringify({ action: "sheet", version: "0.4.0", summary: "song.m4a: 4 sections.", result: { png: args.out_png }, sheet: args.out_png }) },
      { type: "image", data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" },
    ]);
    expect(shown.structuredContent).not.toHaveProperty("image");
    // The picture stays for the agent (a cache sweep clears it a day later).
    await rm(dirname(String(args.out_png)), { recursive: true, force: true });
  });

  it("removes a sheet's temp folder at once when the call fails", async () => {
    fake.call.mockImplementationOnce(async () => { throw new Error("earshot's sheet took longer than 60 minutes and was stopped."); });
    await expect(analyzeSound(fake, parse({ action: "sheet", path: "music/song.m4a" }), project)).rejects.toThrow("took longer than 60 minutes");
    const [, args] = fake.call.mock.calls[0]!;
    await expect(stat(dirname(String(args.out_png)))).rejects.toThrow();
  });
});
