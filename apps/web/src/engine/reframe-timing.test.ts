import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { VideoAsset } from '@diffusionstudio/assets';
vi.hoisted(() => { for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {}); });
import { mount } from '@diffusionstudio/reconciler';
import { Computed, Source, createRuntimeWorld } from '@diffusionstudio/runtime';
import { collectReframeVideos } from './reframe-plan';
import { resolveReframeTiming } from './reframe-timing';
import { sourceSpeakerFraming, validateSpeakerFraming } from './speaker-framing-options';

afterAll(() => vi.unstubAllGlobals());
const asset = { id: 'clip', path: 'Source.mp4', type: 'VIDEO', source: '/Source.mp4', width: 1920, height: 1080, duration: 60 } as VideoAsset;
const video = (props: Record<string, unknown>): AuthoredTree => ({ tag: 'video', props: { src: 'Source.mp4', width: 1920, height: 1080, ...props }, children: [] });
function fixture(children: AuthoredTree[], end = 12) {
  const tree: AuthoredTree = { tag: 'scene', props: { width: 1920, height: 1080, end }, children };
  const world = createRuntimeWorld('reframe-timing');
  const code = `const jsx=require('@diffusionstudio/jsx');function render(node,path){const props={...node.props,__source:'fixture.tsx:'+path};Object.defineProperty(props,'children',{enumerable:true,get(){return node.children.map((child,i)=>render(child,path+'.'+i));}});return jsx[node.tag[0].toUpperCase()+node.tag.slice(1)](props);}module.exports.default=()=>jsx.Stage({__source:'fixture.tsx:stage',get children(){return render(${JSON.stringify(tree)},'scene');}});`;
  const mounted = mount(code, world);
  const find = (key: string) => world.query(Source).find(node => node.get(Source)?.value === `fixture.tsx:${key}`)!;
  const resolved = resolveReframeTiming(world, find('scene'), collectReframeVideos(tree, () => asset), 30);
  return { ...resolved, find, dispose: () => { mounted.dispose(); world.destroy(); } };
}

describe('speaker correction timeline mapping', () => {
  it('maps a scene range across delayed clips with different trims and playback rates', () => {
    const f = fixture([video({ start: 2, end: 5, sourceIn: 10, playbackRate: 2 }), video({ start: 5, end: 9, sourceIn: 20, playbackRate: 0.5 })]);
    try {
      const options = { overrides: [{ start: 4, end: 7, preference: 'left' as const }] };
      expect(sourceSpeakerFraming(f.videos[0]!, options)).toEqual({ preference: undefined, playbackRate: 2, overrides: [{ start: 14, end: 16, preference: 'left' }] });
      expect(sourceSpeakerFraming(f.videos[1]!, options)).toEqual({ preference: undefined, playbackRate: 0.5, overrides: [{ start: 20, end: 21, preference: 'left' }] });
      expect(sourceSpeakerFraming(f.videos[0]!, { overrides: [{ start: 0, end: 2, preference: 'wide' }] }).overrides).toEqual([]);
      expect(f.sceneEnd).toBe(12); // Includes the empty tail of the authored scene.
    } finally { f.dispose(); }
  });

  it('uses nested sequence origins and clips corrections to the visible parent window', () => {
    const f = fixture([{ tag: 'sequence', props: { start: 2, end: 8 }, children: [
      { tag: 'sequence', props: { start: 1, end: 5 }, children: [video({ start: 1, end: 7, sourceIn: 10, playbackRate: 2 })] },
    ] }]);
    try {
      const clock = f.find('scene.0.0.0').get(Computed)!;
      expect(clock.start / 30).toBe(4);
      expect(f.videos[0]).toMatchObject({ start: 10, end: 16, timeline: { start: 4, end: 7, origin: -1, rate: 2 } });
      expect(sourceSpeakerFraming(f.videos[0]!, { overrides: [{ start: 5, end: 9, preference: 'right' }] }).overrides).toEqual([{ start: 12, end: 16, preference: 'right' }]);
    } finally { f.dispose(); }
  });

  it('uses frame-quantized runtime trims instead of unrounded authored seconds', () => {
    const f = fixture([video({ start: 4.005, end: 5.005, sourceIn: 10.005, playbackRate: 1.25 })]);
    try {
      expect(f.videos[0]).toMatchObject({ start: 10, end: 11.25, timeline: { start: 4, end: 5, origin: -4, rate: 1.25 } });
    } finally { f.dispose(); }
  });

  it('rejects malformed, overlapping or out-of-scene corrections before editing', () => {
    expect(() => validateSpeakerFraming({ preference: 'wide' }, 'follow')).toThrow('speaker following');
    expect(() => validateSpeakerFraming({ overrides: [{ start: 1, end: 3, preference: 'left' }, { start: 2, end: 4, preference: 'right' }] }, 'speakers', 10)).toThrow('overlap');
    expect(() => validateSpeakerFraming({ overrides: [{ start: 1, end: 11, preference: 'hold' }] }, 'speakers', 10)).toThrow('within');
    expect(() => validateSpeakerFraming({ overrides: [{ start: NaN, end: 3, preference: 'left' }] }, 'speakers', 10)).toThrow('valid start');
    expect(() => validateSpeakerFraming({ preference: 'hold' } as never, 'speakers', 10)).toThrow('automatic');
    expect(() => validateSpeakerFraming({ overrides: [{ start: 3, end: 5, preference: 'hold' }, { start: 1, end: 3, preference: 'left' }] }, 'speakers', 10)).not.toThrow();
  });
});
