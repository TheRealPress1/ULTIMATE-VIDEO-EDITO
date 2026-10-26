import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalAudioFinishingService, parseLoudnessReport } from './audio-finishing';
import { decodeAudioPcm, measureAudioPcm } from './audio-pcm';

const binary = join(process.cwd(), 'dist/audio-tools/ffmpeg');
const available = await access(binary).then(() => true, () => false);
function wav(seconds: number, sample: (time: number, index: number) => number, sampleRate = 48000): Uint8Array {
  const frames = Math.round(seconds * sampleRate); const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(3, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(32, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let index = 0; index < frames; index++) data.writeFloatLE(sample(index / sampleRate, index), 44 + index * 4);
  return new Uint8Array(data);
}

describe('bounded audio PCM evidence', () => {
  it('distinguishes silence, sample clipping and invalid samples', () => {
    const measurement = measureAudioPcm(decodeAudioPcm(wav(2, (time) => time < 0.5 || time > 1.2 ? 0 : 1.1)));
    expect(measurement.fullScaleSamples).toBeGreaterThan(0);
    expect(measurement.silenceSpans).toEqual([{ start: 0, end: 0.5 }, { start: 1.22, end: 2 }]);
    expect(measureAudioPcm(decodeAudioPcm(wav(1, () => 0)))).toMatchObject({ samplePeakDb: null, rmsDb: null });
    expect(() => decodeAudioPcm(wav(0.1, () => NaN))).toThrow('finite');
  });
  it('refuses incomplete WAV and incomplete meter reports', () => {
    expect(() => decodeAudioPcm(wav(1, () => 0).subarray(0, 80))).toThrow('incomplete');
    expect(() => parseLoudnessReport('{"input_i":"oops"}')).toThrow('invalid');
    expect(() => parseLoudnessReport('no report')).toThrow('complete');
  });
});

describe.skipIf(!available)('bundled standard loudness and finishing', () => {
  it('measures a calibrated 1 kHz tone and intersample true peaks separately from sample peak', async () => {
    const service = new LocalAudioFinishingService({ runtimePath: binary });
    const tone = await service.run({ id: randomUUID(), action: 'measure', wav: wav(4, (time) => 0.1 * Math.sin(2 * Math.PI * 1000 * time)) });
    expect(tone.input.integratedLufs).toBeCloseTo(-23.05, 0);
    expect(tone.input.samplePeakDb).toBeCloseTo(-20, 2);
    const high = await service.run({ id: randomUUID(), action: 'measure', wav: wav(4, (time) => 0.9 * Math.sin(2 * Math.PI * 12000 * time + Math.PI / 4)) });
    expect(high.input.truePeakDb! - high.input.samplePeakDb!).toBeGreaterThan(2);
    service.dispose();
  });
  it('normalizes the actual derivative to its measured LUFS and true-peak ceiling with identical timing', async () => {
    const service = new LocalAudioFinishingService({ runtimePath: binary });
    const input = wav(5, (time) => 0.03 * Math.sin(2 * Math.PI * 1000 * time));
    const before = Buffer.from(input).toString('base64');
    const result = await service.run({ id: randomUUID(), action: 'finish', wav: input, targetLufs: -16, truePeakDb: -1 });
    expect(result.output!.integratedLufs).toBeCloseTo(-16, 0);
    expect(result.output!.truePeakDb!).toBeLessThanOrEqual(-0.9);
    expect(result.output!.frames).toBe(result.input.frames);
    expect(decodeAudioPcm(result.wav!).frames).toBe(240000);
    expect(Buffer.from(input).toString('base64')).toBe(before);
    service.dispose();
  });
  it('levels unequal speech-like sections and reduces stationary noise while preserving exact sample count', async () => {
    const service = new LocalAudioFinishingService({ runtimePath: binary });
    let seed = 17;
    const input = wav(12, (time) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff - 0.5) * 0.005;
      return noise + (time >= 1 && time < 5 ? 0.02 : time >= 7 && time < 11 ? 0.2 : 0) * Math.sin(2 * Math.PI * 220 * time);
    });
    const leveled = await service.run({ id: randomUUID(), action: 'finish', wav: input, levelDialogue: true, denoise: true, targetLufs: -20, truePeakDb: -1 });
    const pcm = decodeAudioPcm(leveled.wav!);
    const rms = (start: number, end: number): number => Math.sqrt(pcm.samples.slice(start * pcm.sampleRate, end * pcm.sampleRate).reduce((sum, value) => sum + value * value, 0) / ((end - start) * pcm.sampleRate));
    expect(20 * Math.log10(rms(8, 10) / rms(2, 4))).toBeLessThan(18);
    expect(pcm.frames).toBe(12 * 48000);
    expect(leveled.output!.truePeakDb!).toBeLessThanOrEqual(-0.9);
    const noisy = wav(5, (time, index) => (index * 1664525 % 7919 / 7919 - 0.5) * 0.002 + (time > 1 && time < 4 ? 0.1 * Math.sin(2 * Math.PI * 400 * time) : 0));
    const plain = await service.run({ id: randomUUID(), action: 'finish', wav: noisy, targetLufs: -20 });
    const denoised = await service.run({ id: randomUUID(), action: 'finish', wav: noisy, targetLufs: -20, denoise: true });
    const quietEnergy = (bytes: Uint8Array) => decodeAudioPcm(bytes).samples.slice(24000, 40000).reduce((sum, value) => sum + value * value, 0);
    expect(quietEnergy(denoised.wav!)).toBeLessThan(quietEnergy(plain.wav!));
    service.dispose();
  });
  it('does not create a result for silence and cancels a running native job', async () => {
    const service = new LocalAudioFinishingService({ runtimePath: binary });
    await expect(service.run({ id: randomUUID(), action: 'finish', wav: wav(1, () => 0) })).rejects.toThrow('loudness gate');
    const id = randomUUID();
    const pending = service.run({ id, action: 'finish', wav: wav(30, (time) => 0.1 * Math.sin(time * 500)) });
    service.cancel(id);
    await expect(pending).rejects.toThrow('canceled');
    service.dispose();
  });
  it('compensates denoiser window delay at 48 and 44.1 kHz without cutting the final speech', async () => {
    const service = new LocalAudioFinishingService({ runtimePath: binary });
    for (const rate of [48000, 44100]) {
      const input = wav(4, (time) => (time >= 1 && time < 2 || time >= 3.9 ? 0.1 * Math.sin(2 * Math.PI * 440 * time) : 0), rate);
      const result = await service.run({ id: randomUUID(), action: 'finish', wav: input, denoise: true, levelDialogue: true, targetLufs: -20 });
      const pcm = decodeAudioPcm(result.wav!);
      const peak = pcm.samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      const onset = pcm.samples.findIndex((value) => Math.abs(value) > peak * .1) / rate;
      expect(onset).toBeGreaterThan(.995);
      expect(onset).toBeLessThan(1.005);
      expect(pcm.frames).toBe(4 * rate);
      const finalEnergy = pcm.samples.subarray(Math.round(3.995 * rate)).reduce((sum, value) => sum + value * value, 0);
      expect(finalEnergy).toBeGreaterThan(.01);
    }
    service.dispose();
  });
});
