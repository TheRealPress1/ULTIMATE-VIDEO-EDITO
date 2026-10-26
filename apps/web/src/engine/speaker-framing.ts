import type { SpeakerAnalysisResult, SpeakerFace, SpeakerReason, SpeakerSample } from '@desktop/speaker-types';
import type { ReframeVideo } from './reframe-plan';
import { validateSpeakerFraming, type SpeakerFramingOptions } from './speaker-framing-options';

export interface SpeakerCropKey { time: number; x: number; y: number; scale: number; cut: boolean; state: string }
export interface SpeakerCropPlan {
  width: number; height: number; keys: SpeakerCropKey[];
  coverage: number; switches: number; analyzedSeconds: number; fallbackSeconds: number;
  /** Positive model evidence, independent of the camera decision and manual preferences. */
  evidenceSeconds: number;
  /** Automatic close framing supported by a previously trusted visible track. */
  heldSeconds: number;
  /** Full-frame camera decisions, including an explicit wide preference. */
  wideSeconds: number;
  /** Explicit left/right/wide/hold decisions; may overlap wideSeconds. */
  manualSeconds: number;
  fallbackRanges: Array<{ start: number; end: number; reason: SpeakerReason }>;
}
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const validFace = (face: SpeakerFace) => !!face.trackId &&
  [face.x, face.y, face.width, face.height, face.confidence].every(Number.isFinite) && face.confidence >= 0.5 &&
  face.width > 0 && face.height > 0 && face.x >= 0 && face.y >= 0 && face.x + face.width <= 1.001 && face.y + face.height <= 1.001;

/** Preserve switches/cuts while bounding coordinate error in quieter sections. */
export function simplifySpeakerKeys(keys: readonly SpeakerCropKey[], pixelWidth: number, pixelHeight: number, tolerance = 3, preserve: ReadonlySet<number> = new Set()): SpeakerCropKey[] {
  if (keys.length <= 2) return [...keys];
  const keep = new Set<number>([0, keys.length - 1]);
  for (let i = 0; i < keys.length; i++) if (preserve.has(keys[i]!.time)) keep.add(i);
  for (let i = 1; i < keys.length; i++) if (keys[i]!.cut || keys[i]!.state !== keys[i - 1]!.state) { keep.add(i - 1); keep.add(i); }
  const anchors = [...keep].sort((a, b) => a - b), stack: Array<[number, number]> = [];
  for (let i = 1; i < anchors.length; i++) stack.push([anchors[i - 1]!, anchors[i]!]);
  while (stack.length) {
    const [first, last] = stack.pop()!; if (last - first < 2) continue;
    const a = keys[first]!, b = keys[last]!; let worst = tolerance, index = -1;
    for (let i = first + 1; i < last; i++) {
      const k = keys[i]!, t = (k.time - a.time) / Math.max(1e-9, b.time - a.time);
      const deltaScale = Math.abs(k.scale - (a.scale + (b.scale - a.scale) * t));
      const error = Math.max(Math.abs(k.x - (a.x + (b.x - a.x) * t)), Math.abs(k.y - (a.y + (b.y - a.y) * t)), deltaScale * pixelWidth, deltaScale * pixelHeight);
      if (error > worst) { worst = error; index = i; }
    }
    if (index !== -1) { keep.add(index); stack.push([first, index], [index, last]); }
  }
  return [...keep].sort((a, b) => a - b).map((i) => ({ ...keys[i]! }));
}

