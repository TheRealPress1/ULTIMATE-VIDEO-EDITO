import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SPEAKER_CHUNK_SECONDS, SPEAKER_CONTEXT_SECONDS, SPEAKER_ENGINE, SPEAKER_INTERVAL, SPEAKER_MAX_SECONDS } from './speaker-types';
import type { SpeakerAnalysisRequest, SpeakerAnalysisProgress, SpeakerAnalysisResult, SpeakerFace, SpeakerSample } from './speaker-types';

export interface LocalSpeakerAnalysisOptions { runtimePath: string; modelPath: string; cacheDir?: string; runTimeoutMs?: number; killGraceMs?: number }
type Chunk = { width: number; height: number; sourceStart: number; duration: number; samples: SpeakerSample[] };
type Source = { path: string; signature: string; fingerprint: string };
const MODEL_SHA = 'd44bc3ea7baa8e0946fa3921311714a630ed8b90a1928fab0dbe30d918909317';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const signature = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const changed = () => new Error('This footage changed during speaker analysis. Relink or refresh it before continuing.');
function validate(r: SpeakerAnalysisRequest): void {
  if (!r || !UUID.test(r.id) || typeof r.dir !== 'string' || !isAbsolute(r.dir) || r.dir.includes('\0') || typeof r.path !== 'string' || !isAbsolute(r.path) || r.path.includes('\0') ||
    !finite(r.start) || !finite(r.end) || r.start < 0 || r.end <= r.start || r.end - r.start > SPEAKER_MAX_SECONDS || r.end > 86400 ||
    (r.sourceStart !== undefined && (!finite(r.sourceStart) || r.sourceStart < 0 || r.sourceStart > 86400))) throw new Error('Analyze a local video range up to two hours with a valid source clock.');
}
function validSample(value: unknown, time: number): value is SpeakerSample {
  if (!value || typeof value !== 'object') return false;
  const s = value as SpeakerSample;
  if (!finite(s.time) || Math.abs(s.time-time) > 1e-6 || typeof s.cut !== 'boolean' || !finite(s.audioRms) || s.audioRms < 0 || s.audioRms > 100 || !Array.isArray(s.faces) || s.faces.length > 8 ||
    !['speaker','uncertain','no-visible-speaker','overlap','silence'].includes(s.reason) || (s.activeTrackId !== null && typeof s.activeTrackId !== 'string')) return false;
  const ids = new Set<string>();
  for (const f of s.faces) {
    if (!f || typeof f.trackId !== 'string' || !/^[\w:-]{1,100}$/.test(f.trackId) || ids.has(f.trackId) || ![f.x,f.y,f.width,f.height,f.confidence].every(n=>finite(n)&&n>=0&&n<=1) || f.width <= 0 || f.height <= 0 || f.x+f.width>1.000001 || f.y+f.height>1.000001 || (f.speakingScore !== null && (!finite(f.speakingScore) || Math.abs(f.speakingScore)>1000))) return false;
    ids.add(f.trackId);
  }
  return (s.activeTrackId === null || ids.has(s.activeTrackId)) && ((s.reason === 'speaker') === (s.activeTrackId !== null));
}
function validChunk(value: unknown, r: SpeakerAnalysisRequest, start: number, end: number): value is Chunk {
  if (!value || typeof value !== 'object') return false;
  const c=value as Chunk, count=Math.ceil((end-start)/SPEAKER_INTERVAL-1e-9);
  return [c.width,c.height].every(n=>Number.isInteger(n)&&n>0&&n<=32768) && finite(c.duration) && c.duration>0 && end<=c.duration+0.05 && c.sourceStart===(r.sourceStart??0) && Array.isArray(c.samples) && c.samples.length===count && c.samples.every((sample,i)=>validSample(sample,start+i*SPEAKER_INTERVAL));
}
const iou = (a: SpeakerFace,b: SpeakerFace) => { const w=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)),h=Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return w*h/Math.max(1e-9,a.width*a.height+b.width*b.height-w*h); };
/** Match anonymous track IDs only across overlapping adjacent analysis windows. No voice/face identity enrollment. */
export function appendSpeakerChunk(all: SpeakerSample[], chunk: readonly SpeakerSample[], keepStart: number, keepEnd: number, prefix: string): void {
  const mapping=new Map<string,string>(),used=new Set<string>();
  for (const sample of chunk.filter(s=>s.time<keepStart)) {
    const prior=all.find(s=>Math.abs(s.time-sample.time)<1e-6);if(!prior || sample.cut || prior.cut) continue;
    for(const face of sample.faces){if(mapping.has(face.trackId))continue;const candidates=prior.faces.filter(f=>!used.has(f.trackId)).sort((a,b)=>iou(b,face)-iou(a,face));if(candidates[0] && iou(candidates[0],face)>0.45){mapping.set(face.trackId,candidates[0].trackId);used.add(candidates[0].trackId);}}
  }
  for(const sample of chunk){if(sample.time<keepStart-1e-6 || sample.time>=keepEnd-1e-6)continue;const id=(local:string)=>mapping.get(local)??`${prefix}:${local}`;all.push({...sample,faces:sample.faces.map(f=>({...f,trackId:id(f.trackId)})),activeTrackId:sample.activeTrackId===null?null:id(sample.activeTrackId)});}
}

