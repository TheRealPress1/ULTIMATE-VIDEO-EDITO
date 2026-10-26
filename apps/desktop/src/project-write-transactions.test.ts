import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ target: '' }));
vi.mock('./atomic', async (original) => {
  const actual = await original<typeof import('./atomic')>();
  return { ...actual, writeFileAtomic: async (path: string, text: string) => {
    if (path === fault.target) throw new Error('simulated disk failure');
    return actual.writeFileAtomic(path, text);
  } };
});
import { commitProjectWrite, recoverProjectWrites, withProjectLock } from './project-write-transactions';
const dirs: string[] = [];
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'uve-save-')));
  dirs.push(dir);
  await writeFile(join(dir, 'index.tsx'), 'before A');
  await writeFile(join(dir, 'scene.tsx'), 'before B');
  return dir;
}
afterEach(async () => { fault.target = ''; await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const input = [{ kind: 'insert' }];
const plan = () => ({ files: [{path: 'index.tsx', before: 'before A', after: 'after A'}, {path: 'scene.tsx', before: 'before B', after: 'after B'}], result: {skipped: [], ids: { temporary: 'stable-id' }} });

describe('durable source transactions', () => {
  it('resumes an interrupted multi-file write without preparing/inserting twice', async () => {
    const dir = await fixture();
    const prepare = vi.fn(async () => plan());
    fault.target = join(dir, 'scene.tsx');
    await expect(commitProjectWrite(dir, 'operation-123', input, prepare)).rejects.toThrow('disk failure');
    expect(await readFile(join(dir, 'index.tsx'), 'utf8')).toBe('after A');
    expect(await readFile(join(dir, 'scene.tsx'), 'utf8')).toBe('before B');
    fault.target = '';
    await recoverProjectWrites(dir);
    expect(await commitProjectWrite(dir, 'operation-123', input, prepare)).toEqual(plan().result);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await readFile(join(dir, 'scene.tsx'), 'utf8')).toBe('after B');
  });
  it('rejects reused operation IDs with different edits', async () => {
    const dir = await fixture();
    await commitProjectWrite(dir, 'operation-123', input, async () => plan());
    await expect(commitProjectWrite(dir, 'operation-123', ['other'], async () => plan())).rejects.toThrow('different edits');
  });
  it('preserves newer external edits instead of blindly replaying recovery', async () => {
    const dir = await fixture();
    fault.target = join(dir, 'scene.tsx');
    await expect(commitProjectWrite(dir, 'operation-123', input, async () => plan())).rejects.toThrow();
    fault.target = '';
    await writeFile(join(dir, 'scene.tsx'), 'new external edit');
    await expect(recoverProjectWrites(dir)).rejects.toThrow('newer change');
    expect(await readFile(join(dir, 'scene.tsx'), 'utf8')).toBe('new external edit');
  });
  it('does not partially apply a request with skipped edits', async () => {
    const dir = await fixture();
    const result = await commitProjectWrite(dir, 'operation-123', input, async () => ({...plan(), result: { skipped: ['missing-id'] }}));
    expect(result.error).toContain('missing-id');
    expect(await readFile(join(dir, 'index.tsx'), 'utf8')).toBe('before A');
  });
  it('rejects traversal, source symlinks and recovery-record symlinks', async () => {
    const dir = await fixture();
    await expect(commitProjectWrite(dir, 'operation-123', input, async () => ({...plan(), files: [{ path: '../escape.ts', before: '', after: 'bad' }]}))).rejects.toThrow('Unsafe');
    await symlink(join(dir, 'index.tsx'), join(dir, 'link.tsx'));
    await expect(commitProjectWrite(dir, 'operation-456', input, async () => ({...plan(), files: [{path: 'link.tsx', before: 'before A', after: 'bad'}]}))).rejects.toThrow('Relink');
    await symlink(join(dir, 'index.tsx'), join(dir, '.cutroom/writes/operation-789.json'));
    await expect(commitProjectWrite(dir, 'operation-789', input, async () => plan())).rejects.toThrow('Unsafe');
  });
  it('rejects a symlinked recovery folder without writing outside the project', async () => {
    const dir = await fixture();
    const outside = await fixture();
    await mkdir(join(dir, '.cutroom'));
    await symlink(outside, join(dir, '.cutroom/writes'));
    await expect(commitProjectWrite(dir, 'operation-123', input, async () => plan())).rejects.toThrow('real directory');
  });
  it('serializes aliases of the same project and releases its queue after failures', async () => {
    const dir = await fixture();
    const alias = dir + '-link'; dirs.push(alias); await symlink(dir, alias);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withProjectLock(dir, async () => { order.push('first'); await gate; throw new Error('failed'); });
    // Wait until first has acquired its realpath-based lock.
    while (!order.length) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = withProjectLock(alias, async () => { order.push('second'); });
    release(); await expect(first).rejects.toThrow('failed'); await second;
    expect(order).toEqual(['first', 'second']);
  });
});
