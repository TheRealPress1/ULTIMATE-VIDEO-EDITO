import { describe, expect, it } from 'vitest';
import type { SpeakerAnalysisResult, SpeakerFace, SpeakerSample } from '@desktop/speaker-types';
import type { VideoAsset } from '@diffusionstudio/assets';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import { planSpeakerFraming, simplifySpeakerKeys } from './speaker-framing';
import { collectReframeVideos, planReframeVariants } from './reframe-plan';
const asset = { id: 'interview', path: 'Interview.mp4', source: '/Interview.mp4', type: 'VIDEO', width: 1920, height: 1080, duration: 7200 } as VideoAsset;
const video = { key: '0', path: asset.path, asset, start: 10, end: 16 };
const face = (trackId: string, x: number, width = 0.08): SpeakerFace => ({ trackId, x, y: 0.2, width, height: 0.2, confidence: 1, speakingScore: 3 });
const sample = (time: number, id: string | null, reason: SpeakerSample['reason'] = id ? 'speaker' : 'uncertain', cut = false): SpeakerSample => ({ time, activeTrackId: id, reason, cut, audioRms: 0.1, faces: [face('left', 0.15, 0.2), face('right', 0.8)] });
const result = (samples: SpeakerSample[]): SpeakerAnalysisResult => ({ engine: 'test', fingerprint: 'a'.repeat(64), sourceStart: 0, start: 10, end: 16, width: 1920, height: 1080, sampleInterval: 0.5, warnings: [], resumedChunks: 0, totalChunks: 1, samples });
const at = (samples: SpeakerSample[]) => planSpeakerFraming(video, 1080, 1920, result(samples), 30);

describe('visible speaker camera planning', () => {
  it('follows the scored speaker even when another face is larger', () => {
    const plan = at([sample(10, 'right'), sample(10.5, 'right'), sample(11, 'right')]);
    const close = plan.keys.find((k) => k.time === 10.5)!;
    expect(close.scale).toBe(1);
    expect(close.x).toBeLessThan(-2000);
    expect(plan.coverage).toBe(1);
  });
  it('ignores one-sample speaker flicker then switches after sustained evidence', () => {
    const plan = at([sample(10, 'left'), sample(10.5, 'left'), sample(11, 'right'), sample(11.5, 'left'), sample(12, 'right'), sample(12.5, 'right'), sample(13, 'right')]);
    expect(plan.switches).toBe(1);
    expect(plan.keys.some((key) => key.time === 11 && key.state === 'right')).toBe(false);
    expect(plan.keys.some((key) => key.time === 12.5 && key.state === 'right')).toBe(false);
    expect(plan.keys.some((key) => key.time === 13 && key.state === 'right')).toBe(true);
  });
  it('holds briefly then fits the full original for off-camera or uncertain speech', () => {
    const plan = at([sample(10, 'right'), sample(10.5, 'right'), sample(11, null), sample(11.5, null, 'no-visible-speaker'), sample(12, null)]);
    expect(plan.keys.find((k) => k.time === 11.5)?.scale).toBeCloseTo(1080 / plan.width);
    const wide = plan.keys.find((k) => k.time === 11.5)!;
    expect(wide.x).toBeCloseTo(0); expect(wide.y).toBeGreaterThan(0);
    expect(plan.fallbackSeconds).toBeGreaterThan(0);
  });
  it('uses full-frame fallback immediately for overlap, and resets at scene cuts', () => {
    const plan = at([sample(10, 'left'), sample(10.5, 'left'), sample(11, null, 'overlap'), sample(11.5, 'right', 'speaker', true), sample(12, 'right')]);
    expect(plan.keys.find((k) => k.time === 11)?.scale).toBeLessThan(1);
    expect(plan.keys.find((k) => k.time === 11.5)).toMatchObject({ cut: true, state: 'wide' });
    expect(plan.keys.find((k) => k.time === 12)?.state).toBe('right');
  });
  it('never substitutes largest-face following when audio/video evidence is missing', () => {
    const plan = at([sample(10, null), sample(10.5, null, 'silence')]);
    expect(plan.coverage).toBe(0); expect(plan.keys.every((k) => k.scale < 1)).toBe(true);
  });
  it('reduces a two-hour stationary shot to a few keyframes without losing boundaries', () => {
    const keys = Array.from({ length: 14400 }, (_, i) => ({ time: i * 0.5, x: -1000, y: 0, scale: 1, cut: false, state: 'person' }));
    keys[2000]!.cut = true;
    const reduced = simplifySpeakerKeys(keys, 3413, 1920);
    expect(reduced.length).toBeLessThanOrEqual(6);
    expect(reduced.some((k) => k.cut && k.time === 1000)).toBe(true);
    expect(reduced.at(-1)!.time).toBe(7199.5);
  });
  it('replaces an existing crop only in the new scene and retains captions and audio timing', () => {
    const scene: AuthoredTree = { tag: 'scene', props: { width: 1080, height: 1920, name: 'Already vertical' }, children: [
      { tag: 'video', props: { src: asset.path, width: 1920 * 1920 / 1080, height: 1920, x: -1200, y: 0, start: 4, end: 7, sourceIn: 10, playbackRate: 2, volume: -4 }, children: [{ tag: 'keyframeTrack', props: { property: 'x' }, children: [{ tag: 'keyframe', props: { time: 10, value: -1200 }, children: [] }] }] },
      { tag: 'captions', props: { src: 'Corrected words.json', preset: 'whisper', scale: 0.9072, sourceIn: 10, playbackRate: 2, start: 4 }, children: [] },
    ] };
    const before = JSON.stringify(scene), clips = collectReframeVideos(scene, () => asset, { replaceCrop: true });
    const plan = planReframeVariants(scene, clips, new Map(), { formats: ['vertical'], mode: 'speakers', fps: 30, speakerAnalyses: new Map([['0', result([sample(10, 'right'), sample(10.5, 'right'), sample(11, 'right')])]]) });
    const clip = plan.variants[0]!.tree.children[0]!;
    expect(clip.children.filter((c) => c.tag === 'keyframeTrack' && c.props.property === 'x')).toHaveLength(1);
    expect(clip.props).toMatchObject({ sourceIn: 10, start: 4, end: 7, playbackRate: 2, volume: -4 });
    expect(plan.variants[0]!.tree.children[1]!.props).toMatchObject({ src: 'Corrected words.json', sourceIn: 10, playbackRate: 2 });
    expect(JSON.stringify(scene)).toBe(before);
  });
});

