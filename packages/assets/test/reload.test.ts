import { describe, expect, it, vi } from 'vitest';
import { AssetLibrary, type AssetReload } from '../src/library';
import type { ProjectFS } from '../src/fs';
import type { Manifest } from '../src/manifest';

const transcript = (text: string, modified: number) => new File([JSON.stringify([{ text, words: [{ text, start: 0, end: 2 }] }])], 'captions.json', { type: 'application/json', lastModified: modified });
function fixture() {
  const files: Record<string, File> = { 'assets/first.json': transcript('profit and boy', 1), 'assets/second.json': transcript('Other caption', 1) };
  let manifest: Manifest | null = null;
  const fs: ProjectFS = {
    readManifest: async () => structuredClone(manifest), writeManifest: async (next) => { manifest = structuredClone(next); },
    list: async () => [], stat: async (path) => files[path] ? { size: files[path]!.size, mtime: files[path]!.lastModified } : null,
    file: async (path) => files[path]!, write: async () => {}, remove: async () => {},
  };
  const reload = vi.fn<(changes: readonly AssetReload[]) => void>();
  const library = new AssetLibrary(fs, { onReload: reload });
  return { files, fs, library, reload };
}
describe('external asset content reload', () => {
  it('notifies only changed identities after the replacement map is readable, without rewriting source bytes', async () => {
    const f = fixture();
    try {
      const { assets: [original] } = await f.library.import(['assets/first.json']); await f.library.flush();
      f.files['assets/first.json'] = transcript('Prophet Envoy', 2);
      f.reload.mockImplementation((changes) => { for (const change of changes) expect(f.library.get(change.current.id)).toBe(change.current); });
      await f.library.load();
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect(f.reload.mock.calls[0]![0]).toEqual([{ previous: original, current: f.library.get('first.json') }]);
      expect(f.library.get('first.json')!.id).not.toBe(original!.id);
      expect(await f.files['assets/first.json']!.text()).toContain('Prophet Envoy');
      await f.library.load(); expect(f.reload).toHaveBeenCalledTimes(2); expect(f.reload.mock.calls[1]![0]).toEqual([]);
    } finally { await f.library.dispose(); }
  });
  it('reports exchanged content IDs together so consumers can rebind from one snapshot', async () => {
    const f = fixture();
    try {
      const { assets: [first, second] } = await f.library.import(['assets/first.json', 'assets/second.json']); await f.library.flush();
      f.files['assets/first.json'] = transcript('Other caption', 2);
      f.files['assets/second.json'] = transcript('profit and boy', 2);
      await f.library.load();
      const changes = f.reload.mock.calls[0]![0];
      expect(changes).toHaveLength(2);
      expect(changes.map((change) => [change.previous.id, change.current.id])).toEqual(expect.arrayContaining([[first!.id, second!.id], [second!.id, first!.id]]));
    } finally { await f.library.dispose(); }
  });
  it('does not notify an abandoned reload after a newer local library edit', async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    try {
      await f.library.import(['assets/first.json']); await f.library.flush();
      const old = f.library.get('first.json')!;
      f.files['assets/first.json'] = transcript('Prophet Envoy', 2);
      const read = f.fs.readManifest;
      const saved = await read();
      f.fs.readManifest = () => new Promise((resolve) => { release = resolve; });
      const pending = f.library.load(); await Promise.resolve();
      f.library.createFolder('New edits'); release(saved); await pending;
      expect(f.reload).not.toHaveBeenCalled(); expect(f.library.get(old.id)).toBe(old);
    } finally { await f.library.dispose(); }
  });
});
