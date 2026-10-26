import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  call: vi.fn(), handle: vi.fn(), stop: vi.fn(), init: vi.fn(),
  duration: vi.fn(), first: vi.fn(), video: vi.fn(), track: vi.fn(), dispose: vi.fn(),
}));
vi.mock("./ipc", () => ({ mainBridge: { call: mocks.call, handle: mocks.handle } }));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  BlobSource: class { constructor(readonly blob: Blob) {} },
  BufferTarget: class { buffer = new ArrayBuffer(44); },
  Input: class { getPrimaryAudioTrack = mocks.track; getPrimaryVideoTrack = mocks.video; dispose = mocks.dispose; },
  Output: class { constructor(readonly options: unknown) {} },
  WavOutputFormat: class {},
  Conversion: { init: mocks.init },
}));

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { transcribeLocally } from "./local-transcription";
import type { SpeechProgress, SpeechResult } from "@desktop/speech-types";

const result: SpeechResult = { segments: [{ text: "Hello.", words: [{ text: "Hello.", start: 0.1, end: 0.8 }] }] };
const status = { available: true, modelDownloaded: false, modelName: "Whisper base", downloadBytes: 148_000_000, error: null };
const nativeCalls = () => mocks.call.mock.calls.filter(([channel]) => channel === MAIN_CHANNELS.SPEECH_TRANSCRIBE);
const audio = new Blob(["audio"]);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function conversion() {
  return { isValid: true, execute: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined), onProgress: undefined as ((progress: number) => void) | undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { desktop: {} });
  mocks.first.mockResolvedValue(0); mocks.video.mockResolvedValue(null);
  mocks.track.mockResolvedValue({ computeDuration: mocks.duration, getFirstTimestamp: mocks.first });
  mocks.duration.mockResolvedValue(12);
  mocks.init.mockResolvedValue(conversion());
  mocks.handle.mockReturnValue(mocks.stop);
  mocks.call.mockImplementation((channel) => Promise.resolve(channel === MAIN_CHANNELS.SPEECH_STATUS ? status : result));
});
afterEach(() => vi.unstubAllGlobals());