it('can reframe an existing speaker version without duplicating its scale tracks', () => {
  const scene: AuthoredTree = { tag: 'scene', props: { width: 1920, height: 1080 }, children: [{ tag: 'video', props: { src: asset.path, width: 1920, height: 1080, sourceIn: 10, sourceOut: 16 }, children: [] }] };
  const options = { formats: ['vertical'] as const, mode: 'speakers' as const, fps: 30, speakerAnalyses: new Map([['0', result([sample(10, 'right'), sample(10.5, 'right')])]]) };
  const first = planReframeVariants(scene, collectReframeVideos(scene, () => asset), new Map(), options).variants[0]!.tree;
  const second = planReframeVariants(first, collectReframeVideos(first, () => asset, { replaceCrop: true }), new Map(), options).variants[0]!.tree;
  expect(second.children[0]!.children.filter((c) => c.props.property === 'scale')).toHaveLength(1);
});

const full = (states: Array<string | null>, start = 10) => states.map((id, index) => sample(start + index * 0.5, id));
const cameraAt = (plan: ReturnType<typeof planSpeakerFraming>, time: number) => {
  const previous = [...plan.keys].reverse().find((key) => key.time <= time)!;
  const next = plan.keys.find((key) => key.time > time);
  if (!next || next.cut || next.time === previous.time) return previous;
  const blend = (time - previous.time) / (next.time - previous.time);
  return { ...previous, x: previous.x + (next.x - previous.x) * blend, y: previous.y + (next.y - previous.y) * blend, scale: previous.scale + (next.scale - previous.scale) * blend };
};

