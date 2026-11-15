import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { authoredTree, mount } from '@diffusionstudio/reconciler';
import { Selected, Source, createRuntimeWorld } from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { bundle, canonical, el } from './project-fixture';
import { rippleDeleteSelection } from './ripple';
import { razorAt } from './split';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// The cutting tools, on clips that sit in sequences (rows that clips follow one another in).
const FPS = 30;

const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'row1', {}, [
      el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'b', { src: 'b.mp4', start: 5, end: 12, sourceIn: 2, sourceOut: 9 }),
      el('Video', 'c', { src: 'c.mp4', start: 12, end: 20 }),
      el('Video', 'd', { src: 'd.mp4', start: 20, end: 26 }),
    ]),
    el('Sequence', 'row2', {}, [
      el('Video', 'e', { src: 'e.mp4', start: 3, end: 9 }),
      el('Video', 'f', { src: 'f.mp4', start: 14, end: 18 }),
    ]),
  ]),
]);

let world: World;
let mounted: Mount;

const find = (id: string): Entity => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const history = () => getEditHistory(world);
const frame = (seconds: number) => Math.round(seconds * FPS);

type Row = { id: string; start: number; end: number; sourceIn?: number; selected: boolean };
/** The clips of a row, in order, as the project authors them. */
const row = (id: string): Row[] => (authoredTree(world, find(id))?.children ?? []).map((child) => ({
  id: String(child.props['data-source'] ?? ''),
  start: Number(child.props.start),
  end: Number(child.props.end),
  sourceIn: child.props.sourceIn === undefined ? undefined : Number(child.props.sourceIn),
  selected: Boolean(child.props.selected),
}));
const times = (id: string) => row(id).map(({ start, end }) => [start, end]);
const tree = () => JSON.stringify(canonical(authoredTree(world, find('scene'))));

beforeEach(() => {
  world = createRuntimeWorld('razor');
  mounted = mount(bundle(project()), world);
  getEditHistory(world).reset();
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('the razor', () => {
  it('cuts a clip in two where it is pressed, the tail picking up the source where the head left off', async () => {
    razorAt(world, find('b'), frame(8));
    await Promise.resolve();

    expect(times('row1')).toEqual([[0, 5], [5, 8], [8, 12], [12, 20], [20, 26]]);
    const [, head, tail] = row('row1');
    // b starts 2 s into its source: the head keeps that, and the tail takes up 3 s later, where the head ran out.
    expect(head!.sourceIn).toBe(2);
    expect(tail!.sourceIn).toBe(5);
  });

  it('leaves the sequence a sequence: no wrapper is made around a clip that was already in a row', async () => {
    razorAt(world, find('a'), frame(2));
    await Promise.resolve();

    const children = authoredTree(world, find('scene'))!.children;
    expect(children.map((child) => child.tag)).toEqual(children.map(() => children[0]!.tag));
    expect(children).toHaveLength(2);
  });

  it('leaves the new tail selected, as the playhead cut does', async () => {
    const tails = razorAt(world, find('c'), frame(15));
    await Promise.resolve();

    expect(tails).toHaveLength(1);
    expect(tails[0]!.has(Selected)).toBe(true);
    expect(world.query(Selected).length).toBe(1);
  });

  it('does nothing at a clip\'s own edges, where a cut would leave a half of nothing', async () => {
    const before = tree();
    expect(razorAt(world, find('b'), frame(5))).toEqual([]);
    expect(razorAt(world, find('b'), frame(12))).toEqual([]);
    expect(razorAt(world, find('b'), frame(30))).toEqual([]);
    await Promise.resolve();

    expect(tree()).toBe(before);
  });

  it('cuts only the clip it is on, unless it is held across every row', async () => {
    razorAt(world, find('a'), frame(4));
    await Promise.resolve();
    expect(times('row1')).toEqual([[0, 4], [4, 5], [5, 12], [12, 20], [20, 26]]);
    expect(times('row2')).toEqual([[3, 9], [14, 18]]);

    // 6.5 s is inside b (row 1) and e (row 2), and in nothing after them.
    razorAt(world, find('b'), frame(6.5), true);
    await Promise.resolve();
    expect(times('row1')).toEqual([[0, 4], [4, 5], [5, 6.5], [6.5, 12], [12, 20], [20, 26]]);
    expect(times('row2')).toEqual([[3, 6.5], [6.5, 9], [14, 18]]);
  });

  it('is one undo step, with several rows cut at once too', async () => {
    const before = tree();
    razorAt(world, find('b'), frame(6.5), true);
    await Promise.resolve();
    expect(tree()).not.toBe(before);

    history().undo();
    expect(tree()).toBe(before);
  });
});

describe('ripple delete', () => {
  const select = (...ids: string[]) => getDocumentEditor(world).select(ids.map(find));

  it('takes the clip out and closes the gap: what followed it in the row moves up by as much as it ran', async () => {
    select('b');
    rippleDeleteSelection(world);
    await Promise.resolve();

    // b ran 7 s: c and d move up by 7, a stays.
    expect(times('row1')).toEqual([[0, 5], [5, 13], [13, 19]]);
  });

  it('closes the gaps of every clip taken out of a row, each by its own length', async () => {
    select('a', 'c');
    rippleDeleteSelection(world);
    await Promise.resolve();

    // a ran 5 s and c ran 8 s: b moves up by 5, d by 13.
    expect(times('row1')).toEqual([[0, 7], [7, 13]]);
  });

  it('leaves other rows where they are, since only a row\'s own clips follow one another', async () => {
    select('b');
    rippleDeleteSelection(world);
    await Promise.resolve();

    expect(times('row2')).toEqual([[3, 9], [14, 18]]);
  });

  it('is one undo step: the clip and every clip that moved come back together', async () => {
    const before = times('row1');
    select('b');
    rippleDeleteSelection(world);
    await Promise.resolve();
    expect(times('row1')).not.toEqual(before);

    history().undo();
    expect(times('row1')).toEqual(before);
    // Nothing is left to undo: the delete and the moves were not two steps. (In the running editor they were, until the
    // command put them in a group; this harness merges edits of one tick, so it cannot tell the difference.)
    expect(history().canUndo()).toBe(false);
  });

  it('with nothing selected does nothing', async () => {
    const before = tree();
    rippleDeleteSelection(world);
    await Promise.resolve();

    expect(tree()).toBe(before);
  });
});
