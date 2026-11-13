import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { Rect, Sequence, authoredElement, authoredTree, getRuntimeDocument, mount } from '@diffusionstudio/reconciler';
import { Loop, Selected, Source, createRuntimeWorld } from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { isGenerated } from './generated';
import { getEditHistory } from './history';
import { bundle, canonical, el } from './project-fixture';
import { rippleDeleteSelection } from './ripple';
import { razorAt } from './split';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';
import type { EntityEdit } from './editor';

afterAll(() => vi.unstubAllGlobals());

// A project that renders an element more than once spells it once in the file: three shots from a list are one group, under one
// stamp, with children of their own. A write to one of them is a write to all of them, so the editor makes none.
const FPS = 30;

const shotsProject = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'row', {}, [
      el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'b', { src: 'b.mp4', start: 5, end: 9 }),
    ]),
    ...[0, 1, 2].map((index) => el('Group', 'shot', { name: `Shot ${index + 1}`, start: index * 3, end: index * 3 + 3 }, [
      el('Rect', 'shotcard', { width: 100, height: 100, fill: '#0b1630' }),
      el('Rect', 'shotaccent', { x: 9, y: 76, width: 12, height: 12, fill: '#db0a40' }),
    ])),
  ]),
]);

// One of every kind of element a project is made of, each rendered once.
const everyKind = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'seq', { name: 'A-roll' }, [
      el('Video', 'v1', { src: 'a.mp4', start: 0, end: 5, volume: -6 }),
      el('Video', 'v3', { src: 'c.mp4', start: 5, end: 12 }, [
        el('Animation', 'fade', { type: 'fade', duration: 0.5 }),
        el('Effect', 'fx', { type: 'blur', value: 4 }),
      ]),
    ]),
    el('Text', 'title', { x: 100, y: 200, start: 1, end: 4, fontSize: 80, color: '#ffffff' }, [], 'Hello'),
    el('Rect', 'box', { x: 10, y: 20, width: 300, height: 200, fill: '#ff0000' }),
    el('Image', 'img', { src: 'p.png', x: 1, y: 2, start: 0, end: 3 }),
    el('Audio', 'aud', { src: 'm.mp3', volume: -10, start: 0, end: 30 }),
    el('Group', 'grp', { x: 5, y: 6 }, [el('Ellipse', 'ell', { width: 80, height: 80, fill: '#0000ff' })]),
    el('Captions', 'cap', { src: 'words.json', preset: 'classic', start: 0, end: 10 }),
  ]),
]);

// A row whose clips after the first come from a list.
const generatedRow = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'row', {}, [
      el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'clip', { src: 'x.mp4', start: 5, end: 9 }),
      el('Video', 'clip', { src: 'y.mp4', start: 9, end: 14 }),
    ]),
  ]),
]);

let world: World;
let mounted: Mount;
let edits: { edit: EntityEdit; external: boolean }[];
let refusals: number;

const all = (id: string): Entity[] => [...world.query(Source)].filter((entity) => entity.get(Source)?.value === `index.tsx:${id}`);
const one = (id: string): Entity => all(id)[0]!;
const editor = () => getDocumentEditor(world);
const frame = (seconds: number) => Math.round(seconds * FPS);
const tree = () => JSON.stringify(canonical(authoredTree(world, one('scene'))));
const prop = (entity: Entity, name: string) => authoredTree(world, entity)!.props[name];

function open(project: ReturnType<typeof shotsProject>): void {
  world = createRuntimeWorld('generated');
  mounted = mount(bundle(project), world);
  getEditHistory(world).reset();
  edits = [];
  refusals = 0;
  editor().onEdit((edit, external) => edits.push({ edit, external }));
  editor().onRefuse(() => { refusals += 1; });
}

beforeEach(() => open(shotsProject()));

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('telling an element the project renders more than once', () => {
  it('finds every instance of a list\'s element, and the children it renders under their own stamps', () => {
    for (const id of ['shot', 'shotcard', 'shotaccent']) {
      expect(all(id)).toHaveLength(3);
      for (const instance of all(id)) expect(isGenerated(world, instance), id).toBe(true);
    }
  });

  it('leaves what the project renders once alone: clips, rows, the scene and the stage', () => {
    for (const id of ['a', 'b', 'row', 'scene', 'stage']) expect(isGenerated(world, one(id)), id).toBe(false);
  });

  it('flags no element of a project that renders each of its elements once: every kind, with the entities the runtime derives from them', () => {
    mounted.dispose();
    world.destroy();
    open(everyKind());

    const authored = [...world.query(Source)].filter((entity) => authoredElement(entity));
    expect(authored.length).toBeGreaterThanOrEqual(13);
    // The runtime has more entities under a source than the project has elements (a video's paint, a caption's words).
    expect(world.query(Source).length).toBeGreaterThanOrEqual(authored.length);
    for (const entity of world.query(Source)) expect(isGenerated(world, entity), String(entity.get(Source)?.value)).toBe(false);
  });

  it('leaves a loop to the editor, which unrolls it before an edit reaches an iteration', () => {
    const [first] = all('shot');
    first!.add(Loop);
    first!.set(Loop, { value: 'loop' });

    expect(isGenerated(world, first!)).toBe(false);
  });
});

