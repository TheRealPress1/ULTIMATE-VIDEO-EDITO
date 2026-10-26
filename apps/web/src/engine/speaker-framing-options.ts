import type { ReframeVideo } from './reframe-plan';

/** Explicit editing preferences; they never count as detected speaker evidence. */
export type SpeakerFramingPreference = 'auto' | 'left' | 'right' | 'wide';
export interface SpeakerFramingOverride {
  /** Scene seconds at the public boundary; source seconds after per-clip mapping. */
  start: number;
  end: number;
  preference: SpeakerFramingPreference | 'hold';
}
export interface SpeakerFramingOptions {
  preference?: SpeakerFramingPreference;
  overrides?: readonly SpeakerFramingOverride[];
}

export interface SpeakerFramingSummary {
  coverage: number;
  switches: number;
  analyzedSeconds: number;
  fallbackSeconds: number;
  evidenceSeconds: number;
  heldSeconds: number;
  wideSeconds: number;
  manualSeconds: number;
}

/** Validate again at the editing boundary, including calls made outside DAPI. */
export function validateSpeakerFraming(options: SpeakerFramingOptions | undefined, mode: string, sceneEnd?: number): void {
  if (options === undefined) return;
  if (mode !== 'speakers') throw new Error('Framing preferences require speaker following.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Choose valid speaker framing preferences.');
  if (options.preference !== undefined && !['auto', 'left', 'right', 'wide'].includes(options.preference)) throw new Error('Choose automatic, left, right or wide framing.');
  if (options.overrides === undefined) return;
  if (!Array.isArray(options.overrides) || options.overrides.length > 100) throw new Error('Use at most 100 framing corrections.');
  let previousEnd = -Infinity;
  for (const range of [...options.overrides].sort((a, b) => (a?.start ?? NaN) - (b?.start ?? NaN))) {
    if (!range || ![range.start, range.end].every(Number.isFinite) || range.start < 0 || range.end <= range.start || !['auto', 'left', 'right', 'wide', 'hold'].includes(range.preference)) throw new Error('Each framing correction needs a valid start, end and framing preference.');
    if (range.start < previousEnd) throw new Error('Framing correction time ranges must not overlap.');
    if (sceneEnd !== undefined && range.end > sceneEnd + 1e-6) throw new Error('Framing corrections must stay within the selected scene.');
    previousEnd = range.end;
  }
}

/** Public corrections use scene seconds; camera keyframes always use source seconds. */
export function sourceSpeakerFraming(video: ReframeVideo, options?: SpeakerFramingOptions, fps = 30): SpeakerFramingOptions & { playbackRate: number } {
  const rate = video.timeline?.rate ?? video.playbackRate ?? 1;
  if (!options?.overrides?.length) return { ...options, playbackRate: rate };
  const clock = video.timeline;
  if (!clock) throw new Error('Resolve the video timeline before applying framing corrections.');
  // [start,end) means the first output frame at/after each boundary. Rounding
  // to the nearest frame could apply a correction before its requested start.
  const frameBoundary = (time: number) => Math.ceil(time * fps - 1e-7) / fps;
  const overrides = options.overrides.flatMap((range) => {
    const start = Math.max(clock.start, frameBoundary(range.start)), end = Math.min(clock.end, frameBoundary(range.end));
    return end > start ? [{ ...range, start: Math.max(video.start, (start - clock.origin) * rate), end: Math.min(video.end, (end - clock.origin) * rate) }] : [];
  });
  return { preference: options.preference, overrides, playbackRate: rate };
}
