import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {}, shell: {}, ipcMain: { on: () => {} },
}));

const { findMovedProject, initProject, readConfig, renameProject, resolveProject, writeConfig } = await import('./projects');
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-config-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('project settings read failures', () => {
  it.each(['{ "projectId": "keep", "diffusion": ', 'null', '[]', '"invalid"'])('preserves an invalid package record during settings writes, rename and open: %s', async (source) => {
    await writeFile(join(root, 'package.json'), source);
    await writeFile(join(root, 'index.tsx'), 'export default () => <stage />;\n');
    await expect(readConfig(root)).rejects.toThrow('existing project settings have been kept');
    await expect(writeConfig(root, { initialized: true })).rejects.toThrow('existing project settings have been kept');
    await expect(renameProject(root, 'Renamed')).rejects.toThrow('existing project settings have been kept');
    await expect(resolveProject(root)).rejects.toThrow('existing project settings have been kept');
    await expect(initProject(null, root)).rejects.toThrow('existing project settings have been kept');
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(source);
  });

  it('does not treat filesystem read failures as missing settings', async () => {
    await mkdir(join(root, 'package.json'));
    await writeFile(join(root, 'package.json', 'keep.txt'), 'existing data');
    await expect(readConfig(root)).rejects.toThrow('Could not read package.json');
    await expect(writeConfig(root, { initialized: true })).rejects.toThrow('Could not read package.json');
    expect(await readdir(join(root, 'package.json'))).toEqual(['keep.txt']);
  });

  it('still creates settings when there is no package record', async () => {
    expect(await readConfig(root)).toBe(null);
    await writeConfig(root, { initialized: true });
    expect(await readConfig(root)).toEqual({ initialized: true });
  });

  it('continues a moved-project lookup past an unrelated invalid package record', async () => {
    const invalid = join(root, 'a-invalid');
    const moved = join(root, 'z-moved');
    await mkdir(invalid);
    await mkdir(moved);
    await writeFile(join(invalid, 'package.json'), '{broken');
    await writeFile(join(moved, 'package.json'), JSON.stringify({ projectId: 'kept-id', main: 'index.tsx' }));
    await writeFile(join(moved, 'index.tsx'), 'export default () => <stage />;\n');
    expect(await findMovedProject(join(root, 'old'), 'kept-id')).toMatchObject({ id: 'kept-id', dir: moved });
    expect(await readFile(join(invalid, 'package.json'), 'utf8')).toBe('{broken');
  });
});
