import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { VideoAsset } from '@diffusionstudio/assets';
import type { SpeakerAnalysisResult } from '@desktop/speaker-types';
import type { SpeakerFramingOptions } from './speaker-framing-options';
vi.hoisted(() => { for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {}); });
import { mount } from '@diffusionstudio/reconciler';
import { Computed, Source, createRuntimeWorld, motionSystem, playbackSystem, setPlayhead } from '@diffusionstudio/runtime';
import { collectReframeVideos, planReframeVariants } from './reframe-plan';
afterAll(() => vi.unstubAllGlobals());
const asset = { id: 'clip', path: 'Source.mp4', type: 'VIDEO', source: '/Source.mp4', width: 1920, height: 1080, duration: 60 } as VideoAsset;
function fixture(speakerFraming?: SpeakerFramingOptions) {
  const source: AuthoredTree = { tag: 'scene', props: { width: 1920, height: 1080 }, children: [{ tag: 'video', props: { src: 'Source.mp4', width: 1920, height: 1080, start: 4, end: 7, sourceIn: 10, playbackRate: 2 }, children: [] }] };
  const analysis: SpeakerAnalysisResult = { engine: 'test', fingerprint: 'a'.repeat(64), width: 1920, height: 1080, start: 10, end: 16, sourceStart: 2, sampleInterval: 1, warnings: [], resumedChunks: 0, totalChunks: 1,
    samples: [10, 11, 12, 13, 14, 15].map((time, i) => ({ time, cut: i === 4, audioRms: 0.1, activeTrackId: i === 2 || i === 3 ? null : 'person', reason: i === 2 || i === 3 ? 'overlap' : 'speaker', faces: [{ trackId: 'person', x: i >= 4 ? 0.1 : 0.8, y: 0.2, width: 0.1, height: 0.2, confidence: 1, speakingScore: 3 }] })) };
  const videos = collectReframeVideos(source, () => asset).map(video => ({ ...video, timeline: { start: 4, end: 7, origin: -1, rate: 2 } }));
  const plan = planReframeVariants(source, videos, new Map(), { formats: ['vertical'], mode: 'speakers', fps: 30, speakerFraming, sceneEnd: 7, speakerAnalyses: new Map([['0', analysis]]) });
  const tree = plan.variants[0]!.tree, world = createRuntimeWorld('speaker-runtime');
  const code = `const jsx=require('@diffusionstudio/jsx');function render(node,path){const props={...node.props,__source:'fixture.tsx:'+path};Object.defineProperty(props,'children',{enumerable:true,get(){return node.children.map((child,i)=>render(child,path+'n'+i));}});return jsx[node.tag[0].toUpperCase()+node.tag.slice(1)](props);}module.exports.default=()=>jsx.Stage({__source:'fixture.tsx:stage',get children(){return render(${JSON.stringify(tree)},'scene');}});`;
  const mounted = mount(code, world), find = (key: string) => world.query(Source).find((node) => node.get(Source)?.value === `fixture.tsx:${key}`)!;
  return { world, summary: plan.speakerSummary, scene: find('scene'), video: find('scenen0'), tree, dispose: () => { mounted.dispose(); world.destroy(); } };
}
describe('speaker cameras in the actual composition runtime', () => {
  it('maps source-time decisions through delayed start, trim and2x playback', () => {
    const f = fixture(); try {
      setPlayhead(f.world, f.scene, 120); playbackSystem(f.world); motionSystem(f.world);
      expect(f.video.get(Computed)?.localTime).toBe(300);
      expect(f.video.get(Computed)?.scaleX).toBeCloseTo(1080 / (1920 * 1920 / 1080));
      setPlayhead(f.world, f.scene, 135); playbackSystem(f.world); motionSystem(f.world);
      expect(f.video.get(Computed)?.scaleX).toBeCloseTo(1);
      expect(f.video.get(Computed)?.scaleY).toBeCloseTo(1);
      expect(f.video.get(Computed)!.positionX).toBeLessThan(-2000);
    } finally { f.dispose(); }
  });
  it('fits full geometry on overlap and does not pan through a source cut', () => {
    const f = fixture(); try {
      setPlayhead(f.world, f.scene, 150); playbackSystem(f.world); motionSystem(f.world);
      const wide = f.video.get(Computed)!;
      expect(wide.scaleX).toBeLessThan(1); expect(wide.scaleY).toBeCloseTo(wide.scaleX);
      expect(wide.positionX).toBeCloseTo(0); expect(wide.positionY).toBeGreaterThan(600);
      setPlayhead(f.world, f.scene, 180); playbackSystem(f.world); motionSystem(f.world);
      expect(f.video.get(Computed)?.positionX).toBeCloseTo(0);
      expect(f.tree.children[0]!.children.filter((track) => track.props.property === 'scale')).toHaveLength(1);
    } finally { f.dispose(); }
  });
  it('keeps sub-sample corrections inside their scene range at2x speed', () => {
    const baseline = fixture(), corrected = fixture({ overrides: [{ start: 4.2, end: 4.4, preference: 'left' }] });
    const camera = (f: ReturnType<typeof fixture>, frame: number) => {
      setPlayhead(f.world, f.scene, frame); playbackSystem(f.world); motionSystem(f.world);
      const c = f.video.get(Computed)!; return { scale: c.scaleX, x: c.positionX, y: c.positionY };
    };
    try {
      for (const frame of [120, 123, 125, 132, 133, 135]) {
        const actual = camera(corrected, frame), expected = camera(baseline, frame);
        expect(actual.scale, `outside range at frame${frame}`).toBeCloseTo(expected.scale, 5);
        expect(actual.x, `outside range at frame${frame}`).toBeCloseTo(expected.x, 5);
      }
      for (const frame of [126, 128, 131]) expect(camera(corrected, frame).scale).toBeCloseTo(1);
      expect(corrected.summary?.manualSeconds).toBeCloseTo(0.2);
      expect(corrected.summary?.evidenceSeconds).toBeCloseTo(baseline.summary!.evidenceSeconds);
      expect(corrected.summary?.analyzedSeconds).toBe(3);
    } finally { baseline.dispose(); corrected.dispose(); }
  });
  it('holds the evaluated camera through the complete correction range', () => {
    const baseline = fixture(), corrected = fixture({ overrides: [{ start: 4.2, end: 4.4, preference: 'hold' }] });
    const scale = (f: ReturnType<typeof fixture>, frame: number) => {
      setPlayhead(f.world, f.scene, frame); playbackSystem(f.world); motionSystem(f.world); return f.video.get(Computed)!.scaleX;
    };
    try {
      const frozen = scale(baseline, 126);
      expect(scale(corrected, 125)).toBeCloseTo(scale(baseline, 125), 5);
      for (const frame of [126, 128, 131]) expect(scale(corrected, frame)).toBeCloseTo(frozen, 5);
      expect(scale(corrected, 132)).toBeCloseTo(scale(baseline, 132), 5);
    } finally { baseline.dispose(); corrected.dispose(); }
  });

  it('applies fractional scene boundaries on the first frame at or after them', () => {
    const baseline = fixture(), corrected = fixture({ overrides: [{ start: 4.205, end: 4.405, preference: 'left' }] });
    const scale = (f: ReturnType<typeof fixture>, frame: number) => {
      setPlayhead(f.world, f.scene, frame); playbackSystem(f.world); motionSystem(f.world); return f.video.get(Computed)!.scaleX;
    };
    try {
      for (const frame of [120, 125, 126, 133, 134, 135]) expect(scale(corrected, frame)).toBeCloseTo(scale(baseline, frame), 5);
      for (const frame of [127, 128, 132]) expect(scale(corrected, frame)).toBeCloseTo(1);
    } finally { baseline.dispose(); corrected.dispose(); }
  });

});
