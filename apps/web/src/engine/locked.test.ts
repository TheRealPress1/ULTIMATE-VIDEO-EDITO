import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { Rect, authoredTree, mount } from '@diffusionstudio/reconciler';
import { Locked, Selected, Source, createRuntimeWorld } from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { isLocked } from './locked';
import { bundle, el } from './project-fixture';
import { rippleDeleteSelection } from './ripple';
import { razorAt } from './split';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';
import type { EntityEdit, Refusal } from './editor';

afterAll(() => vi.unstubAllGlobals());

// Two tracks. A lock on the dialogue track is a lock on every clip on it, and on nothing else.
const FPS = 30;

const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'dialogue', { name: 'Dialogue' }, [
      el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'b', { src: 'b.mp4', start: 5, end: 9 }),
    ]),
    el('Sequence', 'broll', { name: 'B-roll' }, [
      el('Video', 'c', { src: 'c.mp4', start: 0, end: 4 }),
      el('Video', 'd', { src: 'd.mp4', start: 4, end: 9 }),
    ]),
  ]),
]);

let world: World;
let mounted: Mount;
let edits: { edit: EntityEdit; external: boolean }[];
let refusals: Refusal[];

const find = (id: string): Entity => [...world.query(Source)].find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const editor = () => getDocumentEditor(world);
const frame = (seconds: number) => Math.round(seconds * FPS);
const prop = (id: string, name: string) => authoredTree(world, find(id))!.props[name];
const tree = () => JSON.stringify(authoredTree(world, find('scene')));
const clips = (id: string) => (authoredTree(world, find(id))?.children ?? []).map((child) => [child.props.start, child.props.end]);

beforeEach(() => {
  world = createRuntimeWorld('locked');
  mounted = mount(bundle(project()), world);
  getEditHistory(world).reset();
  edits = [];
  refusals = [];
  editor().onEdit((edit, external) => edits.push({ edit, external }));
  editor().onRefuse((reason) => { refusals.push(reason); });
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

/** Locks the dialogue track the way the track header does, and forgets the edit that did it. */
async function lockDialogue(): Promise<void> {
  editor().editProperty(find('dialogue'), 'locked', true);
  await Promise.resolve();
  edits = [];
}

describe('a locked track', () => {
  it('is a lock on every clip on it, and on nothing else', async () => {
    await lockDialogue();

    for (const id of ['dialogue', 'a', 'b']) expect(isLocked(find(id)), id).toBe(true);
    for (const id of ['broll', 'c', 'd', 'scene', 'stage']) expect(isLocked(find(id)), id).toBe(false);
  });

  it('is written like any prop, and takes the Locked tag with it', async () => {
    editor().editProperty(find('dialogue'), 'locked', true);
    await Promise.resolve();

    expect(find('dialogue').has(Locked)).toBe(true);
    expect(prop('dialogue', 'locked')).toBe(true);
    expect(edits.map(({ edit }) => edit)).toEqual([expect.objectContaining({ kind: 'prop', source: 'index.tsx:dialogue', name: 'locked', value: true })]);
  });
});

describe('an edit to a locked clip', () => {
  it('is not made: the clip keeps what it had, nothing is reported, and the editor says it is locked', async () => {
    await lockDialogue();
    const before = tree();

    editor().editProperty(find('a'), 'end', 3);
    editor().unsetProperty(find('a'), 'start');

    expect(prop('a', 'end')).toBe(5);
    expect(edits).toEqual([]);
    expect(refusals).toEqual(['locked', 'locked']);
    expect(tree()).toBe(before);
  });

  it('is made as ever to a clip on a track that is not locked', async () => {
    await lockDialogue();

    editor().editProperty(find('c'), 'end', 3);
    await Promise.resolve();

    expect(prop('c', 'end')).toBe(3);
    expect(refusals).toEqual([]);
    expect(edits.map(({ edit }) => edit)).toEqual([expect.objectContaining({ kind: 'prop', source: 'index.tsx:c', name: 'end', value: 3 })]);
  });

  it('is put back when a gesture made the change itself and said what it was', async () => {
    await lockDialogue();
    editor().editProperty(find('c'), 'end', 3);
    await Promise.resolve();
    edits = [];

    // What a canvas drag does: the document is changed first, and the editor is told after.
    const document = (await import('@diffusionstudio/reconciler')).getRuntimeDocument(world);
    document.setProperty(document.node(find('a')), 'end', 2);
    editor().reportEdit(find('a'), 'end', 2, 5);

    expect(prop('a', 'end')).toBe(5);
    expect(edits).toEqual([]);
    expect(refusals).toEqual(['locked']);
  });

  it('is not made to the shape of the track either: not removed, copied, moved in or out, or added to', async () => {
    await lockDialogue();
    const before = tree();

    expect(editor().remove(find('a'))).toEqual([]);
    expect(editor().duplicateInPlace([find('b')])).toEqual([]);
    expect(editor().reparent(find('a'), find('broll'))).toBe(false);
    expect(editor().reparent(find('c'), find('dialogue'))).toBe(false);
    expect(editor().insertElement(find('dialogue'), () => Rect({ width: 10, height: 10 }))).toEqual([]);

    expect(find('a').isAlive()).toBe(true);
    expect(edits).toEqual([]);
    expect(refusals).toHaveLength(5);
    expect(tree()).toBe(before);
  });
});

describe('an element that is locked and generated', () => {
  it('is refused as locked, the reason a person can lift', () => {
    mounted.dispose();
    world.destroy();
    world = createRuntimeWorld('locked-generated');
    mounted = mount(bundle(el('Stage', 'stage', {}, [
      el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
        el('Group', 'shot', { start: 0, end: 3 }),
        el('Group', 'shot', { start: 3, end: 6 }),
      ]),
    ])), world);
    refusals = [];
    editor().onRefuse((reason) => { refusals.push(reason); });
    const [shot] = [...world.query(Source)].filter((entity) => entity.get(Source)?.value === 'index.tsx:shot');

    editor().editProperty(shot!, 'start', 9);
    shot!.add(Locked);
    editor().editProperty(shot!, 'start', 9);

    expect(refusals).toEqual(['generated', 'locked']);
  });
});

