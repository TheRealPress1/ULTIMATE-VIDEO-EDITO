import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { mount } from '@diffusionstudio/reconciler';
import { Culled, Source, createRuntimeWorld, getSolo, setSolo, transformSystem } from '@diffusionstudio/runtime';
import { bundle, el } from './project-fixture';

import type { Entity, World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// Two scenes at the same place on the stage, as a project with no positions makes them: the second is
// drawn over the first, and the program monitor must show one of them alone.
const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'one', { width: 540, height: 960, active: true }, [el('Rect', 'a', { width: 100, height: 100 })]),
  el('Scene', 'two', { width: 960, height: 540 }, [el('Group', 'g', {}, [el('Rect', 'b', { width: 100, height: 100 })])]),
]);

let world: World;
const find = (id: string): Entity => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const culled = (...ids: string[]) => ids.map((id) => find(id).has(Culled));

beforeEach(() => {
  world = createRuntimeWorld('solo');
  mount(bundle(project()), world);
  transformSystem(world);
});

describe('shown alone', () => {
  it('culls nothing while no scene is solo', () => {
    expect(getSolo(world)).toBeNull();
    expect(culled('one', 'a', 'two', 'g', 'b')).toEqual([false, false, false, false, false]);
  });

  it('culls every other scene and what is inside it, and only those', () => {
    setSolo(world, find('one'));
    transformSystem(world);
    expect(getSolo(world)).toBe(find('one'));
    expect(culled('one', 'a')).toEqual([false, false]);
    expect(culled('two', 'g', 'b')).toEqual([true, true, true]);
  });

  it('follows the scene it is moved to', () => {
    setSolo(world, find('one'));
    transformSystem(world);
    setSolo(world, find('two'));
    transformSystem(world);
    expect(culled('one', 'a')).toEqual([true, true]);
    expect(culled('two', 'g', 'b')).toEqual([false, false, false]);
  });

  it('shows every scene again once cleared', () => {
    setSolo(world, find('one'));
    transformSystem(world);
    setSolo(world, null);
    transformSystem(world);
    expect(getSolo(world)).toBeNull();
    expect(culled('one', 'a', 'two', 'g', 'b')).toEqual([false, false, false, false, false]);
  });
});
