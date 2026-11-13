import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { mount, recordProject } from '@diffusionstudio/reconciler';
import { createRuntimeWorld } from '@diffusionstudio/runtime';

import type { Mount } from '@diffusionstudio/reconciler';
import type { World } from 'koota';

// These run on the reactive build of Solid (vitest.solid.config.ts): under the
// server build nothing tracks a signal, so nothing could be seen to depend on one.

afterAll(() => vi.unstubAllGlobals());

const open: { world: World; mounted: Mount }[] = [];
afterEach(() => {
  for (const { world, mounted } of open.splice(0)) { mounted.dispose(); world.destroy(); }
});

const mounted = (code: string): Mount => {
  const world = createRuntimeWorld('mount-reactive-test');
  const mounting = mount(code, world);
  open.push({ world, mounted: mounting });
  return mounting;
};

/**
 * A project whose one rect has `prop` as written. `before` runs at the top of
 * the module, `inside` at the top of the component (where a hook is called).
 */
const project = (prop: string, before = '', inside = ''): string => `const { Stage, Scene, Rect, useTicker, __inspect } = require('@diffusionstudio/jsx');
const { createSignal } = require('solid-js');
${before}
module.exports.default = () => { ${inside}
  return Stage({ __source: 'index.tsx:stage', get children() { return Scene({ __source: 'index.tsx:scene', width: 1920, height: 1080,
    get children() { return Rect({ __source: 'index.tsx:rect', ${prop} }); } }); } });
};`;

describe('whether a record of a project depends on a signal', () => {
  const reactive = (code: string): boolean => recordProject(code).reactive;

  it('is not, for a project that only says literal things or works a prop out from constants', () => {
    expect(reactive(project('x: 10, width: 100, height: 100'))).toBe(false);
    expect(reactive(project('get x() { return 5 * 2; }', 'const base = 5;'))).toBe(false);
    expect(reactive(project('x: start', 'const [count] = createSignal(3); const start = count();'))).toBe(false);
  });

  it('is, for a prop that follows a signal, an @inspect variable or the timeline', () => {
    expect(reactive(project('get x() { return count(); }', 'const [count] = createSignal(3);'))).toBe(true);
    expect(reactive(project('get width() { return size(); }', "const size = __inspect({ file: 'index.tsx', name: 'size', type: 'number' }, 100);"))).toBe(true);
    expect(reactive(project('get x() { return ticker.time(); }', '', 'const ticker = useTicker();'))).toBe(true);
    expect(reactive(project('get x() { return pixels(); }', '', 'const pixels = useResolution();').replace('useTicker,', 'useTicker, useResolution,'))).toBe(true);
  });
});

describe('whether a mount still depends on a signal', () => {
  it('is not, for a project that only says literal things', () => {
    expect(mounted(project('x: 10, width: 100, height: 100')).reactive()).toBe(false);
  });

  it('is not, for a prop worked out from constants', () => {
    expect(mounted(project('get x() { return 5 * 2; }', 'const base = 5;')).reactive()).toBe(false);
  });

  it('is not, for a signal read once at the top of the module, outside anything that tracks', () => {
    expect(mounted(project('x: start', 'const [count] = createSignal(3); const start = count();')).reactive()).toBe(false);
  });

  it('is, for a signal read where an element is made, which runs again when it moves', () => {
    expect(mounted(project('x: count()', 'const [count] = createSignal(3);')).reactive()).toBe(true);
  });

  it('is, for a prop that follows a signal', () => {
    expect(mounted(project('get x() { return count(); }', 'const [count] = createSignal(3);')).reactive()).toBe(true);
  });

  it('is, for an @inspect variable', () => {
    const code = project('get width() { return size(); }', "const size = __inspect({ file: 'index.tsx', name: 'size', type: 'number' }, 100);");
    const inspected = mounted(code);
    expect(inspected.inspect).toHaveLength(1);
    expect(inspected.reactive()).toBe(true);
  });

  it('is, for a project that follows the timeline', () => {
    expect(mounted(project('get x() { return ticker.time(); }', '', 'const ticker = useTicker();')).reactive()).toBe(true);
  });
});
