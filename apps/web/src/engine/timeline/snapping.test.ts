import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { mount } from '@diffusionstudio/reconciler';
import { createRuntimeWorld, getActiveEntity, setPlayhead } from '@diffusionstudio/runtime';
import { bundle, el } from '../project-fixture';
import { getSnapFrames } from './snapping';
import { isSnapping, setSnapping, storedSnapping, toggleSnapping } from './tool';

import type { Mount } from '@diffusionstudio/reconciler';
import type { World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// Two clips in a row, edges at 5 and 9 seconds, 30 frames a second.
const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'row', {}, [
      el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'b', { src: 'b.mp4', start: 5, end: 9 }),
    ]),
  ]),
]);

let world: World;
let mounted: Mount;
let stored: Record<string, string>;

beforeEach(() => {
  stored = {};
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored[key] ?? null, setItem: (key: string, value: string) => { stored[key] = value; } });
  world = createRuntimeWorld('snapping');
  mounted = mount(bundle(project()), world);
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('what a dragged edge sticks to', () => {
  it('is the start of the scene, the playhead and the edges of the clips, while snapping is on', () => {
    setPlayhead(world, getActiveEntity(world)!, 100);

    expect(getSnapFrames(world)).toEqual(expect.arrayContaining([0, 100, 150, 270]));
  });

  it('is nothing at all once snapping is off', () => {
    setSnapping(world, false);

    expect(getSnapFrames(world)).toEqual([]);
  });

  it('is what it was once snapping is on again', () => {
    setSnapping(world, false);
    setSnapping(world, true);

    expect(getSnapFrames(world)).toEqual(expect.arrayContaining([0, 150, 270]));
  });
});

describe('the snapping switch', () => {
  it('is on until it is turned off, and toggles', () => {
    expect(isSnapping(world)).toBe(true);

    toggleSnapping(world);
    expect(isSnapping(world)).toBe(false);

    toggleSnapping(world);
    expect(isSnapping(world)).toBe(true);
  });

  it('is kept for the next session, and a session starts with it where it was left', () => {
    expect(storedSnapping()).toBe(true);

    setSnapping(world, false);
    expect(storedSnapping()).toBe(false);

    setSnapping(world, true);
    expect(storedSnapping()).toBe(true);
  });

  it('is still on when the store cannot be read', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });

    expect(storedSnapping()).toBe(true);
    expect(() => setSnapping(world, false)).not.toThrow();
    expect(isSnapping(world)).toBe(false);
  });
});
