import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { mount } from '@diffusionstudio/reconciler';
import { Source, createRuntimeWorld } from '@diffusionstudio/runtime';
import { bundle, el } from './project-fixture';
import { trackCapabilities } from './track-capabilities';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// One of each kind of row an editor lays out.
const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'interview', {}, [el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }), el('Video', 'b', { src: 'b.mp4', start: 5, end: 9 })]),
    el('Sequence', 'titles', {}, [el('Text', 't1', { start: 0, end: 3 }, [], 'Hello'), el('Rect', 'card', { width: 10, height: 10, start: 3, end: 6 })]),
    el('Sequence', 'music', {}, [el('Audio', 'm1', { src: 'm.mp3', start: 0, end: 9 })]),
    el('Sequence', 'empty', {}),
    el('Audio', 'bed', { src: 'bed.mp3', start: 0, end: 9 }),
    el('Image', 'logo', { src: 'p.png', start: 0, end: 9 }),
    el('Group', 'shot', { start: 0, end: 3 }, [el('Rect', 'shotcard', { width: 10, height: 10 })]),
  ]),
]);

let world: World;
let mounted: Mount;
const find = (id: string): Entity => [...world.query(Source)].find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;

beforeEach(() => {
  world = createRuntimeWorld('capabilities');
  mounted = mount(bundle(project()), world);
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('what a track header has to offer', () => {
  it('is the eye, the mute and the solo for a track of video clips: a picture and a sound', () => {
    expect(trackCapabilities(world, find('interview'))).toEqual({ visual: true, audio: true });
    expect(trackCapabilities(world, find('a'))).toEqual({ visual: true, audio: true });
  });

  it('is the eye alone for what is only seen: titles, a graphic, an image, a group of shapes', () => {
    for (const id of ['titles', 't1', 'card', 'logo', 'shot']) expect(trackCapabilities(world, find(id)), id).toEqual({ visual: true, audio: false });
  });

  it('is the mute and the solo alone for what is only heard: music', () => {
    for (const id of ['music', 'm1', 'bed']) expect(trackCapabilities(world, find(id)), id).toEqual({ visual: false, audio: true });
  });

  it('is an eye for a track with nothing on it yet', () => {
    expect(trackCapabilities(world, find('empty'))).toEqual({ visual: true, audio: false });
  });
});
