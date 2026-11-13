import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { LOOP_ATTR } from '@diffusionstudio/jsx';
import { authoredTree, mount } from '@diffusionstudio/reconciler';
import * as runtime from '@diffusionstudio/runtime';
import { createRuntimeWorld, recomputeEntityTimeRange, Selected, Source, syncInteractiveState } from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { applyExternalEdit, captureComposition, recordComposition } from './external-edit';
import { getEditHistory } from './history';
import { bundle, canonical, el } from './project-fixture';
import { firstDiff, snapshot } from './world-snapshot';

import type { Spec } from './project-fixture';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';
import type { EntityEdit } from './editor';

afterAll(() => vi.unstubAllGlobals());

const open: { world: World; mounted: Mount }[] = [];
afterEach(() => {
  for (const { world, mounted } of open.splice(0)) { mounted.dispose(); world.destroy(); }
});

const settle = (world: World): void => {
  syncInteractiveState(world);
  for (const scene of world.query(runtime.Scene)) recomputeEntityTimeRange(world, scene);
};

const mounted = (spec: Spec) => {
  const world = createRuntimeWorld('external-edit-test');
  const mounting = mount(bundle(spec), world);
  open.push({ world, mounted: mounting });
  return { world, mounted: mounting };
};

const find = (world: World, id: string): Entity => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;

// ---------------------------------------------------------------------------

