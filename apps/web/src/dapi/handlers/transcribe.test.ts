import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), audio: vi.fn(), transcribe: vi.fn(), library: vi.fn(), service: vi.fn(), footage: vi.fn() }));
vi.mock("../lib/assets", () => ({ resolveAsset: mocks.resolve, requireAssetType: vi.fn() }));
vi.mock("@/lib/source-transcription", () => ({ transcribeSource: mocks.transcribe }));
vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: mocks.library }));
vi.mock("@/engine/footage", () => ({ getFootageService: mocks.service }));
vi.mock("@/lib/footage-cache", () => ({ requestFootage: mocks.footage }));

import { toolByName } from "@diffusionstudio/dapi";
import { sliceTranscript, transcribe } from "./transcribe";
import type { ToolArgs, ToolInput } from "@diffusionstudio/dapi";
import type { ToolContext } from "../handler";

const args = (input: ToolInput<"transcribe">) => toolByName("transcribe").input.parse(input) as ToolArgs<"transcribe">;

const segments = [{ text: "Hello.", words: [{ text: "Hello.", start: 0, end: 1 }] }];
function context(signal: AbortSignal = new AbortController().signal) { return { signal } as ToolContext; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ id: "asset", type: "AUDIO", source: "assets/talk.wav", duration: 120 });
  mocks.audio.mockResolvedValue(new Blob([crypto.randomUUID()]));
  mocks.transcribe.mockResolvedValue(segments);
});

