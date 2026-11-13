import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { authoredTree, mount } from '@diffusionstudio/reconciler';
import { createRuntimeWorld, KeyframeDragOrigin, Source } from '@diffusionstudio/runtime';
import { getDocumentEditor } from '../editor';
import { getEditHistory } from '../history';
import { bundle, canonical, el } from '../project-fixture';
import { inputSystem } from '../input/input-system';
import { editWorkarea } from '../timing';
import { Keys, Pointer, PointerEvents } from '../traits';
import { beginKeyframeDrag, dragClip, dragTrim, endHistoryGesture, updateDragGestures } from './drag';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from './surface';

afterAll(() => vi.unstubAllGlobals());

// A timeline gesture as the timeline runs it: every frame, the drag pass first
// (`updateDragGestures`, which closes a gesture the pointer has let go of), then
// the clips and keyframes that the pointer is over act on it as they are drawn.
// The pointer is a stand-in for the timeline's own: what the drag code reads of
// it is its state and how far it has come.

const RESOLUTION = 1; // one pixel a frame
type State = 'pressed' | 'pressing' | 'lifted' | 'idle';

const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'seq', {}, [
      el('Video', 'v1', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'v2', { src: 'b.mp4', start: 5, end: 12, sourceIn: 2 }),
      el('Video', 'v3', { src: 'c.mp4', start: 12, end: 20 }),
      // No end of its own: the clip runs as long as its source does.
      el('Video', 'v4', { src: 'd.mp4', start: 30 }),
    ]),
    el('Rect', 'box', { width: 100, height: 100 }, [
      el('KeyframeTrack', 'track', { property: 'opacity' }, [
        el('Keyframe', 'k1', { time: 0, value: 0 }),
        el('Keyframe', 'k2', { time: 1, value: 1 }),
      ]),
    ]),
  ]),
]);

let world: World;
let mounted: Mount;
let surface: TimelineSurfaceState;
let clock = 0;

const find = (id: string): Entity => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const history = () => getEditHistory(world);
const tree = () => JSON.stringify(canonical(authoredTree(world, find('scene'))));

beforeEach(() => {
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  world = createRuntimeWorld('drag-history');
  world.add(Pointer, Keys, PointerEvents);
  mounted = mount(bundle(project()), world);
  surface = { pointer: null, snapX: null, historyGesture: false } as unknown as TimelineSurfaceState;
  history().reset();
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
  vi.restoreAllMocks();
});

/** One frame of the timeline: the pointer in `state` having come `deltaX` pixels, `wait` ms after the last. */
const frame = async (state: State, deltaX = 0, draw: () => void = () => {}, wait = 16, stageHears?: 'pointerup'): Promise<void> => {
  clock += wait;
  // The engine runs the stage's input system before the timeline's. The stage listens for the pointer being
  // lifted on the window, so it hears a release over the timeline as well.
  if (stageHears) {
    world.get(PointerEvents)!.queue.push({ type: stageHears, clientX: 0, clientY: 0, button: 0 } as never);
    inputSystem(world);
  }
  surface.pointer = {
    position: state === 'idle'
      ? { state, currentX: 0, currentY: 0 }
      : { state, initialX: 0, initialY: 0, timestamp: 0, currentX: deltaX, currentY: 0, deltaX, deltaY: 0 },
  } as never;
  updateDragGestures(world, find('scene'), surface);
  if (state !== 'idle') draw();
  // The microtask on which a burst of edits outside a gesture becomes a step.
  await Promise.resolve();
};

/** Whether the pointer has come far enough for a press to be a drag, as the timeline decides it. */
const travelled = (deltaX: number): boolean => Math.abs(deltaX) >= 5;

