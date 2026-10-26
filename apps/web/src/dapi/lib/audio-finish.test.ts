import { describe, expect, it } from "vitest";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { analyzePcm, decibels, MAX_PCM_VALUES, normalizedWav } from "./audio-finish";
import type { PcmBlock } from "./audio-finish";

const signal = () => new AbortController().signal;
function block(values: number[][], timestamp = 0): PcmBlock {
  return { timestamp, buffer: { sampleRate: 8000, numberOfChannels: values.length, length: values[0]!.length, getChannelData: (channel) => Float32Array.from(values[channel]!) } };
}
async function* stream(...blocks: PcmBlock[]) { yield* blocks; }

describe("bounded PCM audio finishing", () => {
  it("measures stereo sample peaks, RMS and full-scale samples without retaining inspection buffers", async () => {
    const pcm = await analyzePcm(stream(block([[0.5, -1], [0, 1]])), false, signal());
    expect(pcm.peak).toBe(1);
    expect(pcm.rms).toBeCloseTo(0.75);
    expect(pcm.fullScaleSamples).toBe(2);
    expect(pcm.blocks).toEqual([]);
    expect(decibels(pcm.peak)).toBe(0);
  });

  it("preserves leading/interior silence and channel balance in normalized WAV samples", async () => {
    const pcm = await analyzePcm(stream(block([[0.5], [0.25]], 1 / 8000), block([[-0.25], [-0.5]], 3 / 8000)), true, signal());
    const result = normalizedWav(pcm, -6, signal());
    const bytes = await result.blob.arrayBuffer();
    const wav = new DataView(bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(wav.getUint16(20, true)).toBe(3);
    expect(wav.getUint16(22, true)).toBe(2);
    expect(wav.getUint32(24, true)).toBe(8000);
    expect(wav.getFloat32(44, true)).toBe(0);
    expect(wav.getFloat32(44 + 2 * 4, true)).toBeCloseTo(10 ** (-6 / 20));
    expect(wav.getFloat32(44 + 3 * 4, true)).toBeCloseTo(10 ** (-6 / 20) / 2);
    expect(wav.getFloat32(44 + 4 * 4, true)).toBe(0);
    expect(result.peakDb).toBeCloseTo(-6);
    expect(pcm.frames).toBe(4);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(result.blob) });
    try {
      const track = await input.getPrimaryAudioTrack();
      expect(track).not.toBeNull();
      expect(await track!.computeDuration()).toBeCloseTo(4 / 8000);
      expect(track!.numberOfChannels).toBe(2);
    } finally { input.dispose(); }
  });

  it("clips negative timestamp padding and overlapping decoder samples without shifting the later audio", async () => {
    const pcm = await analyzePcm(stream(block([[1, 0.25, 0.5]], -1 / 8000), block([[0.5, -0.25]], 1 / 8000)), true, signal());
    expect(pcm.frames).toBe(3);
    expect(pcm.peak).toBe(0.5);
    expect(pcm.fullScaleSamples).toBe(0);
    expect(pcm.blocks[1]!.frame).toBe(2);
    expect([...pcm.blocks[1]!.channels[0]!]).toEqual([-0.25]);
  });

  it("refuses silence, invalid samples and format changes instead of creating misleading output", async () => {
    const silent = await analyzePcm(stream(block([[0, 0]])), true, signal());
    expect(decibels(silent.rms)).toBeNull();
    expect(() => normalizedWav(silent, -1, signal())).toThrow("digital silence");
    await expect(analyzePcm(stream(block([[NaN]])), true, signal())).rejects.toThrow("invalid samples");
    await expect(analyzePcm(stream(block([[0.1]]), block([[0.1], [0.2]], 1 / 8000)), true, signal())).rejects.toThrow("format changes");
  });

  it("limits amplification and refuses buffers exceeding duration/memory limits", async () => {
    const quiet = await analyzePcm(stream(block([[0.00001]])), true, signal());
    const result = normalizedWav(quiet, -1, signal());
    expect(result.gainDb).toBe(24);
    expect(result.limited).toBe(true);
    await expect(analyzePcm(stream(block([[0.1]], 601)), true, signal())).rejects.toThrow("10 minutes");
    const huge = block([[0.1]]);
    huge.buffer.length = MAX_PCM_VALUES + 1;
    await expect(analyzePcm(stream(huge), true, signal())).rejects.toThrow("128 MiB");
  });

  it("honors cancellation before analysis and encoding", async () => {
    const aborted = AbortSignal.abort();
    await expect(analyzePcm(stream(block([[0.1]])), false, aborted)).rejects.toMatchObject({ name: "AbortError" });
    const pcm = await analyzePcm(stream(block([[0.1]])), true, signal());
    expect(() => normalizedWav(pcm, -1, aborted)).toThrow();
  });
});
