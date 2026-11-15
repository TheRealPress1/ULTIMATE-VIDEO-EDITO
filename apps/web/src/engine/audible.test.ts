import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { mount } from '@diffusionstudio/reconciler';
import { Soloed, Source, audibleWhileSoloed, createRuntimeWorld } from '@diffusionstudio/runtime';
import { bundle, el } from './project-fixture';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// Two tracks of clips and a bed of music under the scene: what can be heard while one of them is soloed.
const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'dialogue', {}, [
      el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'b', { src: 'b.mp4', start: 5, end: 9 }),
    ]),
    el('Sequence', 'broll', {}, [
      el('Video', 'c', { src: 'c.mp4', start: 0, end: 4 }),
    ]),
    el('Audio', 'music', { src: 'm.mp3', start: 0, end: 9 }),
  ]),
]);

let world: World;
let mounted: Mount;

const find = (id: string): Entity => [...world.query(Source)].find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const heard = (...ids: string[]) => {
  const audible = audibleWhileSoloed(world)!;
  return Object.fromEntries(ids.map((id) => [id, audible.has(find(id))]));
};

beforeEach(() => {
  world = createRuntimeWorld('audible');
  mounted = mount(bundle(project()), world);
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('what stays audible while something is soloed', () => {
  it('is nothing in particular while nothing is soloed: every clip is left to its own mix', () => {
    expect(audibleWhileSoloed(world)).toBeNull();
  });

  it('is the clip alone, with what it sounds through, when a clip is soloed', () => {
    find('a').add(Soloed);

    expect(heard('a', 'b', 'c', 'music', 'dialogue', 'broll', 'scene')).toEqual({ a: true, b: false, c: false, music: false, dialogue: true, broll: false, scene: true });
  });

  it('is every clip on a track when the track is soloed, which a track\'s own mix has no bus to say', () => {
    find('dialogue').add(Soloed);

    expect(heard('a', 'b', 'c', 'music', 'dialogue', 'broll', 'scene')).toEqual({ a: true, b: true, c: false, music: false, dialogue: true, broll: false, scene: true });
  });

  it('is what several soloed tracks and clips hold together', () => {
    find('broll').add(Soloed);
    find('music').add(Soloed);

    expect(heard('a', 'b', 'c', 'music')).toEqual({ a: false, b: false, c: true, music: true });
  });

  it('is nothing in particular again once the last solo is taken off', () => {
    find('broll').add(Soloed);
    find('broll').remove(Soloed);

    expect(audibleWhileSoloed(world)).toBeNull();
  });
});