type Camera = { x: number; y: number; scale: number };
type AutomaticSection = Camera & {
  start: number; end: number; cut: boolean; state: string;
  analyzed: boolean; evidence: boolean; held: boolean; wide: boolean; reason: SpeakerReason;
};
const faceCenter = (face: SpeakerFace) => ({ x: face.x + face.width / 2, y: face.y + face.height / 2 });
/** Anonymous tracks can be lost or recycled. A matching ID alone cannot justify a camera jump. */
const continuousFace = (previous: SpeakerFace | undefined, next: SpeakerFace): boolean => {
  if (!previous) return true;
  const a = faceCenter(previous), b = faceCenter(next);
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  const sizeRatio = Math.sqrt(next.width * next.height / (previous.width * previous.height));
  return distance <= Math.max(0.12, Math.min(0.3, Math.sqrt(previous.width * previous.height) * 1.5)) && sizeRatio >= 0.5 && sizeRatio <= 2;
};
const visibleSpeaker = (sample: SpeakerSample): SpeakerFace | undefined => sample.reason === 'speaker' && sample.activeTrackId !== null
  ? sample.faces.find((face) => face.trackId === sample.activeTrackId && validFace(face) && Number.isFinite(face.speakingScore) && face.speakingScore! > 0) : undefined;

/**
 * Camera decisions use scored evidence; holding a visible track never creates new
 * speaker evidence. All keys/ranges/metrics use source seconds. Only stability
 * budgets are measured in output seconds so a sped-up clip behaves consistently.
 */
