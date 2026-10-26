import type { PcmResult } from '@/dapi/lib/audio-finish';
import type { AuthoredTree } from '@diffusionstudio/reconciler';

export interface AudioActivitySpan { start: number; end: number }
export interface DuckingPoint { time: number; value: number }

/** Energy activity, not speaker recognition: works best on an isolated dialogue mix. */
export function dialogueActivity(pcm: PcmResult, thresholdDb = -42): AudioActivitySpan[] {
  if (!Number.isFinite(thresholdDb) || thresholdDb < -70 || thresholdDb > -10) throw new Error('Dialogue detection threshold must be from −70 to −10 dBFS.');
  const windowFrames = Math.max(1, Math.round(pcm.sampleRate * 0.02));
  const count = Math.ceil(pcm.frames / windowFrames);
  const energy = new Float64Array(count);
  for (const block of pcm.blocks) for (const channel of block.channels) for (let index = 0; index < channel.length; index++) {
    const bin = Math.floor((block.frame + index) / windowFrames);
    energy[bin] += channel[index] ** 2;
  }
  const threshold = 10 ** (thresholdDb / 20);
  const spans: AudioActivitySpan[] = [];
  let start: number | undefined;
  for (let bin = 0; bin <= count; bin++) {
    const frames = Math.max(1, Math.min(windowFrames, pcm.frames - bin * windowFrames));
    const active = bin < count && Math.sqrt(energy[bin] / (frames * pcm.channels)) >= threshold;
    if (active) start ??= bin * windowFrames / pcm.sampleRate;
    else if (start !== undefined) {
      const end = Math.min(pcm.frames / pcm.sampleRate, bin * windowFrames / pcm.sampleRate);
      if (end - start >= 0.04) {
        const previous = spans.at(-1);
        if (previous && start - previous.end <= 0.35) previous.end = end;
        else spans.push({ start, end });
      }
      start = undefined;
    }
  }
  return spans;
}

/** Scene-local editable dB curve, with anticipation and a gentle release. */
export function planMusicDucking(spans: readonly AudioActivitySpan[], duration: number, amountDb = 12): DuckingPoint[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600 || !Number.isFinite(amountDb) || amountDb < 0 || amountDb > 30) throw new Error('Choose up to 30 dB of ducking on a scene up to ten minutes.');
  const merged: AudioActivitySpan[] = [];
  let previousStart = -1;
  for (const span of spans) {
    if (![span.start, span.end].every(Number.isFinite) || span.start < 0 || span.end < span.start || span.end > duration + 0.05) throw new Error('Invalid dialogue activity timing.');
    if (span.start < previousStart) throw new Error('Dialogue activity must be ordered by time.');
    previousStart = span.start;
    const start = Math.max(0, span.start - 0.08); const end = Math.min(duration, span.end + 0.18);
    const previous = merged.at(-1);
    if (previous && start - 0.08 <= previous.end + 0.45) previous.end = Math.max(previous.end, end);
    else merged.push({ start, end });
  }
  const points: DuckingPoint[] = [{ time: 0, value: 0 }];
  const push = (time: number, value: number): void => {
    const last = points.at(-1)!;
    if (Math.abs(time - last.time) < 1e-6) last.value = value;
    else points.push({ time, value });
  };
  for (const span of merged) {
    push(Math.max(0, span.start - 0.08), 0);
    push(span.start, -amountDb);
    push(span.end, -amountDb);
    if (span.end < duration) push(Math.min(duration, span.end + 0.45), 0);
  }
  if (points.at(-1)!.time < duration) push(duration, 0);
  if (points.length > 2000) throw new Error('The scene needs too many ducking keyframes. Use a shorter scene.');
  return points;
}

/** A parent bus multiplies existing clip volumes, keyframes and fades without replacing any of them. */
export function musicDuckingGroup(clips: AuthoredTree[], points: readonly DuckingPoint[], duration: number): AuthoredTree {
  return { tag: 'group', props: { name: 'Music ducking · adjust volume keyframes', start: 0, end: duration, volume: 0 }, children: [
    ...clips,
    { tag: 'keyframeTrack', props: { property: 'volume' }, children: points.map((point) => ({ tag: 'keyframe', props: { time: point.time, value: point.value, easing: 'linear' }, children: [] })) },
  ] };
}
