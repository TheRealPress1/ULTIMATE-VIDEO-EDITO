import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ sync: false, shortWrite: false, stalledWrite: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]).includes('.dstmp-')) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        if (fault.sync) throw new Error('simulated fsync failure');
        await sync();
      });
      const write = handle.write.bind(handle);
      Object.defineProperty(handle, 'write', { value: async (data: Uint8Array, offset: number, length: number, position: number) => {
        if (fault.stalledWrite) return { bytesWritten: 0, buffer: data };
        return write(data, offset, fault.shortWrite ? Math.min(length, 2) : length, position);
      } });
    }
    return handle;
  } };
});
import { AtomicFileWrites } from './file-writes';

const dirs: string[] = [];
const stores: AtomicFileWrites[] = [];
async function fixture(hooks?: ConstructorParameters<typeof AtomicFileWrites>[0]) {
  const dir = await mkdtemp(join(tmpdir(), 'uve-output-')); dirs.push(dir);
  const store = new AtomicFileWrites(hooks); stores.push(store);
  return { dir, path: join(dir, 'movie.mp4'), store };
}
const bytes = (text: string) => new TextEncoder().encode(text);
afterEach(async () => {
  fault.sync = fault.shortWrite = fault.stalledWrite = false;
  await Promise.all(stores.splice(0).map((store) => store.abortAll()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('atomic streamed output lifecycle', () => {
  it('finishes audio on the temporary file before replacing a previous export', async()=>{
    const {path,store}=await fixture({finalize:async(temp,config)=>{
      expect(config.format).toBe('mp4');expect(await readFile(path,'utf8')).toBe('old');
      expect(await readFile(temp,'utf8')).toBe('pcm');await writeFile(temp,'aac with timing');
    }});
    await writeFile(path,'old');const {id}=await store.open(path,false,{format:'mp4',audioBitrate:128000});
    await store.write(id,bytes('pcm'),0);await store.close(id);expect(await readFile(path,'utf8')).toBe('aac with timing');
  });
  it('can cancel native audio finalization without replacing the finished output',async()=>{
    let reached!:()=>void;const entering=new Promise<void>(resolve=>{reached=resolve;});
    const {path,store,dir}=await fixture({finalize:async(_temp,_config,signal)=>{
      reached();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    }});
    await writeFile(path,'old');const {id}=await store.open(path,false,{format:'mp4',audioBitrate:128000});await store.write(id,bytes('pcm'),0);
    const closing=store.close(id);const failed=expect(closing).rejects.toThrow('Export canceled');await entering;await store.abort(id);await failed;
    expect(await readFile(path,'utf8')).toBe('old');expect(await readdir(dir)).toEqual(['movie.mp4']);
  });
  it('preserves the old output until close and writes every byte even after short writes', async () => {
    const { dir, path, store } = await fixture();
    await writeFile(path, 'old valid output');
    const { id } = await store.open(path);
    fault.shortWrite = true;
    await store.write(id, bytes('new output'), 0);
    expect(await readFile(path, 'utf8')).toBe('old valid output');
    await store.close(id);
    expect(await readFile(path, 'utf8')).toBe('new output');
    expect(await readdir(dir)).toEqual(['movie.mp4']);
    expect(store.size).toBe(0);
  });

  it('does not remove an exclusive output when crash cleanup overlaps commit', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const { dir, path, store } = await fixture({ beforeRename: async () => { entered(); await gate; } });
    const { id } = await store.open(path, true);
    await store.write(id, bytes('complete movie'), 0);
    const committing = store.close(id);
    await reached;
    const crashing = store.abortAll();
    release();
    await Promise.all([committing, crashing]);
    expect(await readFile(path, 'utf8')).toBe('complete movie');
    expect(await readdir(dir)).toEqual(['movie.mp4']);
    expect(store.size).toBe(0);
  });

  it('serializes an explicit abort behind an already-started commit', async () => {
    const { path, store } = await fixture();
    const { id } = await store.open(path, true);
    const writing = store.write(id, bytes('complete movie'), 0);
    const committing = store.close(id);
    const aborting = store.abort(id);
    await Promise.all([writing, committing, aborting]);
    expect(await readFile(path, 'utf8')).toBe('complete movie');
  });

  it('cleans opens that were still creating a temp file when the renderer crashed', async () => {
    const { dir, path, store } = await fixture();
    const opening = store.open(path, true);
    expect(store.size).toBeGreaterThan(0);
    await store.abortAll();
    await opening;
    expect(await readdir(dir)).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('retains the last valid output after fsync failure and permits abort cleanup', async () => {
    const { dir, path, store } = await fixture();
    await writeFile(path, 'valid movie');
    const { id } = await store.open(path);
    await store.write(id, bytes('replacement'), 0);
    fault.sync = true;
    await expect(store.close(id)).rejects.toThrow('fsync failure');
    expect(store.size).toBe(1);
    await store.abortAll();
    expect(await readFile(path, 'utf8')).toBe('valid movie');
    expect(await readdir(dir)).toEqual(['movie.mp4']);
  });

  it('releases an exclusive reservation when commit fails', async () => {
    const { dir, path, store } = await fixture({ beforeRename: async () => { throw new Error('rename preparation failed'); } });
    const { id } = await store.open(path, true);
    await store.write(id, bytes('replacement'), 0);
    await expect(store.close(id)).rejects.toThrow('preparation failed');
    await store.abort(id);
    expect(await readdir(dir)).toEqual([]);
  });

  it('cannot commit an output after a chunk failed', async () => {
    const { dir, path, store } = await fixture();
    await writeFile(path, 'valid movie');
    const { id } = await store.open(path);
    fault.stalledWrite = true;
    await expect(store.write(id, bytes('replacement'), 0)).rejects.toThrow('stopped accepting');
    fault.stalledWrite = false;
    await expect(store.close(id)).rejects.toThrow('stopped accepting');
    await store.abort(id);
    expect(await readFile(path, 'utf8')).toBe('valid movie');
    expect(await readdir(dir)).toEqual(['movie.mp4']);
  });

  it('an exclusive collision leaves the existing file alone', async () => {
    const { dir, path, store } = await fixture();
    await writeFile(path, 'valid movie');
    await expect(store.open(path, true)).rejects.toThrow();
    await store.abortAll();
    expect(await readFile(path, 'utf8')).toBe('valid movie');
    expect(await readdir(dir)).toEqual(['movie.mp4']);
  });
});