const base = (): Spec => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080 }, [
    el('Sequence', 'seq', { name: 'A-roll' }, [
      el('Video', 'v1', { src: 'a.mp4', start: 0, end: 5, volume: -6 }),
      el('Video', 'v2', { src: 'b.mp4', start: 5, end: 12, sourceIn: 2 }),
      el('Video', 'v3', { src: 'c.mp4', start: 12, end: 20 }, [
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

/** The project with `change` applied, as a file edited by someone else would read. */
const edited = (change: (root: Spec) => void): Spec => {
  const root = base();
  change(root);
  return root;
};
const under = (root: Spec, id: string): Spec => {
  const visit = (spec: Spec): Spec | undefined => spec.id === id ? spec : spec.children?.map(visit).find(Boolean);
  return visit(root)!;
};

/** Patches a world mounted from `from` to `to` in place; a fresh mount of `to` is what it has to equal. */
const patch = (from: Spec, to: Spec) => {
  const live = mounted(from);
  const result = applyExternalEdit(live.world, live.mounted, bundle(to));
  return { ...live, result };
};
const equivalent = (from: Spec, to: Spec): void => {
  const live = patch(from, to);
  expect(live.result).toMatchObject({ applied: true });
  const reference = mounted(to);
  settle(live.world);
  settle(reference.world);
  expect(snapshot(live.world)).toEqual(snapshot(reference.world));
};

describe('an edit to the file is applied to the mounted project in place', () => {
  it('changes a value', () => {
    equivalent(base(), edited((root) => { under(root, 'v1').props!.end = 6; under(root, 'v2').props!.start = 6; }));
  });

  it('changes the media window and the volume of a clip', () => {
    equivalent(base(), edited((root) => { under(root, 'v2').props!.sourceIn = 4; under(root, 'v1').props!.volume = -12; }));
  });

  it('adds a prop', () => {
    equivalent(base(), edited((root) => { under(root, 'box').props!.opacity = 0.5; }));
  });

  it('changes what a text says', () => {
    equivalent(base(), edited((root) => { under(root, 'title').text = 'World'; }));
  });

  it('adds a clip at the end of a sequence', () => {
    equivalent(base(), edited((root) => { under(root, 'seq').children!.push(el('Video', 'v4', { src: 'd.mp4', start: 20, end: 30 })); }));
  });

  it('adds a clip between two others', () => {
    equivalent(base(), edited((root) => { under(root, 'seq').children!.splice(1, 0, el('Video', 'vx', { src: 'x.mp4', start: 5, end: 7 })); }));
  });

  it('removes a clip', () => {
    equivalent(base(), edited((root) => { under(root, 'seq').children!.splice(1, 1); }));
  });

  it('reorders clips', () => {
    equivalent(base(), edited((root) => { under(root, 'seq').children!.reverse(); }));
  });

  it('moves a clip into another parent', () => {
    equivalent(base(), edited((root) => {
      const [moved] = under(root, 'seq').children!.splice(2, 1);
      under(root, 'scene').children!.push(moved!);
    }));
  });

  it('adds a group with elements inside it', () => {
    equivalent(base(), edited((root) => {
      under(root, 'scene').children!.push(el('Group', 'grp2', { x: 5 }, [el('Rect', 'r2', { width: 50, height: 50 }), el('Text', 't2', { fontSize: 40 }, [], 'Inside')]));
    }));
  });

  it('adds an element to a clip', () => {
    equivalent(base(), edited((root) => { under(root, 'v1').children = [el('Animation', 'fade2', { type: 'fade', duration: 0.5 })]; }));
  });

  it('moves an existing clip into a group added around it', () => {
    equivalent(base(), edited((root) => {
      const [moved] = under(root, 'scene').children!.splice(1, 1);
      under(root, 'scene').children!.push(el('Group', 'wrap', {}, [moved!]));
    }));
  });

  it('does several of these at once', () => {
    equivalent(base(), edited((root) => {
      under(root, 'v1').props!.end = 4;
      under(root, 'seq').children!.splice(1, 1);
      under(root, 'seq').children!.push(el('Video', 'v9', { src: 'z.mp4', start: 16, end: 18 }));
      under(root, 'title').text = 'Changed';
      under(root, 'box').props!.x = 99;
    }));
  });

  it('does nothing for an edit that changes no element', () => {
    const live = patch(base(), base());
    expect(live.result).toEqual({ applied: true, changes: 0, undoable: false });
    expect(getEditHistory(live.world).canUndo()).toBe(false);
  });
});

describe('what it leaves alone', () => {
  it('keeps the entities that stay, the selection and the history', () => {
    const live = mounted(base());
    const editor = getDocumentEditor(live.world);
    const history = getEditHistory(live.world);
    const [v1, v2, box] = ['v1', 'v2', 'box'].map((id) => find(live.world, id)) as [Entity, Entity, Entity];
    const ids = [v1.id(), v2.id(), box.id()];

    editor.select(v2);
    editor.editProperty(box, 'x', 50);
    expect(history.canUndo()).toBe(true);

    const to = edited((root) => { under(root, 'v1').props!.end = 4; under(root, 'seq').children!.push(el('Video', 'v4', { src: 'd.mp4', start: 20, end: 30 })); });
    // The file has what the editor wrote and what someone else added.
    under(to, 'box').props!.x = 50;
    const result = applyExternalEdit(live.world, live.mounted, bundle(to));
    expect(result).toMatchObject({ applied: true });

    expect([find(live.world, 'v1').id(), find(live.world, 'v2').id(), find(live.world, 'box').id()]).toEqual(ids);
    expect(find(live.world, 'v2').has(Selected)).toBe(true);
    expect(history.canUndo()).toBe(true);

    // The user's own step is still under the one the file edit made.
    history.undo();
    expect(find(live.world, 'v4')).toBeUndefined();
    history.undo();
    expect(find(live.world, 'box').get(runtime.Position)?.x).toBe(10);
  });

  it('is one step in the history, and an undo takes the file edit back', () => {
    const from = base();
    const to = edited((root) => {
      under(root, 'v1').props!.end = 4;
      under(root, 'seq').children!.splice(1, 1);
      under(root, 'title').text = 'World';
    });
    const live = patch(from, to);
    expect(live.result).toMatchObject({ applied: true });
    const history = getEditHistory(live.world);
    const reference = mounted(from);
    const tree = (world: World) => authoredTree(world, find(world, 'scene'));
    expect(tree(live.world)).not.toEqual(tree(reference.world));

    history.undo();
    expect(history.canUndo()).toBe(false);
    // The clip comes back as an insert (a stamp of its own once the writer names it), in its place and as it was.
    expect(tree(live.world)).toEqual(tree(reference.world));

    history.redo();
    expect(find(live.world, 'v1').get(runtime.Trim)?.end).toBe(find(mounted(to).world, 'v1').get(runtime.Trim)?.end);
    expect(tree(live.world)?.children[0]?.children.map((child) => child.props.src)).toEqual(['a.mp4', 'c.mp4']);
  });

  it('is a step of its own when it lands while a hold of the pointer is open, which stays whole', () => {
    const live = mounted(base());
    const editor = getDocumentEditor(live.world);
    const history = getEditHistory(live.world);
    const prop = (id: string, name: string): unknown => authoredTree(live.world, find(live.world, id))?.props[name];

    // A drag in flight on the box.
    history.beginGesture();
    editor.editProperty(find(live.world, 'box'), 'x', 50);

    // The file changes under it: someone else trims a clip.
    const to = edited((root) => { under(root, 'v1').props!.end = 4; under(root, 'box').props!.x = 50; });
    expect(applyExternalEdit(live.world, live.mounted, bundle(to))).toMatchObject({ applied: true, undoable: true });

    editor.editProperty(find(live.world, 'box'), 'y', 60);
    history.endGesture();
    expect([prop('box', 'x'), prop('box', 'y'), prop('v1', 'end')]).toEqual([50, 60, 4]);

    // The drag, whole, and then the trim; neither carried the other.
    history.undo();
    expect([prop('box', 'x'), prop('box', 'y'), prop('v1', 'end')]).toEqual([10, 20, 4]);
    history.undo();
    expect(prop('v1', 'end')).toBe(5);
    expect(history.canUndo()).toBe(false);
  });

  it('does not tell the writer, but does when the edit is undone', () => {
    const live = mounted(base());
    const editor = getDocumentEditor(live.world);
    const written: EntityEdit[] = [];
    const heard: EntityEdit[] = [];
    editor.onWrite((edit) => written.push(edit));
    editor.onEdit((edit, external) => { if (external) heard.push(edit); });

    const to = edited((root) => { under(root, 'v1').props!.end = 4; under(root, 'seq').children!.push(el('Video', 'v4', { src: 'd.mp4', start: 20, end: 30 })); });
    expect(applyExternalEdit(live.world, live.mounted, bundle(to))).toMatchObject({ applied: true });
    expect(written).toEqual([]);
    expect(heard.map((edit) => edit.kind).sort()).toEqual(['insert', 'prop']);

    getEditHistory(live.world).undo();
    expect(written.map((edit) => edit.kind).sort()).toEqual(['prop', 'remove']);
  });

  it('does not touch where the user is looking', () => {
    const live = mounted(edited((root) => { under(root, 'scene').props!.playhead = 1; under(root, 'v1').props!.selected = true; }));
    const editor = getDocumentEditor(live.world);
    editor.select(find(live.world, 'v3'));

    // The file still has the old selection and playhead.
    const to = edited((root) => { under(root, 'scene').props!.playhead = 1; under(root, 'v1').props!.selected = true; under(root, 'box').props!.x = 77; });
    expect(applyExternalEdit(live.world, live.mounted, bundle(to))).toMatchObject({ applied: true, changes: 1 });
    expect(find(live.world, 'v3').has(Selected)).toBe(true);
    expect(find(live.world, 'v1').has(Selected)).toBe(false);
  });

  it('ignores a value the file has only rounded', () => {
    const live = mounted(base());
    getDocumentEditor(live.world).editProperty(find(live.world, 'box'), 'x', 10.123456);
    const to = edited((root) => { under(root, 'box').props!.x = 10.12; });
    expect(applyExternalEdit(live.world, live.mounted, bundle(to))).toEqual({ applied: true, changes: 0, undoable: false });
    expect(find(live.world, 'box').get(runtime.Position)?.x).toBe(10.123456);
  });
});

describe('what it declines to do in place', () => {
  const declined = (to: Spec, reason: RegExp, from: Spec = base()): void => {
    const live = mounted(from);
    const result = applyExternalEdit(live.world, live.mounted, bundle(to));
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toMatch(reason);
  };

  it('a scene added', () => {
    declined(edited((root) => { root.children!.push(el('Scene', 'scene2', { width: 1080, height: 1920 })); }), /scenes were added/);
  });

  it('a scene removed', () => {
    declined(edited((root) => { root.children = []; }), /scenes were added, removed/);
  });

  it('an element that became another', () => {
    declined(edited((root) => { under(root, 'box').tag = 'Group'; }), /became/);
  });

  it('a loop', () => {
    declined(edited((root) => { under(root, 'box').props![LOOP_ATTR] = 'index.tsx:9'; }), /loop/, edited((root) => { under(root, 'box').props![LOOP_ATTR] = 'index.tsx:9'; }));
  });

  it('a prop that is not plain data', () => {
    const withFunction = (): Spec => edited((root) => { (under(root, 'box').props as Record<string, unknown>).draw = '__FUNCTION__'; });
    const live = mounted(base());
    const code = bundle(withFunction()).replace('"__FUNCTION__"', '() => 1');
    const result = applyExternalEdit(live.world, live.mounted, code);
    expect(result.applied).toBe(false);
  });

  it('a new background for the stage', () => {
    declined(edited((root) => { root.props = { background: '#112233' }; }), /background/);
  });

  it('a file that does not render', () => {
    const live = mounted(base());
    const result = applyExternalEdit(live.world, live.mounted, 'module.exports.default = () => { throw new Error("boom"); };');
    expect(result).toEqual({ applied: false, reason: 'boom' });
  });
});

describe('the record of a file', () => {
  it('says what a mount of the file holds', () => {
    const reference = mounted(base());
    expect(recordComposition(bundle(base()))).toEqual(captureComposition(reference.world));
  });

  it('keeps the text a <text> holds, and not the words of a caption', () => {
    type Recorded = ReturnType<typeof recordComposition>['scenes'][number];
    const treeOf = (trees: Recorded[], source: string): Recorded | undefined => {
      for (const tree of trees) {
        const found = tree.source === source ? tree : treeOf(tree.children, source);
        if (found) return found;
      }
      return undefined;
    };
    const { scenes } = recordComposition(bundle(base()));
    expect(treeOf(scenes, 'index.tsx:title')?.text).toBe('Hello');
    expect(treeOf(scenes, 'index.tsx:cap')).toBeDefined();
    expect(treeOf(scenes, 'index.tsx:cap')?.text).toBeUndefined();
  });

  it('is of a file that does not render: it throws, like a mount', () => {
    expect(() => recordComposition('module.exports.default = () => { throw new Error("boom"); };')).toThrow('boom');
  });
});

describe('the comparison itself', () => {
  it('tells a project that was not patched from one that was', () => {
    const live = mounted(base());
    const reference = mounted(edited((root) => { under(root, 'v1').props!.end = 4; }));
    settle(live.world);
    settle(reference.world);
    expect(snapshot(live.world)).not.toEqual(snapshot(reference.world));
  });

  it('tells the order of the clips', () => {
    const live = mounted(base());
    const reference = mounted(edited((root) => { under(root, 'seq').children!.reverse(); }));
    settle(live.world);
    settle(reference.world);
    expect(snapshot(live.world)).not.toEqual(snapshot(reference.world));
  });
});

/** Two values of every prop worth editing, by the element that carries it in the fixture. */
const MATRIX: Record<string, Record<string, [unknown, unknown]>> = {
  v2: { name: ['X', 'Y'], x: [11, 12], y: [22, 23], offsetX: [5, 6], offsetY: [6, 7], width: [300, 400], height: [200, 300], keepAspectRatio: [true, false], constrainX: ['right', 'center'], constrainY: ['bottom', 'center'], rotation: [15, 30], pivotX: [10, 20], pivotY: [20, 30], scale: [2, 3], scaleX: [2, 3], scaleY: [3, 4], opacity: [0.5, 0.7], cornerRadius: [12, 20], cornerRadiusTopLeft: [4, 8], blendMode: ['multiply', 'screen'], hidden: [true, false], start: [1, 3], end: [3, 9], sourceIn: [1, 4], sourceOut: [2, 9], playbackRate: [2, 0.5], volume: [-3, -9], muted: [true, false], objectFit: ['contain', 'fill'], transition: [{ type: 'dissolve' }, { type: 'dissolve', duration: 1 }] },
  v1: { volume: [-12, -3], sourceIn: [3, 1], end: [7, 2], start: [1, 2], muted: [true, false] },
  box: { fill: ['#00ff00', '#0000ff'], x: [11, 12], y: [22, 23], width: [400, 500], height: [250, 350], opacity: [0.4, 0.8], rotation: [10, 20], cornerRadius: [8, 16], scale: [1.5, 2], hidden: [true, false], blendMode: ['screen', 'multiply'], name: ['Box', 'Box2'], start: [1, 2], end: [3, 6] },
  title: { color: ['#00ff00', '#0000ff'], fontSize: [40, 50], fontFamily: ['Roboto', 'Inter'], fontWeight: ['bold', 700], fontStyle: ['italic', 'normal'], letterSpacing: [4, 5], textCase: ['upper', 'lower'], textAlign: ['center', 'right'], textBaseline: ['middle', 'bottom'], leading: [1.5, 2], x: [5, 6], y: [6, 7], width: [500, 600], height: [100, 200], opacity: [0.5, 0.6], start: [2, 3], end: [6, 7], name: ['T', 'U'] },
  scene: { fill: ['#101010', '#202020'], volume: [-2, -4], name: ['S', 'S2'], x: [20, 30], y: [30, 40], keepAspectRatio: [true, false], width: [1280, 1000], height: [720, 600] },
  seq: { name: ['Row', 'Row2'], x: [1, 2], y: [2, 3], hidden: [true, false], volume: [-1, -2] },
  img: { name: ['I', 'J'], x: [11, 12], y: [22, 23], opacity: [0.5, 0.7], hidden: [true, false], start: [1, 2], end: [4, 5], objectFit: ['contain', 'fill'], scale: [2, 3], blendMode: ['screen', 'multiply'], cornerRadius: [4, 8], rotation: [5, 6], width: [300, 400], height: [200, 300], sourceIn: [1, 2] },
  aud: { volume: [-3, -9], muted: [true, false], start: [1, 3], end: [20, 25], sourceIn: [1, 4], sourceOut: [10, 20], playbackRate: [2, 0.5], name: ['A', 'B'], x: [1, 2], y: [1, 2], width: [400, 500], height: [100, 200] },
  grp: { x: [7, 8], y: [8, 9], opacity: [0.5, 0.7], rotation: [10, 20], scale: [2, 3], hidden: [true, false], name: ['G', 'H'], start: [1, 2], end: [4, 5], blendMode: ['screen', 'multiply'] },
  ell: { fill: ['#00ff00', '#ff00ff'], x: [7, 8], y: [8, 9], opacity: [0.5, 0.7], rotation: [10, 20], width: [90, 100], height: [90, 100], name: ['E', 'F'], hidden: [true, false], scale: [2, 3] },
  cap: { preset: ['whisper', 'stark'], colors: [['#ffffff'], ['#000000']], verticalAlign: ['top', 'center'], offsetX: [4, 5], offsetY: [6, 7], start: [1, 2], end: [9, 8], sourceIn: [1, 2], sourceOut: [8, 9], name: ['C', 'D'] },
  fade: { type: ['grow', 'spin'], phase: ['out', 'in'], duration: [1, 2], delay: [0.5, 1], name: ['an', 'am'] },
  fx: { type: ['brightness', 'contrast'], value: [0.5, 0.8], hidden: [true, false], name: ['f1', 'f2'] },
};

/** What an edit to one prop comes to, compared with a fresh mount of the file it produced; undefined when they match. */
const propEdit = (mode: 'change' | 'add' | 'remove', target: string, prop: string, a: unknown, b: unknown): { applied: boolean; reason?: string; differs?: string } => {
  const withValue = (value: unknown) => edited((root) => { under(root, target).props![prop] = value; });
  const without = () => edited((root) => { delete under(root, target).props![prop]; });
  const [from, to] = mode === 'change' ? [withValue(a), withValue(b)] : mode === 'add' ? [without(), withValue(a)] : [withValue(a), without()];
  try {
    const live = patch(from, to);
    if (!live.result.applied) return { applied: false, reason: live.result.reason };
    const reference = mounted(to);
    settle(live.world);
    settle(reference.world);
    const differs = JSON.stringify(snapshot(live.world)) !== JSON.stringify(snapshot(reference.world))
      ? 'the stage differs from a fresh mount'
      : JSON.stringify(recordComposition(bundle(to))) !== JSON.stringify(captureComposition(reference.world)) ? 'the record differs from what a mount holds' : undefined;
    return { applied: true, ...(differs ? { differs } : {}) };
  } finally {
    for (const { world, mounted: mounting } of open.splice(0)) { mounting.dispose(); world.destroy(); }
  }
};

describe('every prop of every kind of element', () => {
  it.each(Object.entries(MATRIX))('%s: a changed or added prop matches a fresh mount, a removed one does too or is declined', (target, props) => {
    const wrong: string[] = [];
    for (const [prop, [a, b]] of Object.entries(props)) {
      for (const mode of ['change', 'add'] as const) {
        const outcome = propEdit(mode, target, prop, a, b);
        if (!outcome.applied) wrong.push(`${mode} ${target}.${prop} was declined: ${outcome.reason}`);
        else if (outcome.differs) wrong.push(`${mode} ${target}.${prop}: ${outcome.differs}`);
      }
      const removal = propEdit('remove', target, prop, a, b);
      if (removal.applied && removal.differs) wrong.push(`remove ${target}.${prop}: ${removal.differs}`);
      if (!removal.applied && !/was taken off/.test(removal.reason ?? '')) wrong.push(`remove ${target}.${prop} was declined for another reason: ${removal.reason}`);
    }
    expect(wrong).toEqual([]);
  });

  it('does take the common props off in place', () => {
    const inPlace = ['v1.volume', 'v1.start', 'v1.end', 'v2.sourceIn', 'v2.muted', 'v2.transition', 'v2.opacity', 'box.fill', 'box.x', 'title.color', 'title.fontSize', 'title.textAlign', 'scene.fill', 'aud.volume', 'img.objectFit', 'grp.hidden'];
    const declined = inPlace.filter((name) => {
      const [target, prop] = name.split('.') as [string, string];
      const [a, b] = MATRIX[target]![prop]!;
      return !propEdit('remove', target, prop, a, b).applied;
    });
    expect(declined).toEqual([]);
  });

  it('declines to take a prop off a caption, whose length depends on what happened before', () => {
    for (const prop of ['end', 'start', 'preset', 'sourceOut']) {
      const [a, b] = MATRIX.cap![prop]!;
      expect(propEdit('remove', 'cap', prop, a, b)).toMatchObject({ applied: false, reason: expect.stringMatching(/was taken off/) });
    }
  });

  it('declines to take off a size, a rotation, a per-axis scale or an offset, which keep what they had', () => {
    for (const [target, prop] of [['v2', 'width'], ['box', 'height'], ['v2', 'rotation'], ['v2', 'scaleX'], ['v2', 'offsetX'], ['scene', 'width']] as const) {
      const [a, b] = MATRIX[target]![prop]!;
      expect(propEdit('remove', target, prop, a, b)).toMatchObject({ applied: false, reason: expect.stringMatching(/was taken off/) });
    }
  });
});

// A small seeded generator: the same edits every run, so a failure can be replayed.
const generator = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (below: number): number => Math.floor(next() * below),
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (probability: number): boolean => next() < probability,
  };
};

const REMOVABLE_SAMPLE = ['volume', 'muted', 'opacity', 'x', 'y', 'start', 'end', 'sourceIn', 'name', 'hidden', 'blendMode', 'scale', 'fill', 'color', 'fontSize'];

/** A few random edits of the kind a person or an agent makes to a file. */
const mutate = (root: Spec, seed: number): void => {
  const random = generator(seed);
  const all: Spec[] = [];
  const walk = (spec: Spec): void => { all.push(spec); spec.children?.forEach(walk); };
  walk(root);
  const containers = (): Spec[] => all.filter((spec) => ['Scene', 'Sequence', 'Group'].includes(spec.tag));
  let fresh = 0;

  for (let step = 0, count = 1 + random.int(5); step < count; step++) {
    const spec = random.pick(all.filter((candidate) => candidate.tag !== 'Stage'));
    switch (random.int(9)) {
      case 0: { // change a number
        const names = Object.entries(spec.props ?? {}).filter(([, value]) => typeof value === 'number').map(([name]) => name);
        if (names.length) spec.props![random.pick(names)] = Math.round(random.int(2000)) / 10;
        break;
      }
      case 1: // add a prop
        if (spec.tag !== 'Sequence' && spec.tag !== 'Animation' && spec.tag !== 'Effect') (spec.props ??= {}).opacity = Math.round(random.int(100)) / 100;
        break;
      case 2: { // take a prop off
        const names = Object.keys(spec.props ?? {}).filter((name) => REMOVABLE_SAMPLE.includes(name));
        if (names.length) delete spec.props![random.pick(names)];
        break;
      }
      case 3: // retype a text
        if (spec.tag === 'Text') spec.text = `Line ${random.int(100)}`;
        break;
      case 4: { // add a clip
        const into = random.pick(containers());
        const clip = el('Video', `new${seed}-${fresh++}`, { src: `n${random.int(9)}.mp4`, start: random.int(30), end: 30 + random.int(30) });
        into.children!.splice(random.int(into.children!.length + 1), 0, clip);
        all.push(clip);
        break;
      }
      case 5: { // drop an element
        const parent = all.find((candidate) => candidate.children?.includes(spec));
        if (parent && spec.tag !== 'Scene' && spec.tag !== 'Stage') parent.children!.splice(parent.children!.indexOf(spec), 1);
        break;
      }
      case 6: { // reorder
        const parent = random.pick(containers());
        const kids = parent.children!;
        if (kids.length > 1) { const from = random.int(kids.length); const [moved] = kids.splice(from, 1); kids.splice(random.int(kids.length + 1), 0, moved!); }
        break;
      }
      case 7: { // move an element somewhere else
        const parent = all.find((candidate) => candidate.children?.includes(spec));
        const target = random.pick(containers());
        const inside = (outer: Spec, inner: Spec): boolean => outer === inner || (outer.children ?? []).some((child) => inside(child, inner));
        if (parent && spec.tag !== 'Scene' && spec.tag !== 'Stage' && !inside(spec, target)) {
          parent.children!.splice(parent.children!.indexOf(spec), 1);
          target.children!.splice(random.int(target.children!.length + 1), 0, spec);
        }
        break;
      }
      case 8: // give a clip something to wear
        if (spec.tag === 'Video' || spec.tag === 'Rect') (spec.children ??= []).push(el('Effect', `fx${seed}-${fresh++}`, { type: 'blur', value: random.int(10) }));
        break;
    }
  }
};

// A longer run for a soak: EXTERNAL_EDIT_SEEDS=5000 npx vitest run src/engine/external-edit.test.ts
const SEEDS = Number(process.env.EXTERNAL_EDIT_SEEDS ?? 300);

describe('random edits to the file', () => {
  it('match a fresh mount, can be undone and redone, or are declined', () => {
    let applied = 0;
    let declined = 0;
    const reasons = new Map<string, number>();
    const wrong: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const to = base();
      mutate(to, seed);
      const live = mounted(base());
      const history = getEditHistory(live.world);
      const result = applyExternalEdit(live.world, live.mounted, bundle(to));
      try {
        if (!result.applied) { declined++; const why = result.reason.replace(/index\.tsx:\S+/g, '<name>'); reasons.set(why, (reasons.get(why) ?? 0) + 1); continue; }
        applied++;
        const reference = mounted(to);
        settle(live.world);
        settle(reference.world);
        const differs = firstDiff(snapshot(live.world), snapshot(reference.world));
        if (differs) { wrong.push(`seed ${seed}: differs from a fresh mount at ${differs}`); continue; }
        const recorded = firstDiff(recordComposition(bundle(to)), captureComposition(reference.world));
        if (recorded) { wrong.push(`seed ${seed}: the record differs from what a mount holds at ${recorded}`); continue; }

        const tree = (world: World) => JSON.stringify(canonical(authoredTree(world, find(world, 'scene'))));
        const wanted = tree(live.world);
        if (result.changes === 0) continue;
        history.undo();
        const original = mounted(base());
        if (tree(live.world) !== tree(original.world)) { wrong.push(`seed ${seed}: undo did not restore the project`); continue; }
        history.redo();
        if (tree(live.world) !== wanted) wrong.push(`seed ${seed}: redo did not reapply the edit`);
      } finally {
        for (const { world, mounted: mounting } of open.splice(0)) { mounting.dispose(); world.destroy(); }
      }
    }
    expect(wrong).toEqual([]);
    // Most edits are ones it can make in place; the test is of the ones it does.
    expect(applied, JSON.stringify([...reasons])).toBeGreaterThan(SEEDS * 0.65);
    expect(applied + declined).toBe(SEEDS);
  }, Math.max(20_000, SEEDS * 25));
});

// A template renders one element per item of its data, every one under the same stamp.
interface Shot { start: number; end: number; src?: string; card?: boolean }

const shotElements = (shots: Shot[]): Spec[] => shots.map((shot, index) => el('Group', 'shot', { name: `Shot ${index + 1}`, start: shot.start, end: shot.end },
  shot.card
    ? [el('Rect', 'shotcard', { width: 100, height: 100, fill: '#0b1630' }), el('Rect', 'shotaccent', { x: 9, y: 76, width: 12, height: 12, fill: '#db0a40' })]
    : [el('Image', 'shotimg', { src: shot.src ?? `${index}.png`, width: 1080, height: 1920 })]));

/** The base project with a template's elements after its own. */
const shots = (items: Shot[], change: (root: Spec) => void = () => {}): Spec => {
  const root = base();
  under(root, 'scene').children!.push(...shotElements(items));
  change(root);
  return root;
};

/** Whether two elements of the project share an id. */
const repeatsAnId = (root: Spec): boolean => {
  const seen = new Set<string>();
  const visit = (spec: Spec): boolean => seen.has(spec.id) || (seen.add(spec.id), (spec.children ?? []).some(visit));
  return visit(root);
};

const three: Shot[] = [{ start: 0, end: 2 }, { start: 2, end: 4, card: true }, { start: 4, end: 6 }];

describe('a project built from templates', () => {
  it('has an edit to one item made in place', () => {
    equivalent(shots(three), shots([three[0]!, { ...three[1]!, end: 5 }, three[2]!]));
  });

  it('gets an item added at the end', () => {
    equivalent(shots(three), shots([...three, { start: 6, end: 8, src: 'new.png' }]));
  });

  it('gets an item added in the middle, the ones after it taking its place one by one', () => {
    equivalent(shots(three), shots([three[0]!, { start: 1, end: 3, src: 'new.png' }, three[1]!, three[2]!]));
  });

  it('loses an item from the end, or from the middle', () => {
    equivalent(shots(three), shots(three.slice(0, 2)));
    equivalent(shots(three), shots([three[0]!, three[2]!]));
  });

  it('has an item change what it is made of', () => {
    equivalent(shots(three), shots([{ ...three[0]!, card: true }, three[1]!, { ...three[2]!, card: true }]));
    equivalent(shots(three), shots([three[0]!, { ...three[1]!, card: false, src: 'img.png' }, three[2]!]));
  });

  it('has the items emptied, and filled again', () => {
    equivalent(shots(three), shots([]));
    equivalent(shots([]), shots(three));
  });

  it('has an element beside the template edited, with it', () => {
    equivalent(shots(three), shots([three[0]!, { ...three[1]!, end: 5 }, three[2]!], (root) => { under(root, 'v1').props!.end = 4; under(root, 'title').text = 'World'; }));
  });

  it('is edited without a step in the history: it could not be put back by name', () => {
    const live = mounted(shots(three));
    const history = getEditHistory(live.world);
    // The user's own edit, which an undo is to take back after the file's.
    getDocumentEditor(live.world).editProperty(find(live.world, 'box'), 'x', 50);
    expect(history.canUndo()).toBe(true);

    const to = shots([three[0]!, { ...three[1]!, end: 5 }, three[2]!], (root) => { under(root, 'box').props!.x = 50; under(root, 'v1').props!.end = 4; });
    const result = applyExternalEdit(live.world, live.mounted, bundle(to));
    expect(result).toMatchObject({ applied: true, undoable: false });
    expect(find(live.world, 'v1').get(runtime.Trim)?.end).toBeDefined();

    // One step is left, the user's; the file's edit is not in it.
    history.undo();
    expect(history.canUndo()).toBe(false);
    expect(find(live.world, 'box').get(runtime.Position)?.x).toBe(10);
    expect(find(live.world, 'v1').get(runtime.Trim)?.end).toBeDefined();
  });

  it('is told to be undoable only when it was', () => {
    expect(patch(base(), edited((root) => { under(root, 'v1').props!.end = 4; })).result).toMatchObject({ applied: true, undoable: true });
    expect(patch(shots(three), shots(three, (root) => { under(root, 'v1').props!.end = 4; })).result).toMatchObject({ applied: true, undoable: false });
    expect(patch(base(), base()).result).toMatchObject({ applied: true, undoable: false });
  });

  it('matches a fresh mount over many random edits to its items and to what is beside them', () => {
    const wrong: string[] = [];
    let applied = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = generator(seed * 7919);
      const items = (): Shot[] => Array.from({ length: random.int(6) }, (_, index) => ({ start: random.int(20), end: 20 + random.int(20), card: random.chance(0.4), src: `s${random.int(5)}-${index}.png` }));
      const from = shots(items());
      const to = shots(items());
      mutate(to, seed);
      const live = mounted(from);
      const result = applyExternalEdit(live.world, live.mounted, bundle(to));
      try {
        if (!result.applied) {
          if (!/was taken off/.test(result.reason)) wrong.push(`seed ${seed}: declined: ${result.reason}`);
          continue;
        }
        applied++;
        const reference = mounted(to);
        settle(live.world);
        settle(reference.world);
        const differs = firstDiff(snapshot(live.world), snapshot(reference.world));
        // A stamp is repeated only while two elements have it; with fewer it names one, and the edit is a step like any.
        if (differs) wrong.push(`seed ${seed}: differs from a fresh mount at ${differs}`);
        else if ([from, to].some(repeatsAnId) && result.undoable) wrong.push(`seed ${seed}: an edit to a template was taken as a step`);
      } finally {
        for (const { world, mounted: mounting } of open.splice(0)) { mounting.dispose(); world.destroy(); }
      }
    }
    expect(wrong).toEqual([]);
    expect(applied).toBeGreaterThan(SEEDS * 0.5);
  }, Math.max(60_000, SEEDS * 25));
});

describe('a large project', () => {
  /** Six hundred clips in nine sequences, with titles and shapes between them. */
  const large = (): Spec => el('Stage', 'stage', {}, [
    el('Scene', 'scene', { width: 1920, height: 1080 }, [
      ...Array.from({ length: 9 }, (_, row) => el('Sequence', `seq${row}`, { name: `Row ${row}` },
        Array.from({ length: 67 }, (_, clip) => el('Video', `clip${row}-${clip}`, { src: `c${clip}.mp4`, start: clip * 5, end: clip * 5 + 5, volume: -3 })))),
      ...Array.from({ length: 60 }, (_, index) => el('Text', `t${index}`, { x: index, y: index, fontSize: 40 }, [], `Title ${index}`)),
    ]),
  ]);

  const timed = (label: string, change: (root: Spec) => void): number => {
    const live = mounted(large());
    const to = large();
    change(to);
    const start = performance.now();
    const result = applyExternalEdit(live.world, live.mounted, bundle(to));
    const took = performance.now() - start;
    expect(result, label).toMatchObject({ applied: true });
    for (const { world, mounted: mounting } of open.splice(0)) { mounting.dispose(); world.destroy(); }
    return took;
  };

  it('is brought up to date in tens of milliseconds per edit', () => {
    const took = {
      none: timed('no change', () => {}),
      prop: timed('one prop', (root) => { under(root, 'clip3-10').props!.end = 99; }),
      text: timed('one text', (root) => { under(root, 't7').text = 'Changed'; }),
      insert: timed('one clip', (root) => { under(root, 'seq4').children!.splice(30, 0, el('Video', 'fresh', { src: 'f.mp4', start: 1, end: 2 })); }),
      remove: timed('one clip dropped', (root) => { under(root, 'seq4').children!.splice(30, 1); }),
      reorder: timed('a clip moved', (root) => { const kids = under(root, 'seq2').children!; kids.splice(0, 0, kids.splice(60, 1)[0]!); }),
    };
    // About 15 ms each, 50 for a removal; a mount of the same project is about 360. The bound is loose
    // because the machine running this may be busy, and tight enough to catch a step that grows with the
    // square of the project.
    for (const [label, ms] of Object.entries(took)) expect(ms, `${label} took ${Math.round(ms)} ms (${JSON.stringify(took)})`).toBeLessThan(300);
  }, 60_000);
});
