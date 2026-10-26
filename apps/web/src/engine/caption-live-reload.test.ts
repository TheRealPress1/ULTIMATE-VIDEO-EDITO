import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest, ProjectFS } from '@diffusionstudio/assets';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
});
const mocks = vi.hoisted(() => ({ fs: vi.fn() }));
vi.mock('@/projects/fs', () => ({ createProjectFS: mocks.fs }));
vi.mock('@/projects/edits', () => ({ registerProjectSaveParticipant: () => () => {} }));
import { AssetId, Caption, CaptionDecoderHandle, Chars, ChildOf, createRuntimeWorld, Library, Position, Selected, Shadow } from '@diffusionstudio/runtime';
import { resolveCaptionDecoder } from '../../../../packages/runtime/src/media/caption';
import { getTranscriptDuration, primeTranscriptDuration } from '../../../../packages/runtime/src/media/caption/utils';
import { mount } from '@diffusionstudio/reconciler';
import { attachLibrary } from './library';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';

const worlds: ReturnType<typeof createRuntimeWorld>[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => { for (const world of worlds.splice(0)) world.destroy(); });
const transcript = (text: string, modified: number, end = 2) => new File([JSON.stringify([{ text, words: [{ text, start: 0, end }] }])], 'captions.json', { type: 'application/json', lastModified: modified });
async function fixture(second = false) {
  const files: Record<string, File> = { 'assets/first.json': transcript('profit and boy', 1), 'assets/second.json': transcript('Other caption', 1) };
  let manifest: Manifest | null = null;
  const fs: ProjectFS = {
    readManifest: async () => structuredClone(manifest), writeManifest: async (next) => { manifest = structuredClone(next); },
    list: async () => [], stat: async (path) => files[path] ? { size: files[path]!.size, mtime: files[path]!.lastModified } : null,
    file: async (path) => files[path]!, write: async () => {}, remove: async () => {},
  };
  mocks.fs.mockReturnValue(fs);
  const world = createRuntimeWorld('isolated-live-caption'); worlds.push(world);
  const library = attachLibrary(world, '/isolated-caption-fixture');
  await library.import(second ? ['assets/first.json', 'assets/second.json'] : ['assets/first.json']); await library.flush();
  const code = `const { Stage, Scene, Captions } = require('@diffusionstudio/jsx');
module.exports.default = () => Stage({ __source: 'index.tsx:stage', get children() { return Scene({ __source: 'index.tsx:scene', width: 1920, height: 1080, active: true,
get children() { return [Captions({ __source: 'index.tsx:first', src: 'first.json', preset: 'classic', selected: true }), ${second ? "Captions({ __source: 'index.tsx:second', src: 'second.json', preset: 'classic' })" : ''}]; } }); } });`;
  const mounted = mount(code, world);
  await vi.waitFor(() => expect(world.query(Caption).every((entity) => !!entity.get(AssetId)?.value)).toBe(true));
  const captions = [...world.query(Caption)];
  const readCaption = async (index: number) => {
    const caption = captions[index]!; const decoder = resolveCaptionDecoder(world, caption)!;
    await decoder.initPromise; decoder.seekTo(world, caption, 0.5);
    return caption.get(Chars)?.value;
  };
  return { world, library, files, captions, readCaption, mounted };
}
describe('live caption refresh from external JSON writes', () => {
  it('shows edited words on the same selected entity without JSX edits or losing undo history', async () => {
    const f = await fixture(true);
    try {
      const caption = f.captions[0]!; const identity = caption.id(); const original = caption.get(AssetId)!.value;
      expect(await f.readCaption(0)).toBe('profit and boy');
      expect(await f.readCaption(1)).toBe('Other caption');
      const unaffected = f.captions[1]!.get(CaptionDecoderHandle);
      const oldDecoder = caption.get(CaptionDecoderHandle);
      const oldAsset = f.world.get(Library)!.get(original)!; await primeTranscriptDuration(oldAsset);
      expect(getTranscriptDuration(oldAsset)).toBe(2);
      const editor = getDocumentEditor(f.world); const history = getEditHistory(f.world);
      editor.editProperty(caption, 'x', 240); await Promise.resolve();
      expect(history.canUndo()).toBe(true);
      const edits: unknown[] = []; const stop = editor.onEdit((edit) => edits.push(edit));
      f.files['assets/first.json'] = transcript('Prophet Envoy', 2, 3);
      await f.library.load();
      expect(caption.get(CaptionDecoderHandle)).toBeNull();
      expect(await f.readCaption(0)).toBe('Prophet Envoy');
      expect(caption.get(CaptionDecoderHandle)).not.toBe(oldDecoder);
      expect(caption.id()).toBe(identity); expect(caption.has(Selected)).toBe(true);
      expect(caption.get(Position)?.x).toBe(240);
      expect(f.captions[1]!.get(CaptionDecoderHandle)).toBe(unaffected);
      expect(caption.get(AssetId)!.value).not.toBe(original);
      expect(f.world.query(ChildOf(caption), Shadow)).toHaveLength(1);
      const updated = f.library.get(caption.get(AssetId)!.value)!; await primeTranscriptDuration(updated);
      expect(getTranscriptDuration(updated)).toBe(3);
      expect(edits).toEqual([]); expect(history.canUndo()).toBe(true);
      history.undo(); expect(history.canRedo()).toBe(true);
      stop();
    } finally { f.mounted.dispose(); await f.library.dispose(); }
  });
  it('keeps two captions bound to their own paths when an external write exchanges their content', async () => {
    const f = await fixture(true);
    try {
      expect(await f.readCaption(0)).toBe('profit and boy'); expect(await f.readCaption(1)).toBe('Other caption');
      f.files['assets/first.json'] = transcript('Other caption', 2);
      f.files['assets/second.json'] = transcript('profit and boy', 2);
      await f.library.load();
      expect(await f.readCaption(0)).toBe('Other caption'); expect(await f.readCaption(1)).toBe('profit and boy');
      expect(new Set(f.captions.map((caption) => caption.get(AssetId)!.value)).size).toBe(2);
    } finally { f.mounted.dispose(); await f.library.dispose(); }
  });
  it.each([0, 1])('follows authored paths when equal-content caption %s later diverges', async (index) => {
    const f = await fixture(true);
    try {
      await f.readCaption(0); await f.readCaption(1);
      const path = index === 0 ? 'assets/first.json' : 'assets/second.json';
      const unchanged = index === 0 ? 'Other caption' : 'profit and boy';
      f.files[path] = transcript(unchanged, 2);
      await f.library.load();
      expect(await f.readCaption(0)).toBe(unchanged); expect(await f.readCaption(1)).toBe(unchanged);
      f.files[path] = transcript('Prophet Envoy', 3);
      await f.library.load();
      expect(await f.readCaption(index)).toBe('Prophet Envoy'); expect(await f.readCaption(1 - index)).toBe(unchanged);
    } finally { f.mounted.dispose(); await f.library.dispose(); }
  });
});