describe('stable automatic speaker camera', () => {
  it('bridges two seconds of uncertain scores while the same trusted face remains visible', () => {
    const observations = full(['right', 'right', 'right', null, null, null, null, 'right', 'right', 'right', 'right', 'right']);
    for (const observation of observations) if (!observation.activeTrackId) observation.faces[1]!.speakingScore = -0.4;
    const plan = at(observations);
    expect(plan.coverage).toBeCloseTo(8 / 12);
    expect(plan.evidenceSeconds).toBe(4);
    expect(plan.heldSeconds).toBe(2);
    expect(plan.wideSeconds).toBe(0.5);
    expect(plan.manualSeconds).toBe(0);
    expect(plan.keys.filter((key) => key.time >= 10.5).every((key) => key.scale === 1)).toBe(true);
    expect(plan.switches).toBe(0);
  });
  it('stops holding after the budget and requires new sustained evidence to leave wide', () => {
    const plan = at(full(['right', 'right', null, null, null, null, null, null, 'right', null, 'right', 'right']));
    expect(cameraAt(plan, 13).scale).toBeLessThan(1);
    expect(plan.keys.some((key) => key.time === 14 && key.state === 'right')).toBe(false);
    expect(plan.keys.some((key) => key.time === 15.5 && key.state === 'right')).toBe(true);
    expect(plan.heldSeconds).toBe(2);
  });
  it('does not retain a missing face or reinterpret a different visible face as the speaker', () => {
    const observations = full(['right', 'right', null, null]);
    observations[2]!.faces = [face('left', 0.15, 0.4)];
    observations[3]!.faces = [face('left', 0.15, 0.4)];
    const plan = at(observations);
    expect(plan.keys.find((key) => key.time === 11)?.state).toBe('wide');
    expect(plan.heldSeconds).toBe(0);
    expect(plan.keys.some((key) => key.state === 'left')).toBe(false);
  });
  it('rejects a recycled track ID that jumps to another person and reacquires its new location', () => {
    const observations = full(['right', 'right', 'right', 'right', 'right']);
    for (const observation of observations.slice(2)) observation.faces[1] = face('right', 0.12);
    const plan = at(observations);
    expect(plan.keys.find((key) => key.time === 11)?.state).toBe('wide');
    expect(plan.keys.find((key) => key.time === 11.5)?.state).toBe('right');
    expect(cameraAt(plan, 11.5).x).toBeGreaterThan(-100);
  });
  it('allows a short breath but returns wide for sustained silence, overlap, and cuts', () => {
    const observations = full(['right', 'right', null, null, null, 'right', 'right', null, 'right', 'right']);
    observations[2]!.reason = 'silence'; observations[3]!.reason = 'silence'; observations[4]!.reason = 'silence';
    observations[7]!.reason = 'overlap'; observations[8]!.cut = true;
    const plan = at(observations);
    expect(cameraAt(plan, 11).scale).toBe(1);
    expect(plan.keys.find((key) => key.time === 12)?.state).toBe('wide');
    expect(plan.keys.find((key) => key.time === 13.5)?.state).toBe('wide');
    expect(plan.keys.find((key) => key.time === 14)).toMatchObject({ state: 'wide', cut: true });
    expect(plan.keys.find((key) => key.time === 14.5)?.state).toBe('right');
  });
  it('uses output-time stability budgets without adding the container origin to source keys', () => {
    const observations = full(['right', 'right', 'right', null, null, null, null, null, null, null, null, null, null, null, null, null]);
    const plan = planSpeakerFraming({ ...video, end: 18 }, 1080, 1920, { ...result(observations), sourceStart: 2.033 }, 30, { playbackRate: 2 });
    expect(plan.keys.find((key) => key.time === 11)?.state).toBe('right');
    expect(plan.keys.find((key) => key.time === 15.5)?.state).toBe('wide');
    expect(plan.heldSeconds).toBe(4);
    expect(plan.keys[0]!.time).toBe(10);
    expect(plan.keys.every((key) => key.time < 18)).toBe(true);
  });
  it('represents unobserved head/tail gaps as wide without claiming they were analyzed', () => {
    const plan = at(full(['right', 'right'], 11));
    expect(plan.analyzedSeconds).toBe(1);
    expect(plan.evidenceSeconds).toBe(1);
    expect(plan.wideSeconds).toBe(5.5);
    expect(plan.fallbackSeconds).toBe(5.5);
    expect(plan.fallbackRanges).toContainEqual({ start: 12, end: 16, reason: 'uncertain' });
  });
  it('does not create motion for a long steady shot with small detection jitter', () => {
    const observations = Array.from({ length: 14400 }, (_, index) => ({ ...sample(index * 0.5, 'right'), faces: [face('right', 0.7 + Math.sin(index) * 0.006)] }));
    const plan = planSpeakerFraming({ ...video, start: 0, end: 7200 }, 1080, 1920, { ...result(observations), start: 0, end: 7200 }, 30);
    expect(plan.keys.length).toBeLessThanOrEqual(4);
    expect(plan.keys.at(-1)!.time).toBeCloseTo(7200 - 1 / 30);
    expect(plan.evidenceSeconds).toBe(7200);
    expect(plan.heldSeconds).toBe(0);
  });
  it('keeps the current Rheesa score pattern stable without increasing detected coverage', () => {
    // Current native evidence: sporadic right-speaker positives, then a wide
    // group shot with different anonymous tracks at12.5s.
    const positives = new Set([4.5, 5.5, 6, 6.5, 7.5, 8, 8.5, 11, 11.5, 12]);
    const observations = Array.from({ length: 60 }, (_, index) => {
      const time = index * 0.5, detected = positives.has(time);
      return { ...sample(time, detected ? 'right' : null), faces: time < 12.5 ? [face('left', 0.25), { ...face('right', 0.65), speakingScore: detected ? 0.8 : -0.1 }] : [face('new-shot', 0.6)] };
    });
    const plan = planSpeakerFraming({ ...video, start: 0, end: 30 }, 1080, 1920, { ...result(observations), start: 0, end: 30 }, 30);
    expect(plan.coverage).toBeCloseTo(1 / 6);
    expect(plan.evidenceSeconds).toBe(5);
    expect(plan.heldSeconds).toBe(2.5);
    expect(plan.keys.filter((key, index) => !index || key.state !== plan.keys[index - 1]!.state).map((key) => [key.time, key.state])).toEqual([[0, 'wide'], [6, 'right'], [12.5, 'wide']]);
  });
});

