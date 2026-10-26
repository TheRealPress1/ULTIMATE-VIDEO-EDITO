import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), file: vi.fn(), library: vi.fn(), flush: vi.fn(), dispose: vi.fn(), track: vi.fn(), decode: vi.fn(), buffers: vi.fn() }));
vi.mock("../lib/assets", () => ({ resolveAsset: mocks.resolve, requireAssetType: vi.fn() }));
vi.mock("@diffusionstudio/runtime", () => ({ getAssetFile: mocks.file, getLibrary: mocks.library }));
vi.mock("@/projects/edits", () => ({ flushProjectEdits: mocks.flush }));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [], BlobSource: class {},
  Input: class { getPrimaryAudioTrack = mocks.track; dispose = mocks.dispose; },
  AudioBufferSink: class { buffers = mocks.buffers; },
}));
import { audioFinish } from "./audio-finish";
import type { ToolContext } from "../handler";

function fixture() {
  const library = { store: vi.fn().mockResolvedValue({ path: "normalized.wav" }), flush: vi.fn().mockResolvedValue(undefined) };
  const session = { world: {}, project: { dir: () => "/project" }, engine: {} };
  mocks.library.mockReturnValue(library);
  const ctx = { requireSession: () => session, session: vi.fn(() => session), signal: new AbortController().signal } as unknown as ToolContext;
  return { ctx, library };
}
const args = { action: "normalize" as const, path: "source.wav", targetPeakDb: -1 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ type: "AUDIO", source: "assets/source.wav", duration: 1 });
  mocks.file.mockResolvedValue(new Blob(["audio"]));
  mocks.flush.mockResolvedValue(undefined);
  mocks.decode.mockResolvedValue(true);
  mocks.track.mockResolvedValue({ canDecode: mocks.decode });
  mocks.buffers.mockImplementation(async function* () {
    yield { timestamp: 0, buffer: { sampleRate: 8000, numberOfChannels: 1, length: 2, getChannelData: () => Float32Array.from([0.5, -0.5]) } };
  });
});
describe("audio finish tool", () => {
  it("writes a unique WAV derivative and flushes it without editing or overwriting the source", async () => {
    const { ctx, library } = fixture();
    const result = await audioFinish(args, ctx);
    expect(result.outputPath).toBe("normalized.wav");
    expect(result.outputSamplePeakDb).toBeCloseTo(-1);
    expect(library.store).toHaveBeenCalledWith(expect.any(Blob), { name: expect.stringMatching(/^Normalized-[a-f0-9-]+\.wav$/) });
    expect(library.flush).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("inspects without storing or requiring an open project", async () => {
    const { ctx, library } = fixture();
    vi.mocked(ctx.session).mockReturnValue(null);
    const result = await audioFinish({ ...args, action: "inspect" }, ctx);
    expect(result.samplePeakDb).toBeCloseTo(-6.0206);
    expect(result.outputPath).toBeNull();
    expect(library.store).not.toHaveBeenCalled();
  });
  it("does not write into a project switched during decoding", async () => {
    const { ctx, library } = fixture();
    mocks.decode.mockImplementation(async () => { vi.mocked(ctx.session).mockReturnValue(null); return true; });
    await expect(audioFinish(args, ctx)).rejects.toMatchObject({ code: "no-project" });
    expect(library.store).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("rejects a failed save and an unsupported codec before storing output", async () => {
    const { ctx, library } = fixture();
    mocks.flush.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(audioFinish(args, ctx)).rejects.toThrow("Disk unavailable");
    expect(library.store).not.toHaveBeenCalled();
    mocks.decode.mockResolvedValue(false);
    await expect(audioFinish(args, ctx)).rejects.toMatchObject({ code: "unsupported" });
  });
  it("rejects remote media before decoding and propagates cancellation without storing", async () => {
    const { ctx, library } = fixture();
    await expect(audioFinish({ ...args, path: "https://example.com/audio.wav" }, ctx)).rejects.toMatchObject({ code: "invalid-input" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    mocks.decode.mockImplementation(async () => { controller.abort(); return true; });
    await expect(audioFinish(args, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(library.store).not.toHaveBeenCalled();
  });
});
