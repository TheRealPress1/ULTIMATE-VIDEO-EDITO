import { beforeEach, describe, expect, it, vi } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import type { ToolContext } from "../handler";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  audio: vi.fn(),
  transcribe: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../lib/assets", () => ({
  resolveAsset: mocks.resolve,
  requireAssetType: (asset: { type: string }, types: string[]) => {
    if (!types.includes(asset.type)) throw new Error("not audio or video");
  },
}));

vi.mock("@/lib/source-transcription", () => ({ transcribeSource: mocks.transcribe }));
vi.mock("@/lib/local-transcription", () => ({ MAX_TRANSCRIPTION_SECONDS: 7200 }));
import { listen } from "./listen";
const screenshot = {
  path: "/Users/gaspardseuge/Movies/Cutroom Standalone Test/assets/rheesa.mp4",
  prompt:
    "Diarize this clip. For each stretch of speech give start and end in seconds and who is speaking, distinguishing voices (e.g. female host 1, Rheesa the guest in a news segment, male/female guests from the second pair, etc.), with the words spoken. Note which voice sounds like the host and which like Rheesa Theesdale. Be precise to about 0.5s.",
  end: 30,
};
const transcript = [
  {
    text: "Hello there.",
    speaker: "speaker-1",
    words: [
      { text: "Hello", start: 0.25, end: 0.65 },
      { text: "there.", start: 0.7, end: 1.1 },
    ],
  },
];
const ctx = (signal = new AbortController().signal) =>
  ({ signal, session: () => null }) as ToolContext;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    id: "rheesa",
    source: screenshot.path,
    type: "VIDEO",
    duration: 60,
  });
  mocks.audio.mockImplementation(async (_asset, from) => ({
    audio: new Blob(["local audio"]),
    sourceStart: from,
  }));
  mocks.transcribe.mockResolvedValue(transcript);
});
describe("local listen speech evidence", () => {
  it("handles the exact screenshot call locally and explicitly declines inferred speaker identity", async () => {
    const context = ctx(),
      args = toolByName("listen").input.parse(screenshot);
    const result = await listen(args, context);
    expect(mocks.resolve).toHaveBeenCalledWith(context, screenshot.path);
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ id: 'rheesa' }), expect.objectContaining({ signal: context.signal, window: { start: 0, end: 30 } }));
    expect(result).toMatchObject({
      method: "local-speech-transcription",
      start: 0,
      end: 30,
      requestedPrompt: screenshot.prompt,
      timestampOrigin: "window",
    });
    expect(result.result).toContain("No speaker labels have been inferred");
    expect(result.limitations.join()).toContain("not a full semantic analysis");
    expect(result.segments[0]).not.toHaveProperty("speaker");
    expect(result.segments[0]!.text).toBe("Hello there.");
    expect(toolByName("listen").output.safeParse(result).success).toBe(true);
  });
  it("returns window-relative words alongside absolute source timing and clips the end", async () => {
    mocks.resolve.mockResolvedValue({
      id: "asset",
      source: "/local.wav",
      type: "AUDIO",
      duration: 11,
    });
    mocks.transcribe.mockResolvedValue([
      {
        text: "Hello there beyond",
        words: [
          { text: "Hello", start: 10.25, end: 10.65 },
          { text: "there", start: 10.7, end: 11.4 },
          { text: "beyond", start: 11.5, end: 12 },
        ],
      },
    ]);
    const result = await listen(
      { path: "voice.wav", start: 10, end: 30 },
      ctx(),
    );
    expect(result).toMatchObject({ start: 10, end: 11 });
    expect(result.segments[0]!.words).toEqual([
      {
        text: "Hello",
        start: 0.25,
        end: 0.65,
        sourceStart: 10.25,
        sourceEnd: 10.65,
      },
      { text: "there", start: 0.7, end: 1, sourceStart: 10.7, sourceEnd: 11 },
    ]);
    expect(result.result).not.toContain("beyond");
  });
  it("retains a delayed audio track origin inside the requested source window", async () => {
    mocks.transcribe.mockResolvedValueOnce([{ text: 'Hello there.', words: [{ text: 'Hello', start: 15.25, end: 15.65 }] }]);
    const result = await listen(
      { path: "delayed.mp4", start: 10, end: 30 },
      ctx(),
    );
    expect(result.segments[0]!.words[0]).toMatchObject({
      start: 5.25,
      end: 5.65,
      sourceStart: 15.25,
      sourceEnd: 15.65,
    });
    expect(result).toMatchObject({ start: 10, end: 30 });
  });
  it("always echoes the full source window and reports no speech without claiming silence", async () => {
    mocks.transcribe.mockResolvedValue([]);
    const result = await listen({ path: "clip.mp4" }, ctx());
    expect(result).toMatchObject({ start: 0, end: 60, segments: [] });
    expect(result.result).toContain("not proof");
  });
  it.each([
    { path: "https://example.test/clip.mp4" },
    { path: "file:///private/clip.mp4" },
    { path: "clip.mp4", start: 60 },
    { path: "clip.mp4", start: 8, end: 8 },
  ])("rejects invalid or remote inputs %j", async (args) => {
    await expect(listen(args, ctx())).rejects.toThrow();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it("rejects remote library bindings and windows beyond the two-hour recording limit", async () => {
    mocks.resolve.mockResolvedValueOnce({
      id: "remote",
      source: "https://example.test/clip.mp4",
      type: "VIDEO",
      duration: 20,
    });
    await expect(listen({ path: "remote.mp4" }, ctx())).rejects.toThrow(
      "remote media",
    );
    mocks.resolve.mockResolvedValueOnce({
      id: "long",
      source: "/long.mp4",
      type: "VIDEO",
      duration: 7201,
    });
    await expect(listen({ path: "long.mp4" }, ctx())).rejects.toThrow(
      "two hours",
    );
    expect(mocks.audio).not.toHaveBeenCalled();
  });
  it("cancels before decoding and ignores a late transcription result", async () => {
    await expect(
      listen(screenshot, ctx(AbortSignal.abort())),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    const controller = new AbortController();
    mocks.transcribe.mockImplementationOnce(async () => {
      controller.abort();
      return transcript;
    });
    await expect(
      listen(screenshot, ctx(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("stops when the project changes during local preparation", async () => {
    let session: unknown = { project: { dir: () => "/first" } };
    const context = { ...ctx(), session: () => session } as ToolContext;
    mocks.resolve.mockImplementationOnce(async () => {
      session = { project: { dir: () => "/second" } };
      return { id: 'asset', source: '/local.mp4', type: 'VIDEO', duration: 30 };
    });
    await expect(listen(screenshot, context)).rejects.toThrow(
      "project changed",
    );
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
