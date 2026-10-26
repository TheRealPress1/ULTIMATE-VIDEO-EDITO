import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), audio: vi.fn(), transcribe: vi.fn(), library: vi.fn(), service: vi.fn() }));
vi.mock("../lib/assets", () => ({ resolveAsset: mocks.resolve, requireAssetType: vi.fn() }));
vi.mock("@/lib/source-transcription", () => ({ transcribeSource: mocks.transcribe }));
vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: mocks.library }));
vi.mock("@/engine/footage", () => ({ getFootageService: mocks.service }));

import { transcribe } from "./transcribe";
import type { ToolContext } from "../handler";

const segments = [{ text: "Hello.", words: [{ text: "Hello.", start: 0, end: 1 }] }];
function context(signal: AbortSignal = new AbortController().signal) { return { signal } as ToolContext; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ id: "asset", type: "AUDIO" });
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
    await expect(transcribe({ path: 'clip.wav' }, ctx)).resolves.toEqual({ segments });
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
    await expect(transcribe({ path: "clip.wav" }, ctx)).resolves.toEqual({ segments });
    await expect(transcribe({ path: "clip.wav" }, ctx)).resolves.toEqual({ segments });
    expect(mocks.transcribe).toHaveBeenCalledTimes(2);
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ id: "asset" }), expect.objectContaining({ signal: ctx.signal, assertCurrent: expect.any(Function) }));
  });

  it("does not retain failures in the session cache", async () => {
    mocks.transcribe.mockRejectedValueOnce(new DOMException("Canceled", "AbortError"));
    await expect(transcribe({ path: "clip.wav" }, context())).rejects.toMatchObject({ name: "AbortError" });
    await expect(transcribe({ path: "clip.wav" }, context())).resolves.toEqual({ segments });
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
});
