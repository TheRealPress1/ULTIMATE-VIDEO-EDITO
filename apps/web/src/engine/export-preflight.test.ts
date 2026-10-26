import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('DOMMatrix', class {}); });
import type { World } from 'koota';
import { createRuntimeWorld, createEntity, AssetId, Audio, Caption, ChildOf, Computed, Geometry, Group, Hidden, Library, Muted, Name, Paint, PaintType, Root, Scene, SourceError, getAssetFile } from '@diffusionstudio/runtime';
import type { Asset, AssetLibrary } from '@diffusionstudio/assets';
import { assertExportSources, prepareExportSources } from '../../../../packages/encoder/src/preflight';
import { createEncoder } from '@diffusionstudio/encoder';

const worlds: World[] = [];
beforeEach(() => {
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('HTMLCanvasElement', class {});
});
afterEach(() => { worlds.splice(0).forEach((world) => world.destroy()); vi.unstubAllGlobals(); });

function fixture() {
  const world = createRuntimeWorld('export-preflight');
  worlds.push(world);
  const scene = createEntity(world);
  scene.add(Scene, Geometry, ChildOf(world.get(Root)!));
  scene.set(Computed, { start: 0, end: 300, duration: 300 });
  const clip = createEntity(world);
  clip.add(Geometry, Paint({ value: PaintType.VIDEO }), Name({ value: 'Interview take 2' }), ChildOf(scene));
  clip.set(Computed, { start: 30, end: 90, duration: 60 });
  clip.add(SourceError({ value: 'footage/interview.mp4 could not be opened' }));
  const options = { start: 0, end: 300, video: true, audio: true };
  return { world, scene, clip, options };
}

describe('export media preflight', () => {
  it('refuses missing footage before an output stream or encoder is opened', async () => {
    const { world, scene } = fixture();
    const createWritable = vi.fn();
    await expect(createEncoder(world, { target: { createWritable } })).rejects.toThrow(/Interview take 2.*interview.mp4/);
    expect(createWritable).not.toHaveBeenCalled();
    expect(scene.isAlive()).toBe(true);
  });

  it('allows valid source state', () => {
    const { world, scene, clip, options } = fixture();
    clip.remove(SourceError);
    expect(() => assertExportSources(world, scene, options)).not.toThrow();
  });

  it.each(['hidden', 'out-of-range', 'hidden-parent', 'trimmed-parent'] as const)('ignores %s missing media', (mode) => {
    const { world, scene, clip, options } = fixture();
    if (mode === 'hidden') clip.add(Hidden);
    if (mode === 'out-of-range') options.start = 100;
    if (mode.endsWith('parent')) {
      const group = createEntity(world);
      group.add(Group, ChildOf(scene));
      clip.add(ChildOf(group));
      if (mode === 'hidden-parent') group.add(Hidden);
      else group.set(Computed, { start: 100, end: 200 });
      clip.set(Computed, { start: 30, end: 90 });
    }
    expect(() => assertExportSources(world, scene, options)).not.toThrow();
  });

  it('ignores muted audio but still requires the picture of a muted video', () => {
    const { world, scene, clip, options } = fixture();
    clip.add(Muted);
    expect(() => assertExportSources(world, scene, options)).toThrow('Interview take 2');
    clip.remove(Paint);
    clip.add(Audio);
    expect(() => assertExportSources(world, scene, options)).not.toThrow();
  });

  it('ignores muted video in an audio-only export and visual-only captions', () => {
    const { world, scene, clip, options } = fixture();
    options.video = false;
    clip.add(Muted);
    expect(() => assertExportSources(world, scene, options)).not.toThrow();
    clip.remove(Paint, Muted);
    clip.add(Caption);
    expect(() => assertExportSources(world, scene, options)).not.toThrow();
    options.video = true;
    expect(() => assertExportSources(world, scene, options)).toThrow('Interview take 2');
  });

  it('checks media paint children with the owning clip timing', () => {
    const { world, scene, clip, options } = fixture();
    clip.remove(SourceError, Paint);
    const paint = createEntity(world);
    paint.add(Paint({ value: PaintType.IMAGE }), Name({ value: 'Logo' }), SourceError({ value: 'logo.png is missing' }), ChildOf(clip));
    clip.set(Computed, { start: 30, end: 90 });
    expect(() => assertExportSources(world, scene, options)).toThrow(/Logo.*logo.png/);
    options.start = 100;
    expect(() => assertExportSources(world, scene, options)).not.toThrow();
  });

  it('does not let a cached preview conceal a subsequently missing file', async () => {
    const { world, scene, clip, options } = fixture();
    const getFile = vi.fn().mockResolvedValueOnce(new File(['valid earlier'], 'interview.mp4')).mockRejectedValue(new Error('File no longer exists'));
    const source = { id: 'recording', type: 'VIDEO', path: 'interview.mp4', handle: { getFile } } as unknown as Asset;
    world.set(Library, { get: () => source } as unknown as AssetLibrary);
    clip.remove(SourceError);
    clip.add(AssetId({ value: source.id }));
    await getAssetFile(source);
    await expect(prepareExportSources(world, scene, options)).rejects.toThrow(/Interview take 2.*interview.mp4.*File no longer exists/);
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it('does not open files belonging only to excluded media', async () => {
    const { world, scene, clip, options } = fixture();
    const getFile = vi.fn().mockRejectedValue(new Error('Missing hidden file'));
    const source = { id: 'recording', type: 'VIDEO', handle: { getFile } } as unknown as Asset;
    world.set(Library, { get: () => source } as unknown as AssetLibrary);
    clip.remove(SourceError);
    clip.add(AssetId({ value: source.id }), Hidden);
    await expect(prepareExportSources(world, scene, options)).resolves.toBeUndefined();
    expect(getFile).not.toHaveBeenCalled();
  });
});
