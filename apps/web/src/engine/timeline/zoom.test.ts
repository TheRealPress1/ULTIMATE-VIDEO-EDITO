import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('DOMMatrix', class { scaleSelf() { return this; } translateSelf() { return this; } });
  vi.stubGlobal('DOMRect', class { width = 0; height = 0; left = 0; top = 0; });
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { mount } from '@diffusionstudio/reconciler';
import { createRuntimeWorld, getActiveEntity, setPlayhead } from '@diffusionstudio/runtime';
import { getDocumentEditor } from '../editor';
import { bundle, el } from '../project-fixture';
import { DEFAULT_TIMELINE_RESOLUTION, TIMELINE_PADDING_LEFT, TIMELINE_RESOLUTION_RANGE } from './config';
import { TimelineSurface } from './surface';
import { getResolution, getScrollX, getViewport, setScrollX } from './view';
import { resolutionToFit, zoomTimelineBy, zoomTimelineIn, zoomTimelineOut, zoomTimelineToFit } from './zoom';

import type { Mount } from '@diffusionstudio/reconciler';
import type { World } from 'koota';
import type { EntityEdit } from '../editor';

afterAll(() => vi.unstubAllGlobals());

// A scene 10 seconds long, at 30 frames a second, in a timeline 1008 pixels wide.
const FRAMES = 300;
const WIDTH = 1008;
const MIN = 1 / TIMELINE_RESOLUTION_RANGE[1];
const MAX = 1 / TIMELINE_RESOLUTION_RANGE[0];

const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'row', {}, [el('Video', 'a', { src: 'a.mp4', start: 0, end: 10 })]),
  ]),
]);

let world: World;
let mounted: Mount;
let edits: EntityEdit[];

const scene = () => getActiveEntity(world)!;

beforeEach(() => {
  // Only while a test runs: a window at load time makes the animation library think it is in a browser.
  Object.defineProperty(globalThis, 'window', { value: { devicePixelRatio: 1 }, configurable: true });
  world = createRuntimeWorld('zoom');
  mounted = mount(bundle(project()), world);
  world.add(TimelineSurface);
  world.get(TimelineSurface)!.layout = { width: WIDTH } as DOMRect;
  // The scene's times are worked out by its first frame, as the app's is.
  setPlayhead(world, scene(), 0);
  edits = [];
  getDocumentEditor(world).onEdit((edit) => edits.push(edit));
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
  delete (globalThis as { window?: unknown }).window;
});

describe('the resolution that fits a scene', () => {
  it('is the width, less the padding either side, over the frames', () => {
    expect(resolutionToFit(FRAMES, WIDTH)).toBeCloseTo((WIDTH - 2 * TIMELINE_PADDING_LEFT) / FRAMES, 6);
  });

  it('stays within what the wheel may reach, however long or short the scene', () => {
    expect(resolutionToFit(10_000_000, WIDTH)).toBe(MIN);
    expect(resolutionToFit(1, WIDTH)).toBe(MAX);
  });

  it('is the default for a scene with no length, or a view with no width yet', () => {
    expect(resolutionToFit(0, WIDTH)).toBe(DEFAULT_TIMELINE_RESOLUTION);
    expect(resolutionToFit(FRAMES, 0)).toBe(DEFAULT_TIMELINE_RESOLUTION);
    expect(resolutionToFit(FRAMES, TIMELINE_PADDING_LEFT)).toBe(DEFAULT_TIMELINE_RESOLUTION);
  });
});

describe('zooming the timeline to fit the scene', () => {
  it('puts every frame of the scene in view, from the start to the last', () => {
    zoomTimelineToFit(world);

    const resolution = getResolution(world, scene());
    const [left, right] = getViewport(world, scene(), WIDTH);
    expect(resolution).toBeCloseTo((WIDTH - 2 * TIMELINE_PADDING_LEFT) / FRAMES, 6);
    expect(left).toBeCloseTo(-TIMELINE_PADDING_LEFT, 6);
    expect(FRAMES * resolution).toBeLessThanOrEqual(right);
    expect(getScrollX(world, scene())).toBeCloseTo(-TIMELINE_PADDING_LEFT / resolution, 6);
  });

  it('tells the file where the timeline looks, as a view and not a step', () => {
    zoomTimelineToFit(world);

    expect(edits).toEqual([expect.objectContaining({ kind: 'prop', source: 'index.tsx:scene', name: 'timeline' })]);
  });

  it('does nothing, and says nothing, when there is no scene', () => {
    mounted.dispose();
    world.destroy();
    world = createRuntimeWorld('zoom-empty');

    expect(() => zoomTimelineToFit(world)).not.toThrow();
    expect(() => zoomTimelineIn(world)).not.toThrow();
  });
});

describe('zooming the timeline a step', () => {
  it('keeps the playhead where it is on screen when it is in view', () => {
    zoomTimelineToFit(world);
    setPlayhead(world, scene(), 90);
    const before = (90 - getScrollX(world, scene())) * getResolution(world, scene());
    const resolution = getResolution(world, scene());

    zoomTimelineIn(world);

    expect(getResolution(world, scene())).toBeCloseTo(resolution * 1.5, 6);
    expect((90 - getScrollX(world, scene())) * getResolution(world, scene())).toBeCloseTo(before, 3);
  });

  it('keeps the middle of the view when the playhead is out of it', () => {
    zoomTimelineToFit(world);
    zoomTimelineIn(world);
    zoomTimelineIn(world);
    // Scrolled well into the scene, with the playhead back at the start, out of view.
    setScrollX(world, scene(), 120);
    setPlayhead(world, scene(), 0);
    const middle = getScrollX(world, scene()) + WIDTH / 2 / getResolution(world, scene());

    zoomTimelineOut(world);

    expect(getScrollX(world, scene()) + WIDTH / 2 / getResolution(world, scene())).toBeCloseTo(middle, 3);
  });

  it('cannot scroll back before the start of the scene: the view stops there', () => {
    // As close in as it goes, at the start, with the playhead out of view at the end.
    zoomTimelineBy(world, 100);
    setScrollX(world, scene(), 0);
    setPlayhead(world, scene(), FRAMES);

    zoomTimelineBy(world, 1 / 20);

    expect(getScrollX(world, scene())).toBeCloseTo(-TIMELINE_PADDING_LEFT / getResolution(world, scene()), 6);
  });

  it('works before the timeline has been drawn once: a zoom is not lost to the view being set up', () => {
    // No draw pass has run in this world: the scene has no view yet.
    zoomTimelineIn(world);

    expect(getResolution(world, scene())).toBeCloseTo(DEFAULT_TIMELINE_RESOLUTION * 1.5, 6);
  });

  it('stops at the limits the wheel has', () => {
    for (let step = 0; step < 40; step++) zoomTimelineIn(world);
    expect(getResolution(world, scene())).toBeCloseTo(MAX, 6);

    for (let step = 0; step < 80; step++) zoomTimelineOut(world);
    expect(getResolution(world, scene())).toBeCloseTo(MIN, 6);
  });
});