describe("local transcription bridge", () => {
  it("returns no speech for a requested silent video tail without decoding beyond the audio track", async () => {
    mocks.duration.mockResolvedValue(12);
    await expect(transcribeLocally(audio, { sourceDuration: 100, window: { start: 80, end: 100 } })).resolves.toEqual([]);
    expect(mocks.init).not.toHaveBeenCalled(); expect(nativeCalls()).toHaveLength(0);
  });
  it("prepares mono 16 kHz PCM and sends only local bytes, then releases the progress subscription", async () => {
    const progress = vi.fn();
    await expect(transcribeLocally(audio, { onProgress: progress })).resolves.toEqual(result.segments);
    expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({
      audio: { codec: "pcm-s16", sampleRate: 16_000, numberOfChannels: 1 },
      video: { discard: true }, tracks: "primary",
    }));
    expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.SPEECH_TRANSCRIBE, {
      id: expect.any(String), audio: expect.any(Uint8Array),
    });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "preparing", progress: 0 }));
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it.each([0, Infinity, 7_201])("rejects unsupported duration %s before converting or sending audio", async (duration) => {
    mocks.duration.mockResolvedValue(duration);
    await expect(transcribeLocally(audio)).rejects.toThrow();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(nativeCalls()).toHaveLength(0);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("rejects files without an audio track", async () => {
    mocks.track.mockResolvedValue(null);
    await expect(transcribeLocally(audio)).rejects.toThrow("no audio track");
    expect(nativeCalls()).toHaveLength(0);
  });

  it("does not start preparation for an already canceled call", async () => {
    await expect(transcribeLocally(audio, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("cancels a conversion which finishes initializing after cancellation", async () => {
    const pending = deferred<ReturnType<typeof conversion>>();
    mocks.init.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const task = transcribeLocally(audio, { signal: controller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
    controller.abort();
    const encoder = conversion();
    pending.resolve(encoder);
    await rejected;
    expect(encoder.cancel).toHaveBeenCalledOnce();
    expect(encoder.execute).not.toHaveBeenCalled();
    expect(nativeCalls()).toHaveLength(0);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("cancels native work immediately and ignores a late successful response", async () => {
    const native = deferred<SpeechResult>();
    mocks.call.mockImplementation((channel) => channel === MAIN_CHANNELS.SPEECH_TRANSCRIBE ? native.promise : Promise.resolve(status));
    const controller = new AbortController();
    const progress = vi.fn();
    const task = transcribeLocally(audio, { signal: controller.signal, onProgress: progress });
    const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(nativeCalls()).toHaveLength(1));
    const id = nativeCalls()[0]![1].id;
    controller.abort();
    await rejected;
    expect(mocks.call).toHaveBeenLastCalledWith(MAIN_CHANNELS.SPEECH_CANCEL, { id });
    expect(mocks.stop).toHaveBeenCalledOnce();
    progress.mockClear();
    mocks.handle.mock.calls[0]![1]({ id, stage: "transcribing", progress: 1, message: "Done" });
    expect(progress).not.toHaveBeenCalled();
    native.resolve(result);
  });

  it("routes concurrent job progress independently and keeps the handler until the last job finishes", async () => {
    const native = [deferred<SpeechResult>(), deferred<SpeechResult>()];
    let index = 0;
    mocks.call.mockImplementation((channel) => channel === MAIN_CHANNELS.SPEECH_STATUS ? Promise.resolve(status) : native[index++]!.promise);
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = transcribeLocally(audio, { onProgress: firstProgress });
    const second = transcribeLocally(audio, { onProgress: secondProgress });
    await vi.waitFor(() => expect(nativeCalls()).toHaveLength(2));
    expect(mocks.handle).toHaveBeenCalledOnce();
    firstProgress.mockClear();
    secondProgress.mockClear();
    const event: SpeechProgress = { id: nativeCalls()[1]![1].id, stage: "transcribing", progress: 0.5, message: "Transcribing" };
    mocks.handle.mock.calls[0]![1](event);
    expect(firstProgress).not.toHaveBeenCalled();
    expect(secondProgress).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(event));
    native[0]!.resolve(result);
    await first;
    expect(mocks.stop).not.toHaveBeenCalled();
    native[1]!.resolve(result);
    await second;
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("returns native errors while releasing conversion resources and progress listeners", async () => {
    mocks.call.mockImplementation((channel) => channel === MAIN_CHANNELS.SPEECH_STATUS ? Promise.resolve(status) : Promise.reject(new Error("Model download failed")));
    await expect(transcribeLocally(audio)).rejects.toThrow("Model download failed");
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("fails before audio preparation if the local runtime is missing", async () => {
    mocks.call.mockResolvedValue({ ...status, available: false, error: "Speech runtime not installed" });
    await expect(transcribeLocally(audio)).rejects.toThrow("Speech runtime not installed");
    expect(mocks.track).not.toHaveBeenCalled();
    expect(mocks.handle).not.toHaveBeenCalled();
  });
});


describe('long original-file transcription', () => {
  it('uses 18 bounded PCM conversions for a 90-minute source', async () => {
    mocks.duration.mockResolvedValue(5400);
    await transcribeLocally(audio);
    expect(nativeCalls()).toHaveLength(18);
    const windows = mocks.init.mock.calls.map(([value]) => value.trim);
    expect(windows[0]).toEqual({ start: 0, end: 302 });
    expect(windows.at(-1)).toEqual({ start: 5098, end: 5400 });
    expect(windows.every(window => window.end - window.start <= 304)).toBe(true);
  });
  it('normalizes a global positive media origin but retains an audio delay relative to video', async () => {
    mocks.first.mockResolvedValue(7); mocks.video.mockResolvedValue({ getFirstTimestamp: async () => 2 }); mocks.duration.mockResolvedValue(14);
    const result = await transcribeLocally(audio);
    expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({ trim: { start: 7, end: 14 } }));
    expect(result[0]!.words[0]).toMatchObject({ start: 5.1, end: 5.8 });
  });
  it('reuses persisted no-speech and speech sections without decoding them again', async () => {
    mocks.duration.mockResolvedValue(900);
    const cached = { fingerprint: 'a'.repeat(64), engine: 'test', chunkSeconds: 300, overlapSeconds: 2, completed: 2, total: 3, chunks: { 0: [], 1: [{ text: 'Saved', words: [{ text: 'Saved', start: 350, end: 351 }] }] } };
    mocks.call.mockImplementation(async channel => channel === MAIN_CHANNELS.SPEECH_STATUS ? status : channel === MAIN_CHANNELS.FOOTAGE_INDEX_CHUNKS_GET || channel === MAIN_CHANNELS.FOOTAGE_INDEX_CHUNK_PUT ? cached : result);
    const output = await transcribeLocally(audio, { cache: { dir: '/project', source: '/source', duration: 900, expectedFingerprint: 'a'.repeat(64) } });
    expect(mocks.init).toHaveBeenCalledOnce(); expect(nativeCalls()).toHaveLength(1);
    expect(output.flatMap(segment => segment.words).some(word => word.text === 'Saved' && word.start === 350)).toBe(true);
  });
  it('checkpoints the first successful section before cancellation and resumes without retranscribing it', async () => {
    mocks.duration.mockResolvedValue(600);
    const cache = { fingerprint: 'a'.repeat(64), engine: 'test', chunkSeconds: 300, overlapSeconds: 2, completed: 0, total: 2, chunks: {} as Record<number, typeof result.segments> };
    mocks.call.mockImplementation(async (channel, args) => {
      if (channel === MAIN_CHANNELS.SPEECH_STATUS) return status;
      if (channel === MAIN_CHANNELS.FOOTAGE_INDEX_CHUNKS_GET) return cache;
      if (channel === MAIN_CHANNELS.FOOTAGE_INDEX_CHUNK_PUT) { cache.chunks[args.index] = args.transcript; cache.completed = Object.keys(cache.chunks).length; return cache; }
      return result;
    });
    const controller = new AbortController(), options = { cache: { dir: '/project', source: '/source', duration: 600, expectedFingerprint: 'a'.repeat(64) } };
    await expect(transcribeLocally(audio, { ...options, signal: controller.signal, onProgress: progress => { if (progress.completedChunks === 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.completed).toBe(1); expect(nativeCalls()).toHaveLength(1);
    await transcribeLocally(audio, options);
    expect(nativeCalls()).toHaveLength(2); expect(cache.completed).toBe(2);
  });
});
