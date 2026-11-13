import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { createRequire } from 'node:module';
import { transformAsync } from '@babel/core';
import { transform } from 'esbuild';
import { authoredTree, mount } from '@diffusionstudio/reconciler';
import { createRuntimeWorld, Source } from '@diffusionstudio/runtime';
import { canonicalizeTagsPlugin, inspectPlugin, sourcePlugin } from '@desktop/source';
import { applyExternalEdit, captureComposition, recordComposition } from './external-edit';
import { getEditHistory } from './history';

import type { Mount } from '@diffusionstudio/reconciler';
import type { World } from 'koota';

// What the app does to a project, minus the folder: the same babel plugins and
// presets as the desktop compile (see `babelOptions` in projects.ts), then
// esbuild to the CommonJS the mount evaluates. These run on the reactive build
// of Solid (vitest.solid.config.ts), because whether a real compile counts as
// finished once rendered is the whole question here.

afterAll(() => vi.unstubAllGlobals());

// The presets ship without types (the desktop loads them the same way).
const load = createRequire(import.meta.url);
const preset = (name: string): unknown => {
  const loaded = load(name) as { default?: unknown };
  return loaded.default ?? loaded;
};

const compile = async (source: string): Promise<string> => {
  const file = 'index.tsx';
  const babel = await transformAsync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    plugins: [[sourcePlugin, { file }], canonicalizeTagsPlugin, [inspectPlugin, { file }]],
    presets: [
      [preset('babel-preset-solid'), { generate: 'universal', moduleName: '@diffusionstudio/jsx' }],
      [preset('@babel/preset-typescript'), { onlyRemoveTypeImports: true }],
    ],
  });
  return (await transform(babel!.code!, { format: 'cjs', loader: 'js' })).code;
};

const open: { world: World; mounted: Mount }[] = [];
afterEach(() => {
  for (const { world, mounted } of open.splice(0)) { mounted.dispose(); world.destroy(); }
});

const mounted = async (source: string) => {
  const world = createRuntimeWorld('external-edit-compiled');
  const mounting = mount(await compile(source), world);
  open.push({ world, mounted: mounting });
  return { world, mounted: mounting };
};

const find = (world: World, id: string) => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;

const project = (body: string, header = ''): string => `${header}
export default function Project() {
  return (
    <stage>
      <scene id="scene" name="Cut" width={1920} height={1080} active>
${body}
      </scene>
    </stage>
  );
}`;

const cut = `        <sequence id="seq" name="A-roll">
          <video id="v1" src="a.mp4" start={0} end={5} volume={-6} />
          <video id="v2" src="b.mp4" start={5} end={12} sourceIn={2} />
          <video id="v3" src="c.mp4" start={12} end={20} transition={{ type: "dissolve" }} />
        </sequence>
        <text id="title" x={100} y={200} start={1} end={4} fontSize={80} color="#ffffff">Hello</text>
        <rect id="box" x={10} y={20} width={300} height={200} fill="#ff0000" />`;

const tree = (world: World) => JSON.stringify(authoredTree(world, find(world, 'scene')));

