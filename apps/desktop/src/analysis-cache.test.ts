import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAnalysisCache } from './analysis-cache';
let dir: string, source: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(),'uve-analysis-cache-')); source=join(dir,'video.mp4'); await writeFile(source,'media bytes'); });
afterEach(async () => { await rm(dir,{recursive:true,force:true}); });
const request = () => ({ dir, key:'scene:composition:settings', sources:[source] });
describe('resumable observation checkpoints', () => {
  it('persists completed sections across service restart without touching source', async () => {
    const cache=new LocalAnalysisCache(), r=request(), before=await cache.get(r);
    await cache.put({...r,fingerprint:before.fingerprint,chunk:'section-0',value:{findings:[1]}});
    expect((await new LocalAnalysisCache().get(r)).chunks).toEqual({'section-0':{findings:[1]}});
    expect(await readFile(source,'utf8')).toBe('media bytes');
    expect(await readdir(join(dir,'.cutroom','analysis'))).toHaveLength(1);
  });
  it('rejects changed same-size files even when modification time is restored', async () => {
    const cache=new LocalAnalysisCache(),r=request(), before=await cache.get(r), info=await stat(source);
    await writeFile(source,'other bytes'); await utimes(source,info.atime,info.mtime);
    expect((await cache.get(r)).fingerprint).not.toBe(before.fingerprint);
    await expect(cache.put({...r,fingerprint:before.fingerprint,chunk:'section-0',value:{}})).rejects.toThrow('media changed');
  });
  it('serializes concurrent section writes without losing completed work', async () => {
    const cache=new LocalAnalysisCache(),r=request(), before=await cache.get(r);
    await Promise.all([0,1,2].map(i=>cache.put({...r,fingerprint:before.fingerprint,chunk:`section-${i}`,value:i})));
    expect((await cache.get(r)).chunks).toEqual({'section-0':0,'section-1':1,'section-2':2});
  });
  it('invalidates changed analysis settings and ignores corrupt files', async () => {
    const cache=new LocalAnalysisCache(),r=request(), before=await cache.get(r);
    await cache.put({...r,fingerprint:before.fingerprint,chunk:'section-0',value:{}});
    expect((await cache.get({...r,key:'other-settings'})).chunks).toEqual({});
    await writeFile(join(dir,'.cutroom','analysis',`${before.fingerprint}.json`),'not json');
    expect((await cache.get(r)).chunks).toEqual({});
  });
  it('does not write through a symlink cache directory', async () => {
    const outside=join(dir,'outside');await mkdir(outside);await symlink(outside,join(dir,'.cutroom'));
    const cache=new LocalAnalysisCache(),r=request(),before=await cache.get(r);
    await expect(cache.put({...r,fingerprint:before.fingerprint,chunk:'section-0',value:{}})).rejects.toThrow('symbolic-link');
    expect(await readdir(outside)).toEqual([]);
  });
  it('cancels fingerprinting and rejects remote/traversal/oversized checkpoints', async () => {
    const cache=new LocalAnalysisCache(),r=request(),controller=new AbortController();controller.abort();
    await expect(cache.get(r,controller.signal)).rejects.toThrow();
    await expect(cache.get({...r,sources:['https://example.com/file.mp4']})).rejects.toThrow('Invalid');
    await expect(cache.get({...r,sources:['../outside']})).rejects.toThrow('relative');
    const {fingerprint}=await cache.get(r);
    await expect(cache.put({...r,fingerprint,chunk:'__proto__',value:{}})).rejects.toThrow('checkpoint');
    await expect(cache.put({...r,fingerprint,chunk:'section-0',value:'x'.repeat(5*1024*1024)})).rejects.toThrow('too large');
  });
});