export function planSpeakerFraming(video: ReframeVideo, width: number, height: number, result: SpeakerAnalysisResult | undefined, fps: number,
  options: SpeakerFramingOptions & { playbackRate?: number } = {}): SpeakerCropPlan {
  validateSpeakerFraming(options, 'speakers');
  const rate = options.playbackRate ?? 1;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('Speaker framing needs a positive playback rate and frame rate.');
  const cover = Math.max(width / video.asset.width, height / video.asset.height);
  const vw = video.asset.width * cover, vh = video.asset.height * cover;
  const fit = Math.min(width / vw, height / vh);
  const wide: Camera = { x: (width - vw * fit) / 2, y: (height - vh * fit) / 2, scale: fit };
  const interval = result && Number.isFinite(result.sampleInterval) && result.sampleInterval > 0 ? result.sampleInterval : 0.5;
  const samples = (result?.samples ?? []).filter((sample) => Number.isFinite(sample.time) && sample.time >= video.start - 1 / fps && sample.time < video.end)
    .sort((a, b) => a.time - b.time).filter((sample, index, list) => !index || sample.time > list[index - 1]!.time);
  const automatic: AutomaticSection[] = [];
  let selected: string | null = null, candidate: string | null = null, candidateSince = 0, candidateCount = 0;
  let reliableUntil = -Infinity, silenceSince = Infinity, lastFace: SpeakerFace | undefined;
  let center = { x: 0.5, y: 0.5 }, position = wide;
  const reset = () => { selected = null; candidate = null; candidateCount = 0; reliableUntil = -Infinity; silenceSince = Infinity; lastFace = undefined; position = wide; };
  const crop = (point: { x: number; y: number }): Camera => ({ x: clamp(width / 2 - point.x * vw, width - vw, 0), y: clamp(height * 0.4 - point.y * vh, height - vh, 0), scale: 1 });
  const follow = (face: SpeakerFace, initial = false) => {
    const target = faceCenter(face);
    if (initial) center = target;
    else {
      // Small head movements should not produce a constantly moving camera.
      if (Math.abs(target.x - center.x) > 0.015) center.x += (target.x - center.x) * 0.65;
      if (Math.abs(target.y - center.y) > 0.015) center.y += (target.y - center.y) * 0.65;
    }
    lastFace = face; position = crop(center);
  };
  const unknown = (start: number, end: number) => {
    if (end > start) automatic.push({ ...wide, start, end, cut: false, state: 'wide', analyzed: false, evidence: false, held: false, wide: true, reason: 'uncertain' });
    reset();
  };
  let cursor = video.start;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!, start = Math.max(video.start, sample.time);
    const end = Math.min(video.end, sample.time + interval, samples[index + 1]?.time ?? Infinity);
    if (end <= start) continue;
    if (start > cursor + 1e-6) unknown(cursor, start);
    if (sample.cut) reset();
    const evidence = visibleSpeaker(sample);
    let tracked = selected ? sample.faces.find((face) => face.trackId === selected && validFace(face)) : undefined;
    if (tracked && !continuousFace(lastFace, tracked)) { reset(); tracked = undefined; }
    if (sample.reason === 'overlap' || sample.reason === 'no-visible-speaker') reset();
    else {
      if (sample.reason === 'silence') silenceSince = Math.min(silenceSince, start);
      else silenceSince = Infinity;
      if (evidence) {
        if (candidate !== evidence.trackId) { candidate = evidence.trackId; candidateSince = start; candidateCount = 1; }
        else candidateCount++;
        const wait = (selected === null ? 0.5 : 1) * rate;
        if (selected !== evidence.trackId && candidateCount >= 2 && start - candidateSince >= wait - 1e-6) {
          selected = evidence.trackId; follow(evidence, true); tracked = evidence;
        }
        if (selected === evidence.trackId) { follow(evidence); tracked = evidence; reliableUntil = end; }
      } else { candidate = null; candidateCount = 0; }
    }
    const supported = !!evidence && selected === evidence.trackId;
    let held = false, holdUntil = Infinity;
    if (!supported && selected !== null) {
      // A visible, continuous track may bridge brief uncertain model scores.
      // Never use a different/large face to fill a lost track.
      if (tracked && continuousFace(lastFace, tracked)) {
        holdUntil = Math.min(reliableUntil + 2 * rate, silenceSince + rate);
        if (start < holdUntil - 1e-6) { follow(tracked); held = true; }
        else reset();
      } else reset();
    }
    const isWide = selected === null;
    const sectionEnd = held ? Math.min(end, holdUntil) : end;
    const reason = sample.reason === 'speaker' ? 'uncertain' : sample.reason;
    automatic.push({ ...position, start, end: sectionEnd, cut: sample.cut, state: isWide ? 'wide' : selected!, analyzed: true, evidence: !!evidence, held, wide: isWide, reason });
    if (sectionEnd < end - 1e-6) {
      reset();
      automatic.push({ ...wide, start: sectionEnd, end, cut: false, state: 'wide', analyzed: true, evidence: !!evidence, held: false, wide: true, reason });
    }
    cursor = end;
  }
  if (cursor < video.end) unknown(cursor, video.end);
  if (!automatic.length) unknown(video.start, video.end);

  const overrides = [...(options.overrides ?? [])].filter((range) => range.end > video.start && range.start < video.end).sort((a, b) => a.start - b.start);
  type SidePoint = SpeakerCropKey & { wide: boolean };
  const sideCurve = (preference: 'left' | 'right', from: number, through: number): SidePoint[] => {
    // Only real observations advance smoothing. The first following observation
    // lets an ending range evaluate its camera exactly between sample slots.
    const stop = samples.find((sample) => sample.time > through)?.time ?? through;
    const times = [...new Set([from, ...samples.flatMap((sample, index) => {
      const values = sample.time > from && sample.time <= stop ? [sample.time] : [];
      const gap = sample.time + interval;
      if (gap > from && gap < Math.min(stop, samples[index + 1]?.time ?? Infinity) - 1e-7) values.push(gap);
      return values;
    })])].sort((a, b) => a - b);
    let sampleIndex = -1, selected: string | null = null, previous: SpeakerFace | undefined, lost = false;
    let center = { x: 0.5, y: 0.5 };
    const points: SidePoint[] = [];
    for (const time of times) {
      while (sampleIndex + 1 < samples.length && samples[sampleIndex + 1]!.time <= time + 1e-7) sampleIndex++;
      const sample = samples[sampleIndex], cut = !!sample?.cut && Math.abs(sample.time - time) < 1e-7;
      const faces = sample && time < sample.time + interval - 1e-7 ? sample.faces.filter(validFace) : [];
      if (cut) { selected = null; previous = undefined; lost = false; }
      if (selected === null && !lost) {
        const ordered = [...faces].sort((a, b) => faceCenter(a).x - faceCenter(b).x || a.trackId.localeCompare(b.trackId));
        const first = preference === 'left' ? ordered[0] : ordered.at(-1);
        if (first) { selected = first.trackId; center = faceCenter(first); }
      }
      const face = faces.find((candidate) => candidate.trackId === selected);
      if (face && !continuousFace(previous, face)) lost = true;
      if (face && !lost) {
        const target = faceCenter(face);
        if (Math.abs(target.x - center.x) > 0.015) center.x += (target.x - center.x) * 0.65;
        if (Math.abs(target.y - center.y) > 0.015) center.y += (target.y - center.y) * 0.65;
        previous = face;
        points.push({ ...crop(center), time, cut, state: `manual-${preference}:${selected}`, wide: false });
      } else points.push({ ...wide, time, cut, state: `manual-${preference}:missing`, wide: true });
    }
    const wideByTime = new Map(points.map((point) => [point.time, point.wide]));
    return simplifySpeakerKeys(points, vw, vh).map((point) => ({ ...point, wide: wideByTime.get(point.time)! }));
  };
  const globalSide = options.preference === 'left' || options.preference === 'right' ? sideCurve(options.preference, video.start, video.end) : undefined;
  const sideRanges = new Map(overrides.flatMap((range, index) => range.preference === 'left' || range.preference === 'right'
    ? [[index, sideCurve(range.preference, Math.max(video.start, range.start), Math.min(video.end, range.end))] as const] : []));
  const sideTimes = new Map([...(globalSide ? [globalSide] : []), ...sideRanges.values()].map((curve) => [curve, new Set(curve.map((point) => point.time))]));
  const evaluateSide = (curve: SidePoint[], time: number): SidePoint => {
    let low = 0, high = curve.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (curve[mid]!.time <= time + 1e-7) low = mid; else high = mid - 1; }
    const previous = curve[low]!, next = curve[low + 1];
    if (!next || next.cut || time <= previous.time) return previous;
    const blend = (time - previous.time) / (next.time - previous.time);
    return { ...previous, x: previous.x + (next.x - previous.x) * blend, y: previous.y + (next.y - previous.y) * blend, scale: previous.scale + (next.scale - previous.scale) * blend };
  };
  const correctionBoundaries = new Set(overrides.flatMap((range) => [range.start, range.end]).filter((time) => time > video.start && time < video.end));
  const events = [...new Set([video.start, video.end, ...automatic.map((section) => section.start),
    ...overrides.flatMap((range) => [Math.max(video.start, range.start), Math.min(video.end, range.end)]),
    ...[...correctionBoundaries].map((time) => Math.max(video.start, time - rate / fps))])].sort((a, b) => a - b);
  const keys: SpeakerCropKey[] = [], fallbackRanges: SpeakerCropPlan['fallbackRanges'] = [], pinned = new Set<number>();
  let sectionIndex = 0, previousPreference = '', previousControl = '', previousSide: SidePoint[] | undefined;
  let frozen = wide, lastPosition = wide, lastState = 'wide', lastWide = true;
  let evidenceSeconds = 0, analyzedSeconds = 0, heldSeconds = 0, wideSeconds = 0, manualSeconds = 0, switches = 0;
  let lastAutomaticTrack: string | null = null;
  const addFallback = (start: number, end: number, reason: SpeakerReason) => {
    const last = fallbackRanges.at(-1);
    if (last?.reason === reason && Math.abs(last.end - start) < 1e-6) last.end = end;
    else fallbackRanges.push({ start, end, reason });
  };
  for (let index = 0; index + 1 < events.length; index++) {
    const time = events[index]!, end = events[index + 1]!, seconds = end - time;
    if (seconds <= 0) continue;
    while (sectionIndex + 1 < automatic.length && automatic[sectionIndex + 1]!.start <= time + 1e-7) sectionIndex++;
    const section = automatic[sectionIndex]!, next = automatic[sectionIndex + 1];
    const shotCut = section.cut && Math.abs(section.start - time) < 1e-7;
    const cut = shotCut || correctionBoundaries.has(time);
    const overrideIndex = overrides.findIndex((range) => time >= range.start && time < range.end);
    const preference = overrides[overrideIndex]?.preference ?? options.preference ?? 'auto';
    const control = overrideIndex < 0 ? 'global' : `range:${overrideIndex}`;
    const controlChanged = preference !== previousPreference || control !== previousControl;
    let camera: Camera = section, state = section.state, isWide = section.wide, held = section.held;
    // Manual range boundaries can fall between sampling slots. Freeze the
    // evaluated camera at that boundary, not an earlier sampling timestamp.
    if (time > section.start && next && !next.cut) {
      const blend = (time - section.start) / (next.start - section.start);
      camera = { x: section.x + (next.x - section.x) * blend, y: section.y + (next.y - section.y) * blend, scale: section.scale + (next.scale - section.scale) * blend };
    }
    if (preference === 'hold') {
      if (shotCut) { frozen = wide; lastWide = true; lastState = 'wide'; }
      else if (controlChanged) {
        const manual = previousSide ? evaluateSide(previousSide, time) : undefined;
        frozen = manual ?? (previousPreference === 'auto' || previousPreference === '' ? camera : lastPosition);
        lastWide = manual?.wide ?? (previousPreference === 'auto' || previousPreference === '' ? section.wide : lastWide);
        lastState = manual?.state ?? (previousPreference === 'auto' || previousPreference === '' ? section.state : lastState);
      }
      camera = frozen; isWide = lastWide; state = `hold:${lastState}`; held = false;
    } else if (preference === 'wide') { camera = wide; isWide = true; state = 'manual-wide'; held = false; }
    else if (preference === 'left' || preference === 'right') {
      const curve = overrideIndex < 0 ? globalSide! : sideRanges.get(overrideIndex)!;
      const evaluated = evaluateSide(curve, time);
      camera = evaluated; state = evaluated.state; isWide = evaluated.wide; held = false;
      // Keep the shared curve anchors so adding a correction cannot alter the
      // original side-following motion outside that correction's range.
      if (sideTimes.get(curve)!.has(time)) pinned.add(Math.round(time * fps) / fps);
      previousSide = curve;
    }
    if (preference !== 'left' && preference !== 'right') previousSide = undefined;
    if (section.analyzed) analyzedSeconds += seconds;
    if (section.evidence) evidenceSeconds += seconds;
    if (held && preference === 'auto') heldSeconds += seconds;
    if (isWide) wideSeconds += seconds;
    if (preference !== 'auto') manualSeconds += seconds;
    if (preference === 'auto' && (section.wide || section.held)) addFallback(time, end, section.reason);
    if (preference === 'auto' && !isWide) {
      if (lastAutomaticTrack !== null && lastAutomaticTrack !== state && !shotCut) switches++;
      lastAutomaticTrack = state;
    } else lastAutomaticTrack = null;
    keys.push({ ...camera, time: Math.max(video.start, Math.min(video.end, Math.round(time * fps) / fps)), cut, state });
    lastPosition = camera; lastWide = isWide;
    if (preference !== 'hold') lastState = state;
    previousPreference = preference; previousControl = control;
  }
  if (!keys.length) keys.push({ ...wide, time: video.start, cut: false, state: 'wide' });
  if (keys.at(-1)!.time < video.end - 1 / fps) keys.push({ ...keys.at(-1)!, time: Math.max(video.start, video.end - 1 / fps), cut: false });
  // Quantizing two close correction boundaries can target the same frame. The
  // later decision wins, while a cut marker is never discarded.
  const unique: SpeakerCropKey[] = [];
  for (const key of keys) {
    const previous = unique.at(-1);
    if (previous?.time === key.time) unique[unique.length - 1] = { ...key, cut: previous.cut || key.cut };
    else unique.push(key);
  }
  return { width: vw, height: vh, keys: simplifySpeakerKeys(unique, vw, vh, 3, pinned), coverage: evidenceSeconds / Math.max(1e-9, analyzedSeconds),
    switches, analyzedSeconds, fallbackSeconds: heldSeconds + wideSeconds, evidenceSeconds, heldSeconds, wideSeconds, manualSeconds, fallbackRanges };
}
