import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest, ProjectFS } from '@diffusionstudio/assets';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
});
const mocks = vi.hoisted(() => ({ fs: vi.fn() }));
vi.mock('@/projects/fs', () => ({ createProjectFS: mocks.fs }));
vi.mock('@/projects/edits', () => ({ registerProjectSaveParticipant: () => () => {} }));
// Mixing scene audio needs a browser; writing a caption layer never mixes any.
vi.mock('./scene-audio', () => ({ encodeSceneAudio: vi.fn(), hasAudio: () => true }));
import { authoredElement, mount } from '@diffusionstudio/reconciler';
import { Caption, CaptionType, createRuntimeWorld, Scene, TextCase, TextStyle } from '@diffusionstudio/runtime';
import { attachLibrary } from './library';
import { mountSceneCaptions } from './generate/captions';

import type { Transcript } from '@diffusionstudio/assets';

// An in-memory project: no file on disk is read or written.
const worlds: ReturnType<typeof createRuntimeWorld>[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => { for (const world of worlds.splice(0)) world.destroy(); });

const words: Transcript = [{ text: 'founders ink', words: [{ text: 'founders', start: 0, end: 0.4 }, { text: 'ink', start: 0.4, end: 0.9 }] }];
// The fixed words: different bytes, so a new file.
const fixed: Transcript = [{ text: 'founders inc', words: [{ text: 'founders', start: 0, end: 0.4 }, { text: 'inc', start: 0.4, end: 0.9 }] }];

async function fixture(captions: string[]) {
  const files: Record<string, File> = { 'assets/old.json': new File([JSON.stringify(words)], 'old.json', { type: 'application/json', lastModified: 1 }) };
  let manifest: Manifest | null = null;
  const fs: ProjectFS = {
    readManifest: async () => structuredClone(manifest), writeManifest: async (next) => { manifest = structuredClone(next); },
    list: async () => [], stat: async (path) => files[path] ? { size: files[path]!.size, mtime: files[path]!.lastModified } : null,
    file: async (path) => files[path]!,
    write: async (path, blob) => { files[path] = new File([blob as Blob], path.split('/').pop()!, { type: 'application/json', lastModified: 2 }); },
    remove: async () => {},
  };
  mocks.fs.mockReturnValue(fs);
  const world = createRuntimeWorld('isolated-caption-layer'); worlds.push(world);
  const library = attachLibrary(world, '/isolated-caption-layer');
  await library.import(['assets/old.json']); await library.flush();
  const code = `const { Stage, Scene, Captions } = require('@diffusionstudio/jsx');
module.exports.default = () => Stage({ __source: 'index.tsx:stage', get children() { return Scene({ __source: 'index.tsx:scene', width: 1920, height: 1080, active: true,
get children() { return [${captions.join(', ')}]; } }); } });`;
  mount(code, world);
  const scene = world.query(Scene)[0]!;
  return { world, library, files, scene };
}

describe('the scene caption layer the Captions tab writes', () => {
  it('points an existing layer at a new file with the chosen preset and case', async () => {
    const f = await fixture(["Captions({ __source: 'index.tsx:caps', src: 'old.json', preset: 'classic' })"]);
    const result = await mountSceneCaptions(f.world, f.scene, fixed, { preset: 'stark', textCase: 'lower' }, 'Captions Scene.json');
    expect(result).toEqual({ path: 'Captions Scene.json', added: false });
    const layer = f.world.query(Caption)[0]!;
    expect(f.world.query(Caption)).toHaveLength(1);
    expect(authoredElement(layer)?.props).toMatchObject({ src: 'Captions Scene.json', preset: 'stark', textCase: 'lower' });
    expect(layer.get(Caption)?.type).toBe(CaptionType.STARK);
    expect(layer.get(TextStyle)?.textCase).toBe(TextCase.LOWER);
    expect(JSON.parse(await f.files['assets/Captions Scene.json']!.text())).toEqual(fixed);
    // The old file stays, so undo can point back at it.
    expect(f.library.get('old.json')).toBeDefined();
  });

  it('gives the case back to the preset when none is chosen', async () => {
    const f = await fixture(["Captions({ __source: 'index.tsx:caps', src: 'old.json', preset: 'classic', textCase: 'upper' })"]);
    const layer = f.world.query(Caption)[0]!;
    expect(layer.get(TextStyle)?.textCase).toBe(TextCase.UPPER);
    await mountSceneCaptions(f.world, f.scene, fixed, { preset: 'classic', textCase: false }, 'Captions Scene.json');
    expect(authoredElement(layer)?.props.textCase || undefined).toBeUndefined();
    // Classic's own case is lower.
    expect(layer.get(TextStyle)?.textCase).toBe(TextCase.LOWER);
    await mountSceneCaptions(f.world, f.scene, fixed, { preset: 'stark', textCase: false }, 'Captions Scene 2.json');
    expect(layer.get(TextStyle)?.textCase).toBe(TextCase.UPPER);
  });

  it('adds a layer to a scene without one', async () => {
    const f = await fixture([]);
    const result = await mountSceneCaptions(f.world, f.scene, fixed, { preset: 'paper', textCase: false }, 'Captions Scene.json');
    expect(result.added).toBe(true);
    const layers = f.world.query(Caption);
    expect(layers).toHaveLength(1);
    expect(authoredElement(layers[0]!)?.props).toMatchObject({ src: 'Captions Scene.json', preset: 'paper' });
  });

  it('refuses a scene with more than one caption layer, before writing anything', async () => {
    const f = await fixture([
      "Captions({ __source: 'index.tsx:a', src: 'old.json' })",
      "Captions({ __source: 'index.tsx:b', src: 'old.json', start: 2 })",
    ]);
    await expect(mountSceneCaptions(f.world, f.scene, fixed, { preset: 'classic', textCase: false }, 'Captions Scene.json')).rejects.toThrow('more than one caption layer');
    expect(f.files['assets/Captions Scene.json']).toBeUndefined();
  });
});