describe("agent local transcription", () => {
  it("shares the persistent footage index for imported project media", async () => {
    const session = { world: {}, project: { dir: () => '/project' } };
    const ctx = { ...context(), session: () => session } as ToolContext;
    mocks.library.mockReturnValue({ list: () => [{ id: 'asset' }] });
    const indexPaths = vi.fn().mockResolvedValue(undefined);
    mocks.service.mockReturnValue({ indexPaths, snapshot: () => ({ items: [{ assetId: 'asset', status: 'ready', segments }] }) });
    await expect(transcribe({ path: 'clip.wav' }, ctx)).resolves.toEqual({ segments, model: "whisper-base" });
    expect(indexPaths).toHaveBeenCalledWith(['asset'], ctx.signal);
    expect(mocks.audio).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("rejects navigation during source resolution before indexing another project", async () => {
    let session: unknown = { world: {}, project: { dir: () => '/first' } };
    const ctx = { ...context(), session: () => session } as ToolContext;
    mocks.resolve.mockImplementationOnce(async () => { session = { world: {}, project: { dir: () => '/second' } }; return { id: 'asset', type: 'AUDIO' }; });
    await expect(transcribe({ path: 'clip.wav' }, ctx)).rejects.toThrow('project changed');
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.audio).not.toHaveBeenCalled();
  });

  it("delegates original-source transcription to the persistent source service", async () => {
    const ctx = context();
    await expect(transcribe({ path: "clip.wav" }, ctx)).resolves.toEqual({ segments, model: "whisper-base" });
    await expect(transcribe({ path: "clip.wav" }, ctx)).resolves.toEqual({ segments, model: "whisper-base" });
    expect(mocks.transcribe).toHaveBeenCalledTimes(2);
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ id: "asset" }), expect.objectContaining({ signal: ctx.signal, assertCurrent: expect.any(Function) }));
  });

  it("does not retain failures in the session cache", async () => {
    mocks.transcribe.mockRejectedValueOnce(new DOMException("Canceled", "AbortError"));
    await expect(transcribe({ path: "clip.wav" }, context())).rejects.toMatchObject({ name: "AbortError" });
    await expect(transcribe({ path: "clip.wav" }, context())).resolves.toEqual({ segments, model: "whisper-base" });
    expect(mocks.transcribe).toHaveBeenCalledTimes(2);
  });

  it("stops before decoding audio when the agent request was canceled", async () => {
    await expect(transcribe({ path: "clip.wav" }, context(AbortSignal.abort()))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.audio).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("rejects silent recordings instead of creating empty captions", async () => {
    mocks.transcribe.mockResolvedValue([]);
    await expect(transcribe({ path: "clip.wav" }, context())).rejects.toThrow("No speech detected");
  });

  it("transcribes only the window, with word times in source seconds", async () => {
    const windowed = [{ text: "Later words.", words: [{ text: " Later", start: 31.2, end: 31.6 }, { text: " words.", start: 31.7, end: 32.3 }] }];
    mocks.transcribe.mockResolvedValue(windowed);
    await expect(transcribe(args({ path: "/m/talk.wav", start: 30, end: 40, language: "de" }), context())).resolves.toEqual({ segments: windowed, start: 30, end: 40, model: "whisper-base", language: "de" });
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ id: "asset" }), expect.objectContaining({ window: { start: 30, end: 40 }, language: "de" }));
  });

  it("slices an indexed library file's saved transcript instead of running it again, as a direct window would read", async () => {
    const saved = [
      { text: "One two.", words: [{ text: " One", start: 1, end: 1.4 }, { text: " two.", start: 1.5, end: 2 }] },
      { text: "Three four five.", words: [{ text: " Three", start: 29.6, end: 30.2 }, { text: " four", start: 30.4, end: 30.8 }, { text: " five.", start: 39.8, end: 40.4 }] },
      { text: "Six.", words: [{ text: " Six.", start: 50, end: 50.5 }] },
    ];
    const session = { world: {}, project: { dir: () => "/project" } };
    const ctx = { ...context(), session: () => session } as ToolContext;
    mocks.library.mockReturnValue({ list: () => [{ id: "asset" }] });
    mocks.footage.mockResolvedValue({ fingerprint: "f".repeat(64), transcript: saved, indexedAt: null, engine: "whisper-base-source-v2" });
    const sliced = await transcribe(args({ path: "talk.wav", start: 30, end: 40 }), ctx);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.footage).toHaveBeenCalledWith(expect.any(String), { dir: "/project", source: "assets/talk.wav", duration: 120 }, ctx.signal);
    const direct = [{ text: "Three four five.", words: [{ text: " Three", start: 30, end: 30.2 }, { text: " four", start: 30.4, end: 30.8 }, { text: " five.", start: 39.8, end: 40 }] }];
    expect(sliced).toEqual({ segments: direct, start: 30, end: 40, model: "whisper-base" });
    expect(sliceTranscript(saved, 30, 40)).toEqual(direct);
    expect(sliceTranscript(saved, 1.45, 30)[0]).toEqual({ text: "two.", words: [{ text: " two.", start: 1.5, end: 2 }] });
    await expect(transcribe(args({ path: "talk.wav", start: 41, end: 49 }), ctx)).rejects.toThrow("No speech detected in this window");
  });

  it("runs the accurate model afresh, past the footage index", async () => {
    const session = { world: {}, project: { dir: () => "/project" } };
    const ctx = { ...context(), session: () => session } as ToolContext;
    mocks.library.mockReturnValue({ list: () => [{ id: "asset" }] });
    await expect(transcribe(args({ path: "talk.wav", quality: "accurate" }), ctx)).resolves.toEqual({ segments, model: "whisper-large-v3-turbo" });
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.footage).not.toHaveBeenCalled();
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quality: "accurate", dir: "/project" }));
  });

  it("treats a window that is the whole file as the whole file", async () => {
    const session = { world: {}, project: { dir: () => "/project" } };
    const ctx = { ...context(), session: () => session } as ToolContext;
    mocks.library.mockReturnValue({ list: () => [{ id: "asset" }] });
    const indexPaths = vi.fn().mockResolvedValue(undefined);
    mocks.service.mockReturnValue({ indexPaths, snapshot: () => ({ items: [{ assetId: "asset", status: "ready", segments }] }) });
    await expect(transcribe(args({ path: "talk.wav", start: 0, end: 500 }), ctx)).resolves.toEqual({ segments, start: 0, end: 120, model: "whisper-base" });
    expect(indexPaths).toHaveBeenCalled();
  });

  it("transcribes a window of a library recording longer than two hours, which the footage index does not hold", async () => {
    const session = { world: {}, project: { dir: () => "/project" } };
    const ctx = { ...context(), session: () => session } as ToolContext;
    mocks.resolve.mockResolvedValue({ id: "asset", type: "VIDEO", source: "assets/podcast.mp4", duration: 10_800 });
    mocks.library.mockReturnValue({ list: () => [{ id: "asset" }] });
    await expect(transcribe(args({ path: "podcast.mp4", start: 0, end: 600 }), ctx)).resolves.toEqual({ segments, start: 0, end: 600, model: "whisper-base" });
    expect(mocks.footage).not.toHaveBeenCalled();
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ window: { start: 0, end: 600 } }));

    await expect(transcribe(args({ path: "podcast.mp4" }), ctx)).rejects.toMatchObject({ code: "invalid-input", message: expect.stringMatching(/3\.0 hours.*start and end/) });
    await expect(transcribe(args({ path: "podcast.mp4", start: 600, end: 7_900 }), ctx)).rejects.toMatchObject({ code: "invalid-input" });
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
  });

  it("refuses a window that starts past the end", async () => {
    await expect(transcribe(args({ path: "/m/talk.wav", start: 200 }), context())).rejects.toMatchObject({ code: "invalid-input" });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
