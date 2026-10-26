/** Bounded, timestamp-preserving PCM analysis; output is 32-bit float WAV. */
export const MAX_AUDIO_SECONDS = 600;
export const MAX_PCM_VALUES = 128 * 1024 * 1024 / 4;
export type PcmBlock = {
  timestamp: number;
  buffer: { sampleRate: number; numberOfChannels: number; length: number; getChannelData(channel: number): Float32Array };
};
type SavedBlock = { frame: number; channels: Float32Array[] };
export type PcmResult = {
  sampleRate: number; channels: number; frames: number; peak: number; rms: number;
  fullScaleSamples: number; blocks: SavedBlock[];
};

export async function analyzePcm(blocks: AsyncIterable<PcmBlock>, retain: boolean, signal: AbortSignal, maxBytes = 128 * 1024 * 1024): Promise<PcmResult> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw new Error('Invalid audio memory bound.');
  const result: PcmResult = { sampleRate: 0, channels: 0, frames: 0, peak: 0, rms: 0, fullScaleSamples: 0, blocks: [] };
  let energy = 0;
  for await (const { timestamp, buffer } of blocks) {
    signal.throwIfAborted();
    if (!Number.isFinite(timestamp) || !Number.isSafeInteger(buffer.length) || buffer.length < 0) throw new Error("Invalid decoded audio timing.");
    if (!result.sampleRate) {
      if (!Number.isInteger(buffer.sampleRate) || buffer.sampleRate < 8000 || buffer.sampleRate > 192000 || ![1, 2].includes(buffer.numberOfChannels)) {
        throw new Error("Audio finishing supports mono/stereo audio at 8–192 kHz.");
      }
      result.sampleRate = buffer.sampleRate;
      result.channels = buffer.numberOfChannels;
    }
    if (buffer.sampleRate !== result.sampleRate || buffer.numberOfChannels !== result.channels) throw new Error("Audio format changes mid-file; convert it to a consistent sample rate and channel layout first.");
    const rawFrame = Math.round(timestamp * result.sampleRate);
    const offset = Math.max(0, -rawFrame, result.frames - rawFrame);
    const frame = rawFrame + offset;
    const count = buffer.length - offset;
    if (count <= 0) continue;
    const end = frame + count;
    if (end / result.sampleRate > MAX_AUDIO_SECONDS + 1 / result.sampleRate || end * result.channels * 4 > maxBytes) {
      throw new Error(`Audio finishing supports up to 10 minutes and ${maxBytes / (1024 * 1024)} MiB of decoded samples. Use a shorter source segment.`);
    }
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < result.channels; channel++) {
      const source = buffer.getChannelData(channel);
      if (source.length !== buffer.length) throw new Error("Incomplete decoded audio channel.");
      const values = source.subarray(offset);
      for (const sample of values) {
        if (!Number.isFinite(sample)) throw new Error("The decoded audio contains invalid samples.");
        const magnitude = Math.abs(sample);
        result.peak = Math.max(result.peak, magnitude);
        energy += sample * sample;
        if (magnitude >= 1) result.fullScaleSamples++;
      }
      if (retain) channels.push(values.slice());
    }
    if (retain) result.blocks.push({ frame, channels });
    result.frames = end;
  }
  signal.throwIfAborted();
  if (!result.frames) throw new Error("No audio samples could be decoded.");
  result.rms = Math.sqrt(energy / (result.frames * result.channels));
  return result;
}

export const decibels = (amplitude: number): number | null => amplitude > 0 ? 20 * Math.log10(amplitude) : null;

export function normalizedWav(pcm: PcmResult, targetPeakDb: number, signal: AbortSignal): { blob: Blob; gainDb: number; peakDb: number; limited: boolean } {
  signal.throwIfAborted();
  if (!Number.isFinite(targetPeakDb) || targetPeakDb < -24 || targetPeakDb > -0.1) throw new Error("Target sample peak must be between -24 and -0.1 dBFS.");
  if (pcm.peak <= 0) throw new Error("The source is digital silence; there is no peak to normalize.");
  const requestedGain = targetPeakDb - decibels(pcm.peak)!;
  const gainDb = Math.min(24, requestedGain);
  const gain = 10 ** (gainDb / 20);
  const output = encodePcmWav(pcm, signal, gain);
  return { blob: new Blob([output], { type: "audio/wav" }), gainDb, peakDb: decibels(pcm.peak * gain)!, limited: requestedGain > 24 };
}

/** Encode retained samples without lossy compression, including digital silence. */
export function encodePcmWav(pcm: PcmResult, signal: AbortSignal, gain = 1): ArrayBuffer {
  signal.throwIfAborted();
  if (!Number.isFinite(gain) || gain < 0 || !pcm.blocks.length) throw new Error('Retained PCM samples and a finite gain are required.');
  const dataSize = pcm.frames * pcm.channels * 4;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, pcm.channels, true);
  view.setUint32(24, pcm.sampleRate, true); view.setUint32(28, pcm.sampleRate * pcm.channels * 4, true);
  view.setUint16(32, pcm.channels * 4, true); view.setUint16(34, 32, true);
  text(36, "data"); view.setUint32(40, dataSize, true);
  for (const block of pcm.blocks) {
    signal.throwIfAborted();
    for (let channel = 0; channel < pcm.channels; channel++) {
      const values = block.channels[channel]!;
      for (let frame = 0; frame < values.length; frame++) {
        view.setFloat32(44 + ((block.frame + frame) * pcm.channels + channel) * 4, values[frame]! * gain, true);
      }
    }
  }
  return output;
}
