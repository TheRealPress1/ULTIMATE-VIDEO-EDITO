import { describe, expect, it } from 'vitest';
import { dialogueActivity, musicDuckingGroup, planMusicDucking } from './audio-ducking';
import type { PcmResult } from '@/dapi/lib/audio-finish';
import type { AuthoredTree } from '@diffusionstudio/reconciler';

function pcm(seconds: number, signal: (time: number) => number): PcmResult {
  const sampleRate = 8000; const frames = seconds * sampleRate;
  return { sampleRate, frames, channels: 1, peak: 0, rms: 0, fullScaleSamples: 0, blocks: [{ frame: 0, channels: [Float32Array.from({ length: frames }, (_, index) => signal(index / sampleRate))] }] };
}

describe('editable dialogue-aware music ducking', () => {
  it('detects separate dialogue activity, preserves silent gaps and merges short breath gaps', () => {
    const spans = dialogueActivity(pcm(4, (time) => (time >= 0.5 && time < 1) || (time >= 1.2 && time < 1.5) || (time >= 3 && time < 3.5) ? 0.1 : 0));
    expect(spans).toEqual([{ start: 0.5, end: 1.5 }, { start: 3, end: 3.5 }]);
    expect(dialogueActivity(pcm(2, () => 0))).toEqual([]);
  });
  it('authors anticipation, holds dialogue attenuation and releases without timing reversal', () => {
    const points = planMusicDucking([{ start: 1, end: 2 }, { start: 2.8, end: 3.5 }], 5, 12);
    expect(points[0]).toEqual({ time: 0, value: 0 });
    expect(points.find((point) => Math.abs(point.time - 0.92) < 1e-9)?.value).toBe(-12);
    expect(points.find((point) => Math.abs(point.time - 2.18) < 1e-9)?.value).toBe(-12);
    expect(points.at(-1)).toEqual({ time: 5, value: 0 });
    expect(points.every((point, index) => index === 0 || point.time > points[index - 1].time)).toBe(true);
    expect(points.every((point) => point.value <= 0 && point.value >= -12)).toBe(true);
  });
  it('does not ramp music back up during dialogue that reaches the end', () => {
    const points = planMusicDucking([{ start: 0, end: 4 }], 4);
    expect(points).toEqual([{ time: 0, value: -12 }, { time: 4, value: -12 }]);
  });
  it('wraps background clips without modifying source offsets, playback rates, existing volume tracks or fades', () => {
    const clip: AuthoredTree = { tag: 'audio', props: { src: 'music.wav', start: 3, sourceIn: 9, playbackRate: 2, volume: -8 }, children: [
      { tag: 'animation', props: { type: 'gain', duration: 1 }, children: [] },
      { tag: 'keyframeTrack', props: { property: 'volume' }, children: [{ tag: 'keyframe', props: { time: 9, value: -8 }, children: [] }] },
    ] };
    const before = JSON.stringify(clip);
    const group = musicDuckingGroup([clip], planMusicDucking([{ start: 4, end: 6 }], 10), 10);
    expect(JSON.stringify(clip)).toBe(before);
    expect(group.children[0]).toBe(clip);
    expect(group.props).toMatchObject({ start: 0, end: 10, volume: 0 });
    expect(group.children[1].props.property).toBe('volume');
  });
  it('refuses invalid, unsorted or unbounded plans', () => {
    expect(() => planMusicDucking([{ start: 2, end: 3 }, { start: 0, end: 1 }], 4)).toThrow('ordered');
    expect(() => planMusicDucking([], 601)).toThrow('ten minutes');
    expect(() => dialogueActivity(pcm(1, () => 0), NaN)).toThrow('threshold');
  });
});
