import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ stage: '', events: [] as string[] }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const kind = String(args[0]).includes('.dstmp-') ? 'file' : 'directory';
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        fault.events.push(`${kind} fsync`);
        if (fault.stage === `${kind} fsync`) throw new Error(`simulated ${fault.stage} failure`);
        await sync();
      });
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fault.events.push('rename');
      if (fault.stage === 'rename') throw new Error('simulated rename failure');
      return actual.rename(...args);
    },
  };
});
import { writeFileAtomic } from './atomic';
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'uve-atomic-')); dirs.push(dir);
  const path = join(dir, 'index.tsx');
  await writeFile(path, 'previous valid source');
  return { dir, path };
}
afterEach(async () => {
  fault.stage = ''; fault.events.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('durable atomic source replacement', () => {
  it('fsyncs file bytes before replacing source, then fsyncs the directory', async () => {
    const { dir, path } = await fixture();
    await writeFileAtomic(path, 'new source');
    expect(await readFile(path, 'utf8')).toBe('new source');
    expect(await readdir(dir)).toEqual(['index.tsx']);
    expect(fault.events).toEqual(process.platform === 'win32' ? ['file fsync', 'rename'] : ['file fsync', 'rename', 'directory fsync']);
  });
  it.each(['file fsync', 'rename'])('preserves previous source and removes temp after %s failure', async (stage) => {
    const { dir, path } = await fixture();
    fault.stage = stage;
    await expect(writeFileAtomic(path, 'new source')).rejects.toThrow(`simulated ${stage} failure`);
    expect(await readFile(path, 'utf8')).toBe('previous valid source');
    expect(await readdir(dir)).toEqual(['index.tsx']);
  });
  it.skipIf(process.platform === 'win32')('reports failed directory durability without deleting the already committed source', async () => {
    const { dir, path } = await fixture();
    fault.stage = 'directory fsync';
    await expect(writeFileAtomic(path, 'new source')).rejects.toThrow('directory fsync failure');
    expect(await readFile(path, 'utf8')).toBe('new source');
    expect(await readdir(dir)).toEqual(['index.tsx']);
  });
});