describe('an edit to an element the project renders more than once', () => {
  it('is not made: the document keeps what the project says, nothing is reported, and the editor says so', () => {
    const before = tree();
    const [shot] = all('shot');
    // Refused before the document is touched, not made and taken back: a prop the file cannot spell could not be put back.
    const set = vi.spyOn(getRuntimeDocument(world), 'setProperty');

    editor().editProperty(shot!, 'start', 9);

    expect(set).not.toHaveBeenCalled();
    expect(edits).toEqual([]);
    expect(refusals).toBe(1);
    expect(prop(shot!, 'start')).toBe(0);
    expect(tree()).toBe(before);
  });

  it('is not made for a child of one either, nor for the text or the unsetting of a prop', () => {
    const before = tree();
    const [card] = all('shotcard');
    const document = getRuntimeDocument(world);
    const set = vi.spyOn(document, 'setProperty');
    const text = vi.spyOn(document, 'setText');

    editor().editProperty(card!, 'fill', '#ff0000');
    editor().unsetProperty(card!, 'width');
    editor().editText(card!, 'hello');

    expect(set).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(edits).toEqual([]);
    expect(refusals).toBe(3);
    expect(tree()).toBe(before);
  });

  it('is put back when the caller made the change itself and said what it was', () => {
    const [shot] = all('shot');
    const document = getRuntimeDocument(world);
    document.setProperty(document.node(shot!), 'start', 9);
    expect(prop(shot!, 'start')).toBe(9);

    editor().reportEdit(shot!, 'start', 9, 0);

    expect(prop(shot!, 'start')).toBe(0);
    expect(edits).toEqual([]);
    expect(refusals).toBe(1);
  });

  it('is made as ever to an element the project renders once', async () => {
    editor().editProperty(one('a'), 'end', 4);
    await Promise.resolve();

    expect(refusals).toBe(0);
    expect(edits.map(({ edit }) => edit)).toEqual([expect.objectContaining({ kind: 'prop', source: 'index.tsx:a', name: 'end', value: 4 })]);
    expect(prop(one('a'), 'end')).toBe(4);
  });

  it('is not refused when the file already says it: an edit from outside brings the document up to the file', () => {
    const [shot] = all('shot');

    editor().applyExternal(() => editor().editProperty(shot!, 'start', 9));

    expect(refusals).toBe(0);
    expect(prop(shot!, 'start')).toBe(9);
    expect(edits).toEqual([expect.objectContaining({ external: true })]);
  });
});

describe('what an instance\'s own view says', () => {
  it('is nothing the file holds: selecting a shot selects it on the canvas and writes nothing', () => {
    const [shot] = all('shot');

    editor().select(shot!);

    expect(shot!.has(Selected)).toBe(true);
    expect(edits).toEqual([]);
    expect(refusals).toBe(0);
  });

  it('is written as ever for an element the project renders once', async () => {
    editor().select(one('a'));
    await Promise.resolve();

    expect(edits.map(({ edit }) => edit)).toEqual([expect.objectContaining({ kind: 'prop', source: 'index.tsx:a', name: 'selected', value: true })]);
  });
});

describe('a change to the shape of the document', () => {
  it('is not made to an element the project renders more than once: not removed, copied, or moved', () => {
    const before = tree();
    const [shot] = all('shot');

    expect(editor().remove(shot!)).toEqual([]);
    expect(editor().duplicateInPlace([shot!])).toEqual([]);
    expect(editor().duplicate(shot!)).toEqual([]);
    expect(editor().reparent(shot!, one('row'))).toBe(false);

    expect(shot!.isAlive()).toBe(true);
    expect(edits).toEqual([]);
    expect(refusals).toBe(4);
    expect(tree()).toBe(before);
  });

  it('is not made by adding to one or wrapping one', () => {
    const before = tree();
    const [shot] = all('shot');

    expect(editor().insertElement(shot!, () => Rect({ width: 10, height: 10 }))).toEqual([]);
    expect(editor().wrap(shot!, () => Sequence({ name: 'Row' }))).toBeNull();

    expect(edits).toEqual([]);
    expect(refusals).toBe(2);
    expect(tree()).toBe(before);
  });

  it('is not made by pasting into one either', () => {
    editor().copy(one('b'));
    const before = tree();

    expect(editor().paste(all('shot')[0]!)).toEqual([]);

    expect(edits).toEqual([]);
    expect(refusals).toBe(1);
    expect(tree()).toBe(before);
  });

  it('is made as ever to a clip the project renders once', async () => {
    const removed = editor().remove(one('b'));
    await Promise.resolve();

    expect(removed).toHaveLength(1);
    expect(refusals).toBe(0);
    expect(all('b')).toHaveLength(0);
  });
});

describe('the cutting tools', () => {
  it('make no cut in a generated clip', async () => {
    const before = tree();

    expect(razorAt(world, one('shot'), frame(1))).toEqual([]);
    await Promise.resolve();

    expect(refusals).toBeGreaterThan(0);
    expect(edits).toEqual([]);
    expect(tree()).toBe(before);
  });

  it('still cut a clip the project renders once, in the same project', async () => {
    const tails = razorAt(world, one('b'), frame(7));
    await Promise.resolve();

    expect(tails).toHaveLength(1);
    expect(refusals).toBe(0);
  });

  it('make no ripple delete when a clip that would move up is generated: nothing is deleted and nothing is moved', async () => {
    mounted.dispose();
    world.destroy();
    open(generatedRow());
    const before = tree();

    editor().select(one('a'));
    await Promise.resolve();
    edits = [];
    rippleDeleteSelection(world);
    await Promise.resolve();

    expect(one('a').isAlive()).toBe(true);
    expect(refusals).toBeGreaterThan(0);
    expect(edits).toEqual([]);
    expect(tree()).toBe(before);
  });
});
