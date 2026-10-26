import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalSpeakerAnalysisService, appendSpeakerChunk } from './speaker-analysis';
import type { SpeakerSample } from './speaker-types';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(resolve('.speaker-test-')),source=join(root,'clip.mp4'),runtime=join(root,'helper.mjs'),model=join(root,'model');roots.push(root);await writeFile(source,'{}');await writeFile(model,'model');await writeFile(runtime,`#!/usr/bin/env node
import fs from 'node:fs';
const [source,model,a,b,origin,interval]=process.argv.slice(2),start=+a,end=+b,total=Math.ceil((end-start)/+interval-1e-9),config=JSON.parse(fs.readFileSync(source));
if(config.fail)process.exit(2);
if(config.delay)await new Promise(r=>setTimeout(r,config.delay));
const emit=o=>console.log(JSON.stringify(o));
emit({type:'header',width:1920,height:1080,duration:7200,sourceStart:+origin,total,sampleInterval:+interval});
if(config.progress)emit({type:'progress',completed:total-1});
for(let i=0;i<total;i++)emit({type:'sample',time:start+i*+interval,cut:false,audioRms:.1,reason:'speaker',activeTrackId:'0',faces:[{trackId:'0',x:.2,y:.2,width:.2,height:.3,confidence:.9,speakingScore:config.bad?null:2}]});
if(config.mutate)fs.writeFileSync(source,'{"changed":true}');
if(config.bad)console.log('invalid');else emit({type:'done',completed:total});
`);await chmod(runtime,0o755);const service=new LocalSpeakerAnalysisService({runtimePath:runtime,modelPath:model,runTimeoutMs:3000,killGraceMs:20});const request=()=>({id:randomUUID(),dir:root,path:source,start:0,end:60,sourceStart:2});return{root,source,runtime,model,service,request};}

describe('resumable visible-speaker evidence',()=>{
 it('persists chunks, joins overlap IDs, and reuses them across service restarts',async()=>{const f=await fixture(),r=await f.service.analyze(f.request());expect(r.samples).toHaveLength(120);expect(new Set(r.samples.map(s=>s.faces[0]!.trackId))).toEqual(new Set(['0:0']));expect(r.totalChunks).toBe(2);expect(r.resumedChunks).toBe(0);const restarted=new LocalSpeakerAnalysisService({runtimePath:f.runtime,modelPath:f.model});const again=await restarted.analyze(f.request());expect(again.resumedChunks).toBe(2);expect(again.samples).toEqual(r.samples);});
 it('keeps completed sections when canceled and resumes without duplicates',async()=>{const f=await fixture(),request=f.request();await expect(f.service.analyze(request,p=>{if(p.completedChunks===1)f.service.cancel(request.id);})).rejects.toThrow('canceled');const result=await f.service.analyze(f.request());expect(result.resumedChunks).toBe(1);expect(result.samples.map(s=>s.time)).toEqual(Array.from({length:120},(_,i)=>i*.5));});
 it('invalidates evidence when source bytes change',async()=>{const f=await fixture();const a=await f.service.analyze(f.request());await writeFile(f.source,'{"new":true}');const b=await f.service.analyze(f.request());expect(b.fingerprint).not.toBe(a.fingerprint);expect(b.resumedChunks).toBe(0);});
 it('never publishes a source modified during native analysis',async()=>{const f=await fixture();await writeFile(f.source,'{"mutate":true}');await expect(f.service.analyze(f.request())).rejects.toThrow('changed');expect(await readdir(join(f.root,'.cutroom','speaker-analysis'))).toEqual([]);});
 it('cancels an active native process and allows another run',async()=>{const f=await fixture();await writeFile(f.source,'{"delay":1000}');const request=f.request();const task=f.service.analyze(request);setTimeout(()=>f.service.cancel(request.id),50);await expect(task).rejects.toThrow('canceled');await writeFile(f.source,'{}');expect((await f.service.analyze(f.request())).samples.length).toBe(120);});
 it('rejects malformed/incomplete native evidence instead of caching it',async()=>{const f=await fixture();await writeFile(f.source,'{"bad":true}');await expect(f.service.analyze(f.request())).rejects.toThrow();expect(await readdir(join(f.root,'.cutroom','speaker-analysis'))).toEqual([]);});
 it('rebuilds malformed derived cache entries',async()=>{const f=await fixture();await f.service.analyze(f.request());const folder=join(f.root,'.cutroom','speaker-analysis'),[name]=await readdir(folder);await writeFile(join(folder,name!),'{');const result=await f.service.analyze(f.request());expect(result.resumedChunks).toBe(1);expect(JSON.parse(await readFile(join(folder,name!),'utf8')).engine).toBe(result.engine);});
 it('does not traverse a symlinked project metadata directory',async()=>{const f=await fixture(),outside=join(f.root,'outside');await mkdir(outside);await symlink(outside,join(f.root,'.cutroom'));await expect(f.service.analyze(f.request())).rejects.toThrow('linked');expect(await readdir(outside)).toEqual([]);});
 it('keeps native preprocessing progress monotonic before final evidence arrives',async()=>{const f=await fixture();await writeFile(f.source,'{"progress":true}');const seen:number[]=[];const r=await f.service.analyze(f.request(),p=>seen.push(p.completed));expect(r.samples.length).toBe(120);expect(seen.every((v,i)=>i===0||v>=seen[i-1]!)).toBe(true);});
 it('saves six seconds of model context on each side while emitting each source sample once',async()=>{const f=await fixture();const r=await f.service.analyze({...f.request(),end:90});const dir=join(f.root,'.cutroom','speaker-analysis');const stored=await Promise.all((await readdir(dir)).map(async name=>JSON.parse(await readFile(join(dir,name),'utf8')).chunk.samples));const spans=stored.map(samples=>[samples[0].time,samples.length]).sort((a,b)=>a[0]-b[0]);expect(spans).toEqual([[0,72],[24,84],[54,72]]);expect(r.samples.map(s=>s.time)).toEqual(Array.from({length:180},(_,i)=>i*.5));});
 it('bounds jobs and preserves the source presentation origin',async()=>{const f=await fixture();await expect(f.service.analyze({...f.request(),end:7201})).rejects.toThrow('two hours');const result=await f.service.analyze({...f.request(),end:1});expect(result.sourceStart).toBe(2);expect(result.samples.map(s=>s.time)).toEqual([0,.5]);});
});
const sample=(time:number,trackId:string,cut=false):SpeakerSample=>({time,cut,audioRms:.1,reason:'speaker',activeTrackId:trackId,faces:[{trackId,x:.2,y:.2,width:.2,height:.3,confidence:.9,speakingScore:2}]});
it('does not merge anonymous tracks across a shot cut',()=>{const all=[sample(29,'0:0')];appendSpeakerChunk(all,[sample(29,'5',true),sample(30,'5')],30,31,'1');expect(all[1]!.activeTrackId).toBe('1:5');});
