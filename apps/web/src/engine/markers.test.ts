import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { authoredTree, mount } from '@diffusionstudio/reconciler';
import { Computed, Name, Source, buildTimelineLayers, createRuntimeWorld, recomputeEntityTimeRange, setPlayhead, store } from '@diffusionstudio/runtime';
import { getEditHistory } from './history';
import { bundle, el } from './project-fixture';
import { DEFAULT_MARKER_COLOR, addMarker, clearMarkerAtPlayhead, clearMarkers, getMarkers, markerColor, markerFrame, seekMarker } from './markers';
import { getSnapFrames } from './timeline/snapping';
import { toggleSnapping } from './timeline/tool';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// A 5 s clip, a marker at 4 s with a name, a red one at 1.5 s, and one at 20 s, long after the clip ends. At 30 fps: frames 120, 45 and 600.
const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'v1', { name: 'V1' }, [el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 })]),
    el('Marker', 'late', { time: 4, name: 'Outro' }),
    el('Marker', 'early', { time: 1.5, name: 'Drop', color: 'red' }),
    el('Marker', 'far', { time: 20 }),
  ]),
]);

let world: World;
let mounted: Mount;

const find = (id: string): Entity => [...world.query(Source)].find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const scene = () => find('scene');
/** The markers' times as the file spells them, earliest first. */
const times = () => (authoredTree(world, scene())?.children ?? []).filter((child) => child.tag === 'marker').map((child) => child.props.time);
const frames = () => getMarkers(world, scene()).map(markerFrame);

beforeEach(() => {
  world = createRuntimeWorld('markers');
  mounted = mount(bundle(project()), world);
  getEditHistory(world).reset();
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('a marker in the project', () => {
  it('is a flag at its time in frames, with its name and colour, and the earliest comes first', () => {
    expect(frames()).toEqual([45, 120, 600]);
    expect(getMarkers(world, scene()).map((marker) => marker.get(Name)?.value)).toEqual(['Drop', 'Outro', undefined]);
  });

  it('is drawn in the colour it names, and in the default one when it names none', () => {
    const [early, , far] = getMarkers(world, scene());
    expect(markerColor(early!)).toBe('#FF0000');
    expect(markerColor(far!)).toBe(DEFAULT_MARKER_COLOR);
  });

  it('is no layer: it takes no row and does not stretch the scene', () => {
    const rows = buildTimelineLayers(world, scene());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity).toBe(find('v1'));
    // The clip is 5 s long and the last marker is at 20 s.
    recomputeEntityTimeRange(world, scene());
    expect(store(world, Computed).duration[scene().id()]).toBe(150);
  });
});

describe('adding a marker', () => {
  it('puts one on the playhead, in seconds, as one undo step', async () => {
    setPlayhead(world, scene(), 60);
    const marker = addMarker(world)!;
    await Promise.resolve();

    expect(marker).not.toBeNull();
    expect(markerFrame(marker)).toBe(60);
    expect(times()).toContain(2);

    getEditHistory(world).undo();
    expect(frames()).toEqual([45, 120, 600]);
  });

  it('is one to a frame: where there is one already, that one is returned and nothing is added', async () => {
    const existing = find('late');
    expect(addMarker(world, 120)).toBe(existing);
    await Promise.resolve();

    expect(frames()).toEqual([45, 120, 600]);
    expect(getEditHistory(world).canUndo()).toBe(false);
  });

  it('can be asked for a frame, which is not taken before the start', async () => {
    addMarker(world, 10);
    addMarker(world, -5);
    await Promise.resolve();

    expect(frames()).toEqual([0, 10, 45, 120, 600]);
  });

  it('is not made when there is no scene', () => {
    mounted.dispose();
    world.destroy();
    world = createRuntimeWorld('markers-empty');

    expect(addMarker(world)).toBeNull();
  });
});

describe('taking markers away', () => {
  it('takes them all, and an undo brings every one back', async () => {
    expect(clearMarkers(world)).toHaveLength(3);
    await Promise.resolve();
    expect(frames()).toEqual([]);

    getEditHistory(world).undo();
    expect(frames()).toEqual([45, 120, 600]);
    expect(getMarkers(world, scene()).map((marker) => marker.get(Name)?.value)).toEqual(['Drop', 'Outro', undefined]);
  });

  it('takes the one on the playhead and leaves the others', async () => {
    setPlayhead(world, scene(), 120);
    expect(clearMarkerAtPlayhead(world)).toHaveLength(1);
    await Promise.resolve();
    expect(frames()).toEqual([45, 600]);

    setPlayhead(world, scene(), 121);
    expect(clearMarkerAtPlayhead(world)).toEqual([]);
  });
});

describe('going to a marker', () => {
  const at = () => store(world, Computed).localTime[scene().id()] ?? 0;

  it('goes to the next one after the playhead, and stops at the last', () => {
    setPlayhead(world, scene(), 0);
    expect(seekMarker(world, 'next')).toBe(true);
    expect(at()).toBe(45);
    expect(seekMarker(world, 'next')).toBe(true);
    expect(at()).toBe(120);
    expect(seekMarker(world, 'next')).toBe(true);
    expect(at()).toBe(600);
    expect(seekMarker(world, 'next')).toBe(false);
    expect(at()).toBe(600);
  });

  it('goes to the one before the playhead, and stops at the first', () => {
    setPlayhead(world, scene(), 130);
    expect(seekMarker(world, 'previous')).toBe(true);
    expect(at()).toBe(120);
    expect(seekMarker(world, 'previous')).toBe(true);
    expect(at()).toBe(45);
    expect(seekMarker(world, 'previous')).toBe(false);
    expect(at()).toBe(45);
  });
});

describe('snapping to markers', () => {
  it('offers their frames to stick to, and nothing at all once snapping is off', () => {
    expect(getSnapFrames(world)).toEqual(expect.arrayContaining([45, 120, 600]));

    toggleSnapping(world);
    expect(getSnapFrames(world)).toEqual([]);
  });
});