describe('explicit framing preferences', () => {
  it('locks the selected screen-side track through crossings, without calling it detected evidence', () => {
    const observations = Array.from({ length: 10 }, (_, index) => ({ ...sample(10 + index * 0.5, null), faces: [
      { ...face('left-person', 0.15 + index * 0.05), speakingScore: null },
      { ...face('right-person', 0.8 - index * 0.05), speakingScore: null },
    ] }));
    const plan = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference: 'left' });
    expect(plan.keys.filter((key) => !key.state.endsWith(':missing')).every((key) => key.state === 'manual-left:left-person')).toBe(true);
    expect(cameraAt(plan, 14.5).x).toBeLessThan(-1000);
    expect(plan.coverage).toBe(0);
    expect(plan.evidenceSeconds).toBe(0);
    expect(plan.heldSeconds).toBe(0);
    expect(plan.manualSeconds).toBe(6);
  });
  it('keeps a missing manual target wide until that track returns or a cut starts a new shot', () => {
    const observations = full([null, null, null, null, null]);
    observations[2]!.faces = [face('left', 0.1, 0.5)];
    observations[3]!.faces = [face('left', 0.1, 0.5)];
    observations[4]!.faces = [face('new-right', 0.7)]; observations[4]!.cut = true;
    const plan = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference: 'right' });
    expect(plan.keys.find((key) => key.time === 11)?.state).toBe('manual-right:missing');
    expect(plan.keys.find((key) => key.time === 12)).toMatchObject({ state: 'manual-right:new-right', cut: true });
    expect(plan.evidenceSeconds).toBe(0);
  });
  it('holds the evaluated camera at a non-sample boundary and resets a held camera on cuts', () => {
    const observations = full(['right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']);
    observations[5]!.cut = true;
    const baseline = at(observations);
    const plan = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { overrides: [{ start: 10.25, end: 13.25, preference: 'hold' }] });
    const entered = plan.keys.find((key) => key.time === Math.round(10.25 * 30) / 30)!;
    expect(entered.scale).toBeCloseTo(cameraAt(baseline, 10.25).scale);
    expect(cameraAt(plan, 12).scale).toBeCloseTo(entered.scale);
    expect(plan.keys.find((key) => key.time === 12.5)).toMatchObject({ cut: true, state: 'hold:wide' });
    expect(plan.manualSeconds).toBe(3);
    expect(plan.evidenceSeconds).toBe(baseline.evidenceSeconds);
  });
  it('supports a wide preference and automatic ranges without changing source evidence metrics', () => {
    const observations = full(Array(12).fill('right'));
    const plan = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference: 'wide', overrides: [{ start: 11, end: 12, preference: 'auto' }] });
    expect(plan.manualSeconds).toBe(5);
    expect(plan.wideSeconds).toBe(5);
    expect(cameraAt(plan, 11.5).scale).toBe(1);
    expect(plan.evidenceSeconds).toBe(6);
    expect(plan.coverage).toBe(1);
  });
  it('can stay wide without analysis and rejects invalid overlapping corrections', () => {
    const plan = planSpeakerFraming(video, 1080, 1920, undefined, 30, { preference: 'wide' });
    expect(plan).toMatchObject({ coverage: 0, evidenceSeconds: 0, heldSeconds: 0, wideSeconds: 6, manualSeconds: 6, analyzedSeconds: 0 });
    expect(() => planSpeakerFraming(video, 1080, 1920, undefined, 30, { overrides: [{ start: 10, end: 12, preference: 'wide' }, { start: 11, end: 13, preference: 'hold' }] })).toThrow('overlap');
  });
});