/** A press on `clip`'s body, taken to `path` (how far the pointer has come, frame by frame; a `[x, ms]` rests there for ms). */
const moveClip = async (clip: Entity, path: (number | [number, number])[]): Promise<void> => {
  await frame('pressed');
  for (const stop of path) {
    const [deltaX, wait] = Array.isArray(stop) ? stop : [stop, 16];
    await frame('pressing', deltaX, () => dragClip(world, surface, clip, travelled(deltaX), RESOLUTION), wait);
  }
  const last = path[path.length - 1];
  const deltaX = Array.isArray(last) ? last[0] : last!;
  await frame('lifted', deltaX, () => dragClip(world, surface, clip, false, RESOLUTION));
  // The frame after the release, which settles what the drag landed on.
  await frame('idle');
};

/** How many undos it takes to get back to where the project started. */
const steps = (): number => {
  let count = 0;
  while (history().canUndo()) {
    history().undo();
    count++;
  }
  return count;
};

describe('a hold of the pointer on the timeline is one step in the history', () => {
  it('for a clip moved, however long the pointer rests along the way', async () => {
    const original = tree();
    await moveClip(find('v2'), [8, 30, 60, [60, 2_500], 90, 120]);
    const moved = tree();
    expect(moved).not.toBe(original);

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);

    history().redo();
    expect(tree()).toBe(moved);
  });

  it('for an edge trimmed, of a clip that had no end of its own to pin first', async () => {
    const original = tree();
    const clip = find('v4');
    await frame('pressed');
    for (const deltaX of [8, 16, 24, 40]) await frame('pressing', deltaX, () => dragTrim(world, surface, clip, 'in', RESOLUTION));
    await frame('lifted', 40, () => dragTrim(world, surface, clip, 'in', RESOLUTION));
    await frame('idle');
    expect(tree()).not.toBe(original);

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('for a clip dropped on its neighbours, which give way: one is trimmed and one is taken out', async () => {
    const original = tree();
    // v3 (12s to 20s) moved back to 0s covers v1 whole and the head of v2.
    await moveClip(find('v3'), [-60, -150, -300, -360]);
    expect(find('v1')).toBeUndefined();

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('for a clip dropped inside another, which is cut in two around it', async () => {
    const original = tree();
    // v1 (5s long) moved to 6s lands inside v2 (5s to 12s).
    await moveClip(find('v1'), [30, 90, 150, 180]);

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('for a keyframe moved', async () => {
    const original = tree();
    const keyframe = find('k2');
    await frame('pressed');
    for (const deltaX of [8, 20, 30]) {
      await frame('pressing', deltaX, () => { if (travelled(deltaX) && !keyframe.has(KeyframeDragOrigin)) beginKeyframeDrag(keyframe); });
    }
    await frame('pressing', 30, () => {}, 3_000);
    await frame('pressing', 45);
    await frame('lifted', 45);
    await frame('idle');
    expect(tree()).not.toBe(original);

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('for the work area dragged, whose handles write it a frame at a time', async () => {
    const original = tree();
    const scene = find('scene');
    await frame('pressed');
    await frame('pressing', 10, () => editWorkarea(world, scene, [10, 100]));
    await frame('pressing', 20, () => editWorkarea(world, scene, [20, 100]));
    await frame('pressing', 20, () => editWorkarea(world, scene, [20, 100]), 4_000);
    await frame('pressing', 35, () => editWorkarea(world, scene, [35, 100]));
    await frame('lifted', 35);
    await frame('idle');
    expect(tree()).not.toBe(original);

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('for a drop on its neighbours even though the stage hears the release first, which is not its hold to end', async () => {
    const original = tree();
    const clip = find('v3');
    await frame('pressed');
    for (const deltaX of [-60, -150, -300]) await frame('pressing', deltaX, () => dragClip(world, surface, clip, true, RESOLUTION));
    await frame('lifted', -360, () => dragClip(world, surface, clip, false, RESOLUTION), 16, 'pointerup');
    // The frame after, in which the neighbours give way, is again no one else's business.
    await frame('idle', 0, () => {}, 16, 'pointerup');
    expect(find('v1')).toBeUndefined();

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('for a hold that is taken away rather than let go, which the next frame settles all the same', async () => {
    const original = tree();
    const clip = find('v3');
    await frame('pressed');
    for (const deltaX of [-60, -150, -300]) await frame('pressing', deltaX, () => dragClip(world, surface, clip, true, RESOLUTION));
    // A cancelled pointer goes straight to idle: no frame sees it lifted.
    await frame('idle');
    expect(surface.historyGesture).toBe(false);
    expect(tree()).not.toBe(original);

    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('and an edit that lands in the middle of one, from a command that is a step of its own, leaves both whole', async () => {
    const original = tree();
    const clip = find('v4');
    await frame('pressed');
    await frame('pressing', 20, () => dragClip(world, surface, clip, true, RESOLUTION));

    // Someone else's edit (an agent's cut, say) while the clip is held.
    const step = history().beginGroup();
    getDocumentEditor(world).editProperty(find('box'), 'x', 77);
    history().endGroup(step);

    await frame('pressing', 40, () => dragClip(world, surface, clip, true, RESOLUTION));
    await frame('pressing', 60, () => dragClip(world, surface, clip, true, RESOLUTION));
    await frame('lifted', 60, () => dragClip(world, surface, clip, false, RESOLUTION));
    await frame('idle');
    const both = tree();

    // The drag is one step, the whole of it...
    history().undo();
    expect(tree()).not.toBe(both);
    expect(JSON.parse(tree()).children.find((child: { props: { x?: number } }) => child.props.x === 77)).toBeDefined();
    // ...and the other command is another, which the drag did not carry off with it.
    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });

  it('and two holds, even close together, are two steps', async () => {
    const original = tree();
    await moveClip(find('v4'), [30, 60]);
    const once = tree();
    await moveClip(find('v4'), [30, 60]);
    expect(tree()).not.toBe(once);

    history().undo();
    expect(tree()).toBe(once);
    history().undo();
    expect(tree()).toBe(original);
    expect(history().canUndo()).toBe(false);
  });
});

describe('what a hold leaves behind', () => {
  it('is no step for a press that went nowhere, and the history takes the next edit as it always did', async () => {
    await frame('pressed');
    await frame('pressing', 1);
    await frame('lifted', 1);
    await frame('idle');
    expect(history().canUndo()).toBe(false);

    // Not left open: each edit afterwards is closed on the microtask, as it always was.
    getDocumentEditor(world).editProperty(find('box'), 'x', 40);
    await Promise.resolve();
    getDocumentEditor(world).editProperty(find('box'), 'y', 50);
    await Promise.resolve();
    expect(steps()).toBe(2);
  });

  it('is not a step for a selection, which is where the user is looking and not the composition', async () => {
    await frame('pressed', 0, () => getDocumentEditor(world).select(find('v2')));
    await frame('pressing', 1);
    await frame('lifted', 1);
    await frame('idle');
    expect(history().canUndo()).toBe(false);
  });

  it('is closed by whoever finds the timeline gone mid-hold, and then the history is as it was', async () => {
    await frame('pressed');
    await frame('pressing', 10, () => dragClip(world, surface, find('v4'), true, RESOLUTION));
    expect(surface.historyGesture).toBe(true);

    // The canvas goes away with the hold still down: no frame will ever see it lifted.
    endHistoryGesture(world, surface);
    expect(surface.historyGesture).toBe(false);

    // What was dragged so far is its step; the edits after it are not swallowed by it.
    getDocumentEditor(world).editProperty(find('box'), 'x', 40);
    await Promise.resolve();
    getDocumentEditor(world).editProperty(find('box'), 'y', 50);
    await Promise.resolve();
    expect(steps()).toBe(3);
  });

  it('lets go of nothing it did not take: a hold the stage has open is the stage\'s', async () => {
    history().beginGesture();
    endHistoryGesture(world, surface);
    getDocumentEditor(world).editProperty(find('box'), 'x', 40);
    await Promise.resolve();
    // Still the stage's hold: the edit is held in its step, not closed on the microtask.
    expect(history().canUndo()).toBe(true);
    history().endGesture();
    expect(steps()).toBe(1);
  });
});
