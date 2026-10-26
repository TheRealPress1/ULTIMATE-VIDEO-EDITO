import { describe, expect, it } from "vitest";
import { planReferenceStyle } from "./reference-plan";
import { collectReframeVideos } from "./reframe-plan";
import type { AuthoredTree } from "@diffusionstudio/reconciler";
import type { VideoAsset } from "@diffusionstudio/assets";
import type { ReferenceProfile } from "@desktop/reference-types";
const asset = {
  id: "video",
  path: "Interview.mp4",
  source: "/Interview.mp4",
  type: "VIDEO",
  width: 1920,
  height: 1080,
  duration: 60,
} as VideoAsset;
const tree = (): AuthoredTree => ({
  tag: "scene",
  props: { id: "scene", name: "Interview", width: 1920, height: 1080 },
  children: [
    {
      tag: "video",
      props: {
        id: "clip",
        src: "Interview.mp4",
        width: 1920,
        height: 1080,
        start: 4,
        end: 9,
        sourceIn: 10,
        playbackRate: 2,
        volume: -4,
      },
      children: [],
    },
    {
      tag: "captions",
      props: {
        id: "words",
        src: "Words.json",
        preset: "cascade",
        start: 4,
        sourceIn: 10,
        sourceOut: 20,
        playbackRate: 2,
      },
      children: [],
    },
    {
      tag: "audio",
      props: { src: "Music.wav", volume: -20, end: 9 },
      children: [],
    },
  ],
});
const profile: ReferenceProfile = {
  sourceDuration: 20,
  analyzedDuration: 20,
  sourceStart: 0,
  width: 1080,
  height: 1920,
  sampleInterval: 0.25,
  cuts: [{ time: 2, score: 0.8 }],
  pacing: { medianShotSeconds: 10, cutsPerMinute: 3, shotCount: 2 },
  caption: {
    x: 0.15,
    y: 0.75,
    width: 0.7,
    height: 0.04,
    fontSizeRatio: 0.046,
    coverage: 0.8,
    observations: 16,
    distinctTexts: 16,
    examples: ["A spoken sentence"],
    suggestedPreset: "whisper",
  },
  palette: ["#202020"],
  sampleTimes: [0, 2],
  limitations: [],
};
describe("reference layout planning", () => {
  it("creates a new editable layout and preserves source words, clip timing and the original scene", () => {
    const scene = tree(),
      original = JSON.stringify(scene);
    const plan = planReferenceStyle(
      scene,
      collectReframeVideos(scene, () => asset),
      profile,
      30,
    );
    expect([plan.width, plan.height]).toEqual([1080, 1920]);
    expect(plan.captionLayers).toBe(1);
    expect(JSON.stringify(scene)).toBe(original);
    expect(JSON.stringify(plan.tree)).not.toContain('"id":');
    expect(plan.tree.children[0]!.props).toMatchObject({
      start: 4,
      end: 9,
      sourceIn: 10,
      playbackRate: 2,
      volume: -4,
    });
    expect(plan.tree.children[1]!.props).toMatchObject({
      src: "Words.json",
      sourceIn: 10,
      sourceOut: 20,
      playbackRate: 2,
      start: 4,
      preset: "whisper",
      textCase: "original",
    });
    expect(plan.tree.children[2]!.props).toMatchObject({
      src: "Music.wav",
      volume: -20,
      end: 9,
    });
    const c = plan.tree.children[1]!.props;
    expect(Number(c.x) + 500 * Number(c.scale)).toBeCloseTo(540);
    expect(Number(c.y) + 50 * Number(c.scale)).toBeCloseTo(0.77 * 1920);
    expect(Number(c.scale) * Number(c.fontSize)).toBeCloseTo(0.046 * 1920);
    expect(plan.tree.children[0]!.props.x).toBeLessThan(0);
    expect(plan.warnings.join()).toContain("does not change dialogue");
  });
  it("can match only captions and leaves the video frame untouched", () => {
    const scene = tree(),
      plan = planReferenceStyle(
        scene,
        collectReframeVideos(scene, () => asset),
        profile,
        30,
        { matchFormat: false },
      );
    expect([plan.width, plan.height]).toEqual([1920, 1080]);
    expect(plan.tree.children[0]!.props.width).toBe(1920);
    expect(plan.captionLayers).toBe(1);
  });
  it("does not fabricate caption styling when no reliable caption region was found", () => {
    const scene = tree(),
      plan = planReferenceStyle(
        scene,
        collectReframeVideos(scene, () => asset),
        { ...profile, caption: null },
        30,
        { matchFormat: false },
      );
    expect(plan.tree.children[1]!.props.preset).toBe("cascade");
    expect(plan.captionLayers).toBe(0);
    expect(plan.warnings.join()).toContain(
      "no reliable changing caption region",
    );
  });
  it("keeps generated boxes within safe margins and rejects a no-op option set", () => {
    const scene = tree(),
      videos = collectReframeVideos(scene, () => asset);
    const plan = planReferenceStyle(scene, videos, profile, 30),
      c = plan.tree.children[1]!.props;
    expect(Number(c.x)).toBeGreaterThanOrEqual(plan.width * 0.03);
    expect(Number(c.x) + 1000 * Number(c.scale)).toBeLessThanOrEqual(
      plan.width * 0.97,
    );
    expect(Number(c.y) + 100 * Number(c.scale)).toBeLessThanOrEqual(
      plan.height * 0.97,
    );
    expect(() =>
      planReferenceStyle(scene, videos, profile, 30, {
        matchFormat: false,
        matchCaptions: false,
      }),
    ).toThrow("Choose format");
  });
});

it('preserves existing caption motion rather than silently overriding its layout', () => {
  const scene = tree();
  scene.children[1]!.children.push({ tag: 'keyframeTrack', props: { property: 'y' }, children: [] });
  const plan = planReferenceStyle(scene, [], profile, 30, { matchFormat: false });
  expect(plan.captionLayers).toBe(0);
  expect(plan.tree.children[1]!.props.preset).toBe('cascade');
  expect(plan.warnings.some((warning) => warning.includes('existing motion'))).toBe(true);
});
