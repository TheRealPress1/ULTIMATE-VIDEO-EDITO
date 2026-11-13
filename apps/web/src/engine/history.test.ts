import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { authoredTree, mount, renderAuthored } from '@diffusionstudio/reconciler';
import { createRuntimeWorld, Source } from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { bundle, canonical, el } from './project-fixture';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Rect', 'a', { x: 1, width: 10, height: 10 }),
    el('Rect', 'b', { x: 2, width: 10, height: 10 }),
    el('Rect', 'c', { x: 3, width: 10, height: 10 }),
  ]),
]);

let world: World;
let mounted: Mount;
let clock = 0;

const find = (id: string): Entity | undefined => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${id}`);
const editor = () => getDocumentEditor(world);
const history = () => getEditHistory(world);
const x = (id: string): unknown => authoredTree(world, find(id)!)?.props.x;
const tree = () => JSON.stringify(canonical(authoredTree(world, find('scene')!)));

/** An edit, closed on the microtask the way an edit outside a hold or group is. */
const edit = async (id: string, value: number): Promise<void> => {
  editor().editProperty(find(id)!, 'x', value);
  await Promise.resolve();
};

beforeEach(() => {
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  world = createRuntimeWorld('history-test');
  mounted = mount(bundle(project()), world);
  history().reset();
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
  vi.restoreAllMocks();
});

describe('a group', () => {
  it('is one step, however many edits it holds and however far apart they land', async () => {
    const step = history().beginGroup();
    editor().editProperty(find('a')!, 'x', 10);
    await Promise.resolve();
    clock += 5_000;
    editor().editProperty(find('b')!, 'x', 20);
    await Promise.resolve();
    editor().editProperty(find('a')!, 'x', 30);
    history().endGroup(step);

    expect([x('a'), x('b')]).toEqual([30, 20]);
    history().undo();
    expect([x('a'), x('b')]).toEqual([1, 2]);
    expect(history().canUndo()).toBe(false);
  });

  it('does not merge with the steps around it', async () => {
    await edit('a', 10);
    const step = history().beginGroup();
    editor().editProperty(find('a')!, 'x', 11);
    history().endGroup(step);
    await edit('a', 12);

    history().undo();
    expect(x('a')).toBe(11);
    history().undo();
    expect(x('a')).toBe(10);
    history().undo();
    expect(x('a')).toBe(1);
  });

  it('commits what it holds when the code in it throws, as long as it is closed in a finally', () => {
    const step = history().beginGroup();
    try {
      editor().editProperty(find('a')!, 'x', 10);
      throw new Error('stopped partway');
    } catch {
      // The caller rolls back or reports; the edits that were made are a step.
    } finally {
      history().endGroup(step);
    }
    expect(history().canUndo()).toBe(true);
    history().undo();
    expect(x('a')).toBe(1);
  });
});

describe('a group while a hold of the pointer is open', () => {
  it('leaves the hold one step of its own, with what came before and after the group in it', async () => {
    history().beginGesture();
    editor().editProperty(find('a')!, 'x', 10);
    await Promise.resolve();

    const step = history().beginGroup();
    editor().editProperty(find('b')!, 'x', 20);
    history().endGroup(step);

    editor().editProperty(find('a')!, 'x', 30);
    await Promise.resolve();
    history().endGesture();

    expect([x('a'), x('b')]).toEqual([30, 20]);

    // The hold is a step, taken back whole; the group is another, under it.
    history().undo();
    expect([x('a'), x('b')]).toEqual([1, 20]);
    history().undo();
    expect([x('a'), x('b')]).toEqual([1, 2]);
    expect(history().canUndo()).toBe(false);
  });

  it('puts the hold back so that it is still open: what is edited after the group is in it', async () => {
    history().beginGesture();
    editor().editProperty(find('a')!, 'x', 10);
    const step = history().beginGroup();
    editor().editProperty(find('b')!, 'x', 20);
    history().endGroup(step);

    // Separate microtasks, which would be separate steps if the hold had been lost.
    editor().editProperty(find('c')!, 'x', 30);
    await Promise.resolve();
    editor().editProperty(find('a')!, 'x', 40);
    await Promise.resolve();
    history().endGesture();

    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([1, 20, 3]);
    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([1, 2, 3]);
    expect(history().canUndo()).toBe(false);
  });

  it('still knows the hold\'s elements by the names the group gave them', async () => {
    // An element made in the hold, still waiting for its name from the file.
    history().beginGesture();
    const [created] = editor().insertElement(find('scene')!, () => renderAuthored({ tag: 'rect', props: { x: 7, width: 5, height: 5 }, children: [] }));
    const pending = created!.get(Source)!.value;

    // The name arrives while a group is open.
    const step = history().beginGroup();
    editor().editProperty(find('b')!, 'x', 20);
    editor().restamp({ [pending]: 'index.tsx:named' });
    history().endGroup(step);

    history().endGesture();

    const original = canonical(authoredTree(world, find('scene')!));
    history().undo();
    // The hold's insert is taken back by the name it has now.
    expect(find('named')).toBeUndefined();
    // Put back as it was (under a pending name, until the writer gives it one again).
    history().redo();
    expect(canonical(authoredTree(world, find('scene')!))).toEqual(original);
  });

  it('is itself set aside by a group inside it, and each comes back in order', async () => {
    history().beginGesture();
    editor().editProperty(find('a')!, 'x', 10);

    const outer = history().beginGroup();
    editor().editProperty(find('b')!, 'x', 20);
    const inner = history().beginGroup();
    editor().editProperty(find('c')!, 'x', 30);
    history().endGroup(inner);
    editor().editProperty(find('b')!, 'x', 25);
    history().endGroup(outer);

    editor().editProperty(find('a')!, 'x', 40);
    history().endGesture();

    // The hold, the group around, and the group inside: three steps.
    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([1, 25, 30]);
    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([1, 2, 30]);
    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([1, 2, 3]);
    expect(history().canUndo()).toBe(false);
  });

  it('is forgotten by a reset, with the rest of the history', () => {
    history().beginGesture();
    editor().editProperty(find('a')!, 'x', 10);
    history().beginGroup();
    history().reset();
    expect(history().canUndo()).toBe(false);

    // Nothing is left open or set aside: an edit is a step on its own again.
    editor().editProperty(find('b')!, 'x', 20);
    return Promise.resolve().then(() => {
      expect(history().canUndo()).toBe(true);
      history().undo();
      expect(x('b')).toBe(2);
      expect(history().canUndo()).toBe(false);
    });
  });
});

describe('who holds a gesture', () => {
  it('lets go of its own hold and no one else\'s: the stage hears every release in the window', async () => {
    history().beginGesture('timeline');
    editor().editProperty(find('a')!, 'x', 10);
    await Promise.resolve();

    // A release the stage's input heard, which is not its to act on.
    history().endGesture('stage');
    editor().editProperty(find('b')!, 'x', 20);
    await Promise.resolve();
    editor().editProperty(find('c')!, 'x', 30);
    await Promise.resolve();
    history().endGesture('timeline');

    // Still one step: nothing closed the hold in the middle.
    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([1, 2, 3]);
    expect(history().canUndo()).toBe(false);
  });

  it('stays open while any owner holds it, and closes when the last lets go', async () => {
    history().beginGesture('stage');
    editor().editProperty(find('a')!, 'x', 10);
    history().beginGesture('timeline');
    history().endGesture('stage');
    editor().editProperty(find('b')!, 'x', 20);
    await Promise.resolve();
    expect(x('b')).toBe(20);
    history().endGesture('timeline');

    history().undo();
    expect([x('a'), x('b')]).toEqual([1, 2]);
    expect(history().canUndo()).toBe(false);
  });

  it('starts a new step when the same owner begins again, but joins the one another owner has open', async () => {
    history().beginGesture('stage');
    editor().editProperty(find('a')!, 'x', 10);
    // The stage's release was lost, and it is pressed again: what was held is a step of its own.
    history().beginGesture('stage');
    editor().editProperty(find('b')!, 'x', 20);
    history().endGesture('stage');
    history().undo();
    expect([x('a'), x('b')]).toEqual([10, 2]);
    history().undo();
    expect(x('a')).toBe(1);

    history().redo();
    history().redo();
    history().beginGesture('timeline');
    editor().editProperty(find('c')!, 'x', 30);
    history().beginGesture('stage');
    editor().editProperty(find('c')!, 'x', 31);
    history().endGesture('stage');
    history().endGesture('timeline');
    history().undo();
    expect(x('c')).toBe(3);
  });
});

describe('a hold that is never let go of', () => {
  it('keeps what lands in it while it is recent, and does not take what comes much later', async () => {
    history().beginGesture();
    editor().editProperty(find('a')!, 'x', 10);
    await Promise.resolve();
    clock += 10_000;
    editor().editProperty(find('b')!, 'x', 20);
    await Promise.resolve();
    expect([x('a'), x('b')]).toEqual([10, 20]);

    // Long after the last edit, nobody has let go of it.
    clock += 60_000;
    editor().editProperty(find('c')!, 'x', 30);
    await Promise.resolve();
    editor().editProperty(find('c')!, 'x', 31);
    await Promise.resolve();

    // c's edits are no part of the hold: the hold is a step of a and b, and c has its own.
    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([10, 20, 3]);
    history().undo();
    expect([x('a'), x('b'), x('c')]).toEqual([1, 2, 3]);
    expect(history().canUndo()).toBe(false);
  });

  it('is not made stale by a press held still, with nothing edited, until something is', async () => {
    history().beginGesture();
    clock += 5_000;
    editor().editProperty(find('a')!, 'x', 10);
    clock += 5_000;
    editor().editProperty(find('a')!, 'x', 11);
    history().endGesture();

    expect(tree()).toContain('"x":11');
    history().undo();
    expect(x('a')).toBe(1);
    expect(history().canUndo()).toBe(false);
  });
});
