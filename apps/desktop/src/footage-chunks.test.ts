import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FootageIndexStore } from './footage-index';
import type { FootageChunkRequest } from './footage-types';
let dir:string, request:FootageChunkRequest, store:FootageIndexStore;
const words=(start:number)=>[{text:'saved speech',words:[{text:'saved',start,end:start+.2},{text:'speech',start:start+.25,end:start+.5}]}];
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'uve-speech-chunks-'));await writeFile(join(dir,'interview.mp4'),'original');store=new FootageIndexStore();const source={dir,source:'interview.mp4',duration:5400};request={...source,expectedFingerprint:(await store.get(source)).fingerprint};});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
describe('persistent speech sections',()=>{
  it('restores completed sections after process restart and exposes partial progress',async()=>{
    const saved=await store.putChunk({...request,index:0,transcript:words(1)});expect(saved).toMatchObject({completed:1,total:18});
    const restarted=new FootageIndexStore();expect((await restarted.getChunks(request)).chunks[0]).toEqual(words(1));
    expect(await restarted.get(request)).toMatchObject({transcript:null,partial:{completed:1,total:18}});
    expect(await readFile(join(dir,'interview.mp4'),'utf8')).toBe('original');
  });
  it('persists successful no-speech sections and does not transcribe them again',async()=>{await store.putChunk({...request,index:0,transcript:[]});expect((await new FootageIndexStore().getChunks(request)).chunks[0]).toEqual([]);});
  it('separates analysis settings, source duration and language',async()=>{
    await store.putChunk({...request,index:0,transcript:words(1)});
    expect((await store.getChunks({...request,language:'fr'})).completed).toBe(0);
    expect((await store.getChunks({...request,duration:5399})).completed).toBe(0);
  });
  it('refuses changed source bytes and does not attach old partial results to the replacement',async()=>{
    await store.putChunk({...request,index:0,transcript:words(1)});await writeFile(join(dir,'interview.mp4'),'changed!');
    await expect(store.getChunks(request)).rejects.toThrow('changed');await expect(store.putChunk({...request,index:1,transcript:words(301)})).rejects.toThrow('changed');
    expect((await store.get(request)).partial).toBeUndefined();
  });
  it('preserves already saved sections when a later section is canceled',async()=>{
    await store.putChunk({...request,index:0,transcript:words(1)});
    await expect(store.putChunk({...request,index:1,transcript:words(301)},AbortSignal.abort())).rejects.toThrow();
    expect((await new FootageIndexStore().getChunks(request)).completed).toBe(1);
  });
  it('rejects mismatched section timestamps and invalid indices',async()=>{
    await expect(store.putChunk({...request,index:1,transcript:words(1)})).rejects.toThrow('outside');
    await expect(store.putChunk({...request,index:18,transcript:[]})).rejects.toThrow('index');
  });
  it('does not follow a replaced cache file symlink',async()=>{
    await store.putChunk({...request,index:0,transcript:words(1)});
    const folder=join(dir,'.cutroom','footage-chunks'),[name]=await readdir(folder),outside=join(dir,'unrelated.json');
    await writeFile(outside,'{}');await rm(join(folder,name!));await symlink(outside,join(folder,name!));
    await expect(store.getChunks(request)).rejects.toThrow('valid local file');expect(await readFile(outside,'utf8')).toBe('{}');
  });
  it('serializes independent simultaneous section commits without losing one',async()=>{
    await Promise.all([store.putChunk({...request,index:0,transcript:words(1)}),store.putChunk({...request,index:1,transcript:words(301)})]);
    expect((await new FootageIndexStore().getChunks(request)).completed).toBe(2);
  });
  it('bounds derived section files without evicting the active recording or touching unrelated files',async()=>{
    await store.putChunk({...request,index:0,transcript:words(1)});
    const folder=join(dir,'.cutroom','footage-chunks');
    await Promise.all(Array.from({length:129},(_,i)=>writeFile(join(folder,`${i.toString(16).padStart(64,'0')}.json`),'{}')));
    await writeFile(join(folder,'keep-this-note.json'),'user note');
    await store.putChunk({...request,index:1,transcript:words(301)});
    const files=await readdir(folder);expect(files.filter(name=>/^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(128);
    expect((await new FootageIndexStore().getChunks(request)).completed).toBe(2);
    expect(await readFile(join(folder,'keep-this-note.json'),'utf8')).toBe('user note');
  });
});