describe('a project compiled the way the app compiles it', () => {
  it('is finished once rendered, so an edit to it can be made in place', async () => {
    const live = await mounted(project(cut));
    expect(live.mounted.reactive()).toBe(false);
  });

  it('is updated in place for an edit to the file, and ends up as a fresh mount of the new file would', async () => {
    const live = await mounted(project(cut));
    const next = project(cut
      .replace('end={5}', 'end={4}')
      .replace('volume={-6}', 'volume={-12}')
      .replace('>Hello<', '>Hello again<')
      .replace('<video id="v3"', '<video id="v4" src="d.mp4" start={20} end={30} />\n        <video id="v3"'));

    const result = applyExternalEdit(live.world, live.mounted, await compile(next));
    expect(result).toMatchObject({ applied: true });
    expect(result.applied && result.changes).toBeGreaterThan(0);

    const reference = await mounted(next);
    expect(tree(live.world)).toBe(tree(reference.world));
    expect(getEditHistory(live.world).canUndo()).toBe(true);
    // What the file was read as is what a mount of it holds.
    expect(recordComposition(await compile(next))).toEqual(captureComposition(reference.world));
  });

  it('is updated in place when clips are dropped and moved', async () => {
    const live = await mounted(project(cut));
    const next = project(`        <sequence id="seq" name="A-roll">
          <video id="v3" src="c.mp4" start={12} end={20} transition={{ type: "dissolve" }} />
          <video id="v1" src="a.mp4" start={0} end={5} volume={-6} />
        </sequence>
        <text id="title" x={100} y={200} start={1} end={4} fontSize={80} color="#ffffff">Hello</text>
        <video id="v2" src="b.mp4" start={5} end={12} sourceIn={2} />`);

    expect(applyExternalEdit(live.world, live.mounted, await compile(next))).toMatchObject({ applied: true });
    const reference = await mounted(next);
    expect(tree(live.world)).toBe(tree(reference.world));
    expect(recordComposition(await compile(next))).toEqual(captureComposition(reference.world));
  });

  it('is finished once rendered even with conditionals in it, which Solid compiles to memos', async () => {
    const conditional = project(`        {true ? <rect id="a" width={10} height={10} /> : <text id="b">no</text>}
        {1 > 0 && <rect id="c" width={20} height={20} />}`);
    const live = await mounted(conditional);
    expect(live.mounted.reactive()).toBe(false);

    const next = conditional.replace('width={20}', 'width={30}');
    expect(applyExternalEdit(live.world, live.mounted, await compile(next))).toMatchObject({ applied: true, changes: 1 });
    expect(tree(live.world)).toBe(tree((await mounted(next)).world));
  });

  it('is updated in place when its elements are made from data with .map, one stamp for many elements', async () => {
    const shots = (items: string) => project(`        {${items}.map((n) => (
          <group id="g" name={\`Shot \${n}\`} start={n} end={n + 1}>
            <rect id="r" width={10 * n} height={10} />
          </group>
        ))}
        <text id="title" x={1}>Hello</text>`);
    const live = await mounted(shots('[1, 2, 3]'));
    expect(live.mounted.reactive()).toBe(false);

    const next = shots('[1, 2, 3, 4]').replace('x={1}', 'x={2}');
    const result = applyExternalEdit(live.world, live.mounted, await compile(next));
    expect(result).toMatchObject({ applied: true, undoable: false });
    expect(tree(live.world)).toBe(tree((await mounted(next)).world));

    // And back to fewer.
    const fewer = shots('[2, 3]');
    expect(applyExternalEdit(live.world, live.mounted, await compile(fewer))).toMatchObject({ applied: true });
    expect(tree(live.world)).toBe(tree((await mounted(fewer)).world));
  });

  it('is mounted again, not patched, when it follows the timeline', async () => {
    const header = 'import { useTicker } from "@diffusionstudio/jsx";';
    const live = await mounted(project(cut, header).replace('export default function Project() {', 'export default function Project() {\n  const ticker = useTicker();').replace('x={10} y={20}', 'x={ticker.time()} y={20}'));
    expect(live.mounted.reactive()).toBe(true);
    const result = applyExternalEdit(live.world, live.mounted, await compile(project(cut)));
    expect(result).toEqual({ applied: false, reason: 'the project reacts to signals' });
  });

  it('is mounted again, not patched, when it has a loop', async () => {
    const header = 'import { For } from "solid-js";';
    const looped = project(`        <For each={[1, 2, 3]}>{(n) => <rect id="r" x={n * 10} width={50} height={50} />}</For>`, header);
    const live = await mounted(looped);
    const result = applyExternalEdit(live.world, live.mounted, await compile(looped.replace('n * 10', 'n * 20')));
    expect(result.applied).toBe(false);
  });
});