/** Bounded native jobs and atomic per-chunk checkpoints. Original files are read-only. */
export class LocalSpeakerAnalysisService {
  private readonly options: LocalSpeakerAnalysisOptions;
  private active?: { id: string; controller: AbortController };
  private disposed=false;
  private fingerprints=new Map<string,Source>();
  constructor(options:LocalSpeakerAnalysisOptions){this.options=options;}
  cancel(id:string):void {if(this.active?.id===id)this.active.controller.abort(new Error('Speaker analysis canceled. Completed sections are saved for resume.'));}
  dispose():void{this.disposed=true;if(this.active)this.cancel(this.active.id);}
  private async source(path:string,signal:AbortSignal,force=false):Promise<Source>{
    signal.throwIfAborted();const canonical=await realpath(path),before=await stat(canonical,{bigint:true});
    if(!before.isFile()||before.size<=0n)throw new Error('Choose a readable local video.');
    const stamp=signature(before),cached=this.fingerprints.get(canonical);if(!force&&cached?.signature===stamp)return cached;
    const handle=await open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW??0)),hash=createHash('sha256');
    try{if(signature(await handle.stat({bigint:true}))!==stamp)throw changed();const buffer=Buffer.allocUnsafe(4*1024*1024);while(true){signal.throwIfAborted();const {bytesRead}=await handle.read(buffer);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}if(signature(await handle.stat({bigint:true}))!==stamp)throw changed();}finally{await handle.close();}
    if(await realpath(path)!==canonical||signature(await stat(canonical,{bigint:true}))!==stamp)throw changed();
    const result={path:canonical,signature:stamp,fingerprint:hash.digest('hex')};this.fingerprints.set(canonical,result);if(this.fingerprints.size>64)this.fingerprints.delete(this.fingerprints.keys().next().value!);return result;
  }
  private async directory(dir:string):Promise<string>{
    const root=await realpath(dir);if(!(await stat(root)).isDirectory())throw new Error('Open a local project first.');
    const folder=this.options.cacheDir?resolve(this.options.cacheDir):join(root,'.cutroom','speaker-analysis');
    if(!this.options.cacheDir){const app=join(root,'.cutroom');await mkdir(app,{recursive:true,mode:0o700});if((await lstat(app)).isSymbolicLink()||await realpath(app)!==app)throw new Error('Speaker cache cannot use a linked project metadata directory.');}
    await mkdir(folder,{recursive:true,mode:0o700});const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(folder)!==folder)throw new Error('Speaker analysis cache must be a real directory.');return folder;
  }
  async analyze(input:SpeakerAnalysisRequest,onProgress?:(p:SpeakerAnalysisProgress)=>void):Promise<SpeakerAnalysisResult>{
    validate(input);if(this.disposed)throw new Error('Speaker analysis is closed.');if(this.active)throw new Error('Another speaker analysis is running. Wait for it to finish.');
    const task={id:input.id,controller:new AbortController()};this.active=task;const signal=task.controller.signal;
    try{
      const totalChunks=Math.ceil((input.end-input.start)/SPEAKER_CHUNK_SECONDS),total=Math.ceil((input.end-input.start)/SPEAKER_INTERVAL-1e-9);
      const progress=(phase:SpeakerAnalysisProgress['phase'],completed:number,completedChunks:number)=>{try{onProgress?.({id:input.id,phase,completed,total,completedChunks,totalChunks});}catch{/*owner closed*/}};
      progress('fingerprinting',0,0);const source=await this.source(input.path,signal),folder=await this.directory(input.dir);signal.throwIfAborted();
      if(process.platform!=='darwin'||!await access(this.options.runtimePath,constants.X_OK).then(()=>true,()=>false))throw new Error('This Mac build does not include the local speaker analysis helper.');
      await access(this.options.modelPath,constants.R_OK);
      const samples:SpeakerSample[]=[],request={...input,path:source.path};let resumedChunks=0,width=0,height=0;
      for(let index=0;index<totalChunks;index++){
        signal.throwIfAborted();if(signature(await stat(source.path,{bigint:true}))!==source.signature||await realpath(input.path)!==source.path)throw changed();
        const keepStart=input.start+index*SPEAKER_CHUNK_SECONDS,keepEnd=Math.min(input.end,keepStart+SPEAKER_CHUNK_SECONDS),start=Math.max(input.start,keepStart-SPEAKER_CONTEXT_SECONDS),end=Math.min(input.end,keepEnd+SPEAKER_CONTEXT_SECONDS);
        const key=createHash('sha256').update(JSON.stringify([SPEAKER_ENGINE,MODEL_SHA,source.fingerprint,input.sourceStart??0,start,end,SPEAKER_INTERVAL])).digest('hex'),path=join(folder,`${key}.json`);
        let chunk:Chunk|undefined;
        try{const info=await lstat(path);if(info.isFile()&&!info.isSymbolicLink()&&info.size<=2*1024*1024){const stored=JSON.parse(await readFile(path,'utf8'));if(stored.engine===SPEAKER_ENGINE&&stored.model===MODEL_SHA&&stored.fingerprint===source.fingerprint&&validChunk(stored.chunk,request,start,end))chunk=stored.chunk;}}catch{/*rebuild incomplete/malformed derived evidence*/}
        if(chunk){resumedChunks++;progress('cached',samples.length,index);}else{
          chunk=await this.run({...request,start,end},signal,(completed,count)=>progress('analyzing',Math.min(total,samples.length+Math.round(completed/count*Math.ceil((keepEnd-keepStart)/SPEAKER_INTERVAL))),index));
          signal.throwIfAborted();if(signature(await stat(source.path,{bigint:true}))!==source.signature)throw changed();
          const temp=join(folder,`.speaker-${randomUUID()}.json`);try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify({engine:SPEAKER_ENGINE,model:MODEL_SHA,fingerprint:source.fingerprint,chunk}));await handle.sync();}finally{await handle.close();}signal.throwIfAborted();await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}
        }
        if(width&&(width!==chunk.width||height!==chunk.height))throw new Error('Source dimensions changed between speaker sections.');width=chunk.width;height=chunk.height;
        appendSpeakerChunk(samples,chunk.samples,keepStart,keepEnd,String(index));progress('analyzing',samples.length,index+1);
      }
      signal.throwIfAborted();const after=await this.source(input.path,signal,true);if(after.signature!==source.signature||after.fingerprint!==source.fingerprint)throw changed();
      const uncertain=samples.filter(s=>s.activeTrackId===null&&s.reason!=='silence').length;
      return {engine:SPEAKER_ENGINE,fingerprint:source.fingerprint,start:input.start,end:input.end,sourceStart:input.sourceStart??0,width,height,sampleInterval:SPEAKER_INTERVAL,samples,warnings:[
        'Visible speaker estimates combine original audio with face motion. They do not identify people or diarize off-camera voices.',
        ...(uncertain?[`${uncertain} sampled moments had uncertain, overlapping or off-camera speech; keep a wide or steady view there.`]:[]),
      ],resumedChunks,totalChunks};
    }finally{if(this.active===task)this.active=undefined;}
  }
  private run(r:SpeakerAnalysisRequest,signal:AbortSignal,progress:(n:number,total:number)=>void):Promise<Chunk>{
    return new Promise((resolveResult,reject)=>{
      signal.throwIfAborted();const child=spawn(this.options.runtimePath,[r.path,this.options.modelPath,String(r.start),String(r.end),String(r.sourceStart??0),String(SPEAKER_INTERVAL)],{shell:false,stdio:['ignore','pipe','pipe']});
      const decoder=new StringDecoder('utf8');let buffer='',stderr='',bytes=0,reported=0,header:Omit<Chunk,'samples'>|undefined,done=false,failure:Error|undefined,kill:ReturnType<typeof setTimeout>|undefined;const samples:SpeakerSample[]=[];
      const stop=(error:Error)=>{if(failure)return;failure=error;child.kill('SIGTERM');kill=setTimeout(()=>child.kill('SIGKILL'),this.options.killGraceMs??1000);};
      const abort=()=>stop(signal.reason instanceof Error?signal.reason:new Error('Speaker analysis canceled.'));
      const timer=setTimeout(()=>stop(new Error('Speaker analysis timed out. Completed sections remain available to resume.')),this.options.runTimeoutMs??10*60_000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      const line=(text:string)=>{const v=JSON.parse(text) as Record<string,unknown>;if(!v||typeof v!=='object'||done)throw new Error('Invalid speaker analysis output.');if(v.type==='header'&&!header){const candidate={width:v.width,height:v.height,duration:v.duration,sourceStart:v.sourceStart,samples:[]} as Chunk;if(![candidate.width,candidate.height].every(n=>Number.isInteger(n)&&n>0&&n<=32768)||!finite(candidate.duration)||r.end>candidate.duration+0.05||candidate.sourceStart!==(r.sourceStart??0)||v.total!==Math.ceil((r.end-r.start)/SPEAKER_INTERVAL-1e-9)||v.sampleInterval!==SPEAKER_INTERVAL)throw new Error('Invalid speaker analysis metadata.');header=candidate;progress(0,Number(v.total));}else if(v.type==='progress'&&header){const total=Math.ceil((r.end-r.start)/SPEAKER_INTERVAL-1e-9);if(!Number.isInteger(v.completed)||Number(v.completed)<reported||Number(v.completed)>=total)throw new Error('Invalid speaker progress.');reported=Number(v.completed);progress(reported,total);}else if(v.type==='sample'&&header){if(samples.length>=Math.ceil((r.end-r.start)/SPEAKER_INTERVAL-1e-9)||!validSample(v,r.start+samples.length*SPEAKER_INTERVAL))throw new Error('Invalid speaker sample.');samples.push(v as unknown as SpeakerSample);reported=Math.max(reported,samples.length);progress(reported,Math.ceil((r.end-r.start)/SPEAKER_INTERVAL-1e-9));}else if(v.type==='done'&&header&&v.completed===samples.length&&samples.length===Math.ceil((r.end-r.start)/SPEAKER_INTERVAL-1e-9)){done=true;}else throw new Error('Incomplete speaker output.');};
      child.stdout.on('data',(data:Buffer)=>{if(failure)return;bytes+=data.length;if(bytes>2*1024*1024){stop(new Error('Speaker analysis exceeded its section size.'));return;}buffer+=decoder.write(data);try{let n:number;while((n=buffer.indexOf('\n'))>=0){const next=buffer.slice(0,n);buffer=buffer.slice(n+1);if(next.trim())line(next);}}catch(error){stop(error instanceof Error?error:new Error('Invalid speaker output.'));}});
      child.stderr.on('data',(data:Buffer)=>{stderr=(stderr+data.toString('utf8')).slice(-16384);});child.on('error',error=>{failure=error;});
      child.on('close',code=>{clearTimeout(timer);if(kill)clearTimeout(kill);signal.removeEventListener('abort',abort);if(failure){reject(failure);return;}if(code!==0){reject(new Error(stderr.trim()||'Local speaker model failed.'));return;}const result={...header,samples};if(buffer.trim()||!done||!validChunk(result,r,r.start,r.end)){reject(new Error('Speaker analysis returned incomplete evidence.'));return;}resolveResult(result);});
    });
  }
}