it('contains manual corrections inside their exact frame boundaries', () => {
  const observations = full(Array(12).fill('right'));
  const baseline = at(observations);
  const plan = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { overrides: [{ start: 12, end: 14, preference: 'wide' }] });
  expect(cameraAt(plan, 12 - 1 / 30).scale).toBeCloseTo(cameraAt(baseline, 12 - 1 / 30).scale);
  expect(cameraAt(plan, 12).scale).toBeLessThan(0.5);
  expect(cameraAt(plan, 14 - 1 / 30).scale).toBeLessThan(0.5);
  expect(cameraAt(plan, 14).scale).toBe(1);
  expect(plan.keys.find((key) => key.time === 12)?.cut).toBe(true);
  expect(plan.keys.find((key) => key.time === 14)?.cut).toBe(true);
  expect(plan.manualSeconds).toBeCloseTo(2);
});

it('keeps held framing through its last output frame at double speed', () => {
  const observations = full(['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']);
  const plan = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { playbackRate: 2, overrides: [{ start: 11.5, end: 15, preference: 'hold' }] });
  const entered = cameraAt(plan, 11.5);
  expect(cameraAt(plan, 15 - 2 / 30).x).toBeCloseTo(entered.x);
  expect(cameraAt(plan, 15).x).toBeLessThan(entered.x - 1000);
  expect(plan.keys.some((key) => Math.abs(key.time - (15 - 2 / 30)) < 1e-6)).toBe(true);
});

it('reselects the requested side for a distinct adjacent override but preserves the global track through a temporary wide view', () => {
  const observations = Array.from({ length: 12 }, (_, index) => ({ ...sample(10 + index * 0.5, null), faces: [
    face('original-left', 0.15 + index * 0.05), face('original-right', 0.8 - index * 0.05),
  ] }));
  const ranges = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { overrides: [{ start: 10, end: 14, preference: 'left' }, { start: 14, end: 16, preference: 'left' }] });
  expect(ranges.keys.find((key) => key.time === 14)?.state).toBe('manual-left:original-right');
  const global = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference: 'left', overrides: [{ start: 11, end: 14, preference: 'wide' }] });
  expect(global.keys.find((key) => key.time === 14)?.state).toBe('manual-left:original-left');
});

it('fails wide when the global track jumps during a temporary override', () => {
  const observations = full(Array(12).fill(null));
  for (const observation of observations.slice(5)) observation.faces[0] = face('left', 0.75);
  const plan = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference: 'left', overrides: [{ start: 11, end: 14, preference: 'wide' }] });
  expect(plan.keys.find((key) => key.time === 14)?.state).toBe('manual-left:missing');
  expect(cameraAt(plan, 14).scale).toBeLessThan(0.5);
  expect(plan.evidenceSeconds).toBe(0);
});

it.each(['left', 'right'] as const)('does not change moving global %s framing outside a temporary correction', (preference) => {
  const observations = Array.from({ length: 12 }, (_, index) => ({ ...sample(10 + index * 0.5, null), faces: [
    face('left', 0.15 + index * 0.04), face('right', 0.8 - index * 0.035),
  ] }));
  const baseline = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference });
  const corrected = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference, overrides: [{ start: 11.2, end: 12.4, preference: 'wide' }] });
  for (let frame = 300; frame < 480; frame++) {
    const time = frame / 30;
    if (time >= 11.2 && time < 12.4) continue;
    const before = cameraAt(baseline, time), after = cameraAt(corrected, time);
    expect(after.x, `source frame ${frame}`).toBeCloseTo(before.x, 6);
    expect(after.y, `source frame ${frame}`).toBeCloseTo(before.y, 6);
    expect(after.scale, `source frame ${frame}`).toBeCloseTo(before.scale, 6);
  }
});

it('freezes the evaluated moving manual camera without advancing its smoothing at a boundary', () => {
  const observations = Array.from({ length: 12 }, (_, index) => ({ ...sample(10 + index * 0.5, null), faces: [face('left', 0.15 + index * 0.04)] }));
  const baseline = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference: 'left' });
  const corrected = planSpeakerFraming(video, 1080, 1920, result(observations), 30, { preference: 'left', overrides: [{ start: 12.2, end: 13.4, preference: 'hold' }] });
  const frozen = cameraAt(baseline, 12.2);
  for (let frame = 300; frame < 480; frame++) {
    const time = frame / 30, expected = time >= 12.2 && time < 13.4 ? frozen : cameraAt(baseline, time);
    const actual = cameraAt(corrected, time);
    expect(actual.x, `source frame ${frame}`).toBeCloseTo(expected.x, 6);
    expect(actual.scale, `source frame ${frame}`).toBeCloseTo(expected.scale, 6);
  }
});
