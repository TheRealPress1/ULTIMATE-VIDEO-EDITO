import { AUDIO_FINISH_MAX_BYTES, AUDIO_FINISH_MAX_SECONDS } from './audio-finishing-types';
import type { AudioPcmMeasurement } from './audio-finishing-types';

export interface DecodedAudioPcm { samples: Float32Array; frames: number; channels: number; sampleRate: number }
const db = (amplitude: number): number | null => amplitude > 0 ? 20 * Math.log10(amplitude) : null;

/** A strict float-PCM WAV reader; FFmpeg's WAVE_FORMAT_EXTENSIBLE output is supported. */
export function decodeAudioPcm(input: Uint8Array): DecodedAudioPcm {
  if (!(input instanceof Uint8Array) || input.byteLength < 44 || input.byteLength > AUDIO_FINISH_MAX_BYTES) throw new Error('Audio finishing requires a PCM WAV smaller than 256 MiB.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Audio finishing requires a float PCM WAV.');
  let channels = 0; let sampleRate = 0; let data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4); const start = offset + 8;
    if (start + size > bytes.length) throw new Error('The PCM WAV is incomplete.');
    if (type === 'fmt ') {
      if (channels || size < 16) throw new Error('Invalid PCM WAV format.');
      let format = bytes.readUInt16LE(start);
      if (format === 65534 && size >= 40) format = bytes.readUInt16LE(start + 24);
      channels = bytes.readUInt16LE(start + 2); sampleRate = bytes.readUInt32LE(start + 4);
      if (format !== 3 || bytes.readUInt16LE(start + 14) !== 32 || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || bytes.readUInt16LE(start + 12) !== channels * 4) throw new Error('Audio finishing requires mono or stereo 32-bit float PCM at 8–192 kHz.');
    } else if (type === 'data') { if (data) throw new Error('Multiple PCM data chunks are unsupported.'); data = bytes.subarray(start, start + size); }
    offset = start + size + (size % 2);
  }
  if (!channels || !data || !data.length || data.length % (channels * 4)) throw new Error('The PCM WAV has no complete audio samples.');
  const frames = data.length / (channels * 4);
  if (frames / sampleRate > AUDIO_FINISH_MAX_SECONDS + 1 / sampleRate) throw new Error('Audio finishing supports up to ten minutes per operation.');
  const samples = new Float32Array(data.length / 4);
  for (let index = 0; index < samples.length; index++) {
    const value = data.readFloatLE(index * 4);
    if (!Number.isFinite(value)) throw new Error('Audio samples must be finite.');
    samples[index] = value;
  }
  return { samples, frames, channels, sampleRate };
}

/** Sample-domain evidence for review; LUFS and true peak are supplied separately by the bundled meter. */
export function measureAudioPcm(pcm: DecodedAudioPcm): AudioPcmMeasurement {
  let peak = 0; let energy = 0; let fullScaleSamples = 0;
  const blockFrames = Math.max(1, Math.round(pcm.sampleRate * 0.02));
  const silenceSpans: Array<{ start: number; end: number }> = [];
  let silentFrom: number | undefined;
  const closeSilence = (end: number): void => {
    if (silentFrom !== undefined && end - silentFrom >= 0.3 && silenceSpans.length < 1000) silenceSpans.push({ start: silentFrom, end });
    silentFrom = undefined;
  };
  for (let first = 0; first < pcm.frames; first += blockFrames) {
    const last = Math.min(pcm.frames, first + blockFrames); let blockEnergy = 0;
    for (let index = first * pcm.channels; index < last * pcm.channels; index++) {
      const value = pcm.samples[index]; const magnitude = Math.abs(value);
      peak = Math.max(peak, magnitude); energy += value * value; blockEnergy += value * value;
      if (magnitude >= 1) fullScaleSamples++;
    }
    const silent = Math.sqrt(blockEnergy / ((last - first) * pcm.channels)) < 0.001;
    if (silent) silentFrom ??= first / pcm.sampleRate; else closeSilence(first / pcm.sampleRate);
  }
  closeSilence(pcm.frames / pcm.sampleRate);
  return { duration: pcm.frames / pcm.sampleRate, frames: pcm.frames, sampleRate: pcm.sampleRate, channels: pcm.channels, samplePeakDb: db(peak), rmsDb: db(Math.sqrt(energy / pcm.samples.length)), fullScaleSamples, silenceSpans };
}
