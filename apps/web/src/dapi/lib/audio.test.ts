import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "@diffusionstudio/assets";
const mocks = vi.hoisted(() => ({
  file: vi.fn(),
  track: vi.fn(),
  dispose: vi.fn(),
  init: vi.fn(),
}));
vi.mock("@diffusionstudio/runtime", () => ({ getAssetFile: mocks.file }));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  BufferTarget: class {
    buffer = new ArrayBuffer(100);
  },
  Input: class {
    getPrimaryAudioTrack = mocks.track;
    dispose = mocks.dispose;
  },
  Output: class {},
  AdtsOutputFormat: class {
    mimeType = "audio/aac";
  },
  Conversion: { init: mocks.init },
}));
import { audioFile, audioWindow } from "./audio";
const asset = { id: "video", type: "VIDEO" } as Asset;
const conversion = () => ({
  isValid: true,
  execute: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.file.mockResolvedValue(new Blob(["source"]));
  mocks.track.mockResolvedValue({
    codec: "aac",
    getFirstTimestamp: async () => 0,
  });
  mocks.init.mockResolvedValue(conversion());
});
describe("cancelable local audio windows", () => {
  it("extracts the exact requested source window and disposes input", async () => {
    await audioFile(asset, 10, 30);
    expect(mocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        trim: { start: 10, end: 30 },
        video: { discard: true },
        tracks: "primary",
      }),
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("returns the real source origin when an audio track starts later than the requested window", async () => {
    mocks.track.mockResolvedValue({
      codec: "aac",
      getFirstTimestamp: async () => 15,
    });
    const result = await audioWindow(asset, 10, 30);
    expect(result.sourceStart).toBe(15);
    expect(mocks.init).toHaveBeenCalledWith(
      expect.objectContaining({ trim: { start: 15, end: 30 } }),
    );
  });
  it("does no decoding for a cancelled request", async () => {
    await expect(
      audioFile(asset, 0, 30, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.file).not.toHaveBeenCalled();
  });
  it("cancels extraction when cancellation arrives during conversion initialization", async () => {
    let finish!: (value: ReturnType<typeof conversion>) => void;
    mocks.init.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const controller = new AbortController(),
      work = audioFile(asset, 0, 30, controller.signal),
      rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
    controller.abort();
    const c = conversion();
    finish(c);
    await rejected;
    expect(c.cancel).toHaveBeenCalledOnce();
    expect(c.execute).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("cancels executing extraction and never returns its late bytes", async () => {
    const controller = new AbortController(),
      c = conversion();
    c.execute.mockImplementation(async () => {
      controller.abort();
    });
    mocks.init.mockResolvedValue(c);
    await expect(
      audioFile(asset, 0, 30, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(c.cancel).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