describe('what a lock lets through', () => {
  it('is unlocking: the lock is the one prop of a locked track that can be written', async () => {
    await lockDialogue();

    editor().editProperty(find('dialogue'), 'locked', false);
    await Promise.resolve();

    expect(find('dialogue').has(Locked)).toBe(false);
    expect(refusals).toEqual([]);
    expect(edits.map(({ edit }) => edit)).toEqual([expect.objectContaining({ kind: 'prop', name: 'locked', value: false })]);

    editor().editProperty(find('a'), 'end', 3);
    expect(prop('a', 'end')).toBe(3);
  });

  it('is selecting: a locked clip can be looked at, and its selection is written as ever', async () => {
    await lockDialogue();

    editor().select(find('a'));
    await Promise.resolve();

    expect(find('a').has(Selected)).toBe(true);
    expect(refusals).toEqual([]);
    expect(edits.map(({ edit }) => edit)).toEqual([expect.objectContaining({ kind: 'prop', source: 'index.tsx:a', name: 'selected', value: true })]);
  });

  it('is undone like any edit: the first undo after a lock takes the lock off', async () => {
    editor().editProperty(find('a'), 'end', 3);
    await Promise.resolve();
    editor().editProperty(find('dialogue'), 'locked', true);
    await Promise.resolve();

    getEditHistory(world).undo();
    expect(find('dialogue').has(Locked)).toBe(false);
    expect(prop('a', 'end')).toBe(3);

    getEditHistory(world).undo();
    expect(prop('a', 'end')).toBe(5);
    expect(refusals).toEqual([]);
  });

  it('is what the file says: an edit from outside brings the document up to the file', async () => {
    await lockDialogue();

    editor().applyExternal(() => editor().editProperty(find('a'), 'end', 3));

    expect(prop('a', 'end')).toBe(3);
    expect(refusals).toEqual([]);
    expect(edits).toEqual([expect.objectContaining({ external: true })]);
  });
});

describe('the cutting tools', () => {
  it('cut the rows a razor across every row may, and leave a locked one as it was', async () => {
    await lockDialogue();

    // At two seconds the razor is over a clip of each track: Shift cuts them all.
    const tails = razorAt(world, find('c'), frame(2), true);
    await Promise.resolve();

    expect(tails).toHaveLength(1);
    expect(clips('broll')).toEqual([[0, 2], [2, 4], [4, 9]]);
    expect(clips('dialogue')).toEqual([[0, 5], [5, 9]]);
    expect(refusals).toEqual(['locked']);
  });

  it('make no cut in a locked clip', async () => {
    await lockDialogue();
    const before = tree();

    expect(razorAt(world, find('a'), frame(2))).toEqual([]);
    await Promise.resolve();

    expect(refusals).toEqual(['locked']);
    expect(edits).toEqual([]);
    expect(tree()).toBe(before);
  });

  it('make no ripple delete in a locked track: nothing is deleted and nothing is moved', async () => {
    await lockDialogue();
    editor().select(find('a'));
    await Promise.resolve();
    edits = [];
    const before = tree();

    rippleDeleteSelection(world);
    await Promise.resolve();

    expect(find('a').isAlive()).toBe(true);
    expect(refusals).toEqual(['locked']);
    expect(edits).toEqual([]);
    expect(tree()).toBe(before);
  });
});
