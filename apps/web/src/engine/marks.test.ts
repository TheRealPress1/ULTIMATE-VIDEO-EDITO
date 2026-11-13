import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { authoredTree, mount } from '@diffusionstudio/reconciler';
import { Source, Workarea, createRuntimeWorld, getActiveEntity, setPlayhead } from '@diffusionstudio/runtime';
import { getEditHistory } from './history';
import { clearMarks, markIn, markOut } from './marks';
import { bundle, el } from './project-fixture';

import type { Mount } from '@diffusionstudio/reconciler';
import type { World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// A scene 20 s long, at 30 frames a second.
const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'row', {}, [el('Video', 'a', { src: 'a.mp4', start: 0, end: 20 })]),
  ]),
]);

let world: World;
let mounted: Mount;

const scene = () => getActiveEntity(world)!;
const workarea = () => scene().get(Workarea);
/** The work area as the file would say it, in seconds. */
const authored = () => authoredTree(world, world.query(Source).find((entity) => entity.get(Source)?.value === 'index.tsx:scene')!)?.props.workarea;
const at = (seconds: number) => setPlayhead(world, scene(), Math.round(seconds * 30));

beforeEach(() => {
  world = createRuntimeWorld('marks');
  mounted = mount(bundle(project()), world);
  getEditHistory(world).reset();
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('in and out marks', () => {
  it('Mark In starts the work area at the playhead and lets it run to the scene\'s end', async () => {
    at(5);
    markIn(world);
    await Promise.resolve();

    expect(workarea()).toMatchObject({ start: 150, end: 600 });
    expect(authored()).toEqual([5, 20]);
  });

  it('Mark Out ends it at the playhead and starts it at the scene\'s start', async () => {
    at(12);
    markOut(world);
    await Promise.resolve();

    expect(workarea()).toMatchObject({ start: 0, end: 360 });
  });

  it('sets the two ends one after the other, each from where the playhead is', async () => {
    at(4);
    markIn(world);
    at(9);
    markOut(world);
    await Promise.resolve();

    expect(workarea()).toMatchObject({ start: 120, end: 270 });
  });

  it('does not make an empty or backwards range: a mark past the other end moves that end to the scene\'s own', async () => {
    at(4);
    markIn(world);
    at(9);
    markOut(world);
    at(15);
    markIn(world);
    await Promise.resolve();

    // The old out (9 s) is before the new in (15 s): the range runs to the scene's end instead.
    expect(workarea()).toMatchObject({ start: 450, end: 600 });
  });

  it('marks nothing at the very start or end, where there would be no range', async () => {
    at(0);
    markOut(world);
    at(20);
    markIn(world);
    await Promise.resolve();

    expect(workarea()).toBeUndefined();
  });

  it('are taken off together', async () => {
    at(4);
    markIn(world);
    at(9);
    markOut(world);
    await Promise.resolve();
    expect(workarea()).toBeDefined();

    clearMarks(world);
    await Promise.resolve();
    expect(workarea()).toBeUndefined();
    expect(authored()).toBeFalsy();
  });

  it('clearing with no marks changes nothing', async () => {
    clearMarks(world);
    await Promise.resolve();

    expect(workarea()).toBeUndefined();
    expect(getEditHistory(world).canUndo()).toBe(false);
  });

  it('a mark is taken back by one undo', async () => {
    at(5);
    markIn(world);
    await Promise.resolve();
    expect(workarea()).toBeDefined();

    getEditHistory(world).undo();
    expect(workarea()).toBeUndefined();
  });
});
