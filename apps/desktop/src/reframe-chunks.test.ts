import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalReframeService } from './reframe-analysis';
let dir: string, path: string, runtimePath: string, counter: string;
const services: LocalReframeService[]=[];
beforeEach(async()=>{dir=await realpath(await mkdtemp(join(tmpdir(),'uve-face-sections-')));path=join(dir,'source.mp4');runtimePath=join(dir,'worker.cjs');counter=join(dir,'calls');await writeFile(path,'video source');await runtime();});
afterEach(async()=>{services.splice(0).forEach(s=>s.dispose());await rm(dir,{recursive:true,force:true});});
async function runtime(hangSecond=false){
  await writeFile(runtimePath,`#!${process.execPath}\nconst fs=require('node:fs');const count=Number(fs.existsSync(${JSON.stringify(counter)})?fs.readFileSync(${JSON.stringify(counter)},'utf8'):0)+1;fs.writeFileSync(${JSON.stringify(counter)},String(count));
const [path,s,e,i,sourceStart]=process.argv.slice(2);const start=Number(s),end=Number(e),interval=Number(i),total=Math.ceil((end-start)/interval-1e-9);
function output(){const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');emit({type:'header',duration:7200,width:640,height:360,total,sampleInterval:interval});for(let n=0;n<total;n++){const time=start+n*interval;emit({type:'sample',time,faces:[],cut:Math.abs(time-120)<1e-7});}emit({type:'done',completed:total});}
if(${hangSecond}&&count===2){fs.writeFileSync(${JSON.stringify(join(dir,'waiting'))},'1');setInterval(()=>{},1000);}else output();\n`,{mode:0o700});await chmod(runtimePath,0o700);
}
function service(){const s=new LocalReframeService({runtimePath,cacheDir:join(dir,'cache'),killGraceMs:10});services.push(s);return s;}
const req=(end=260)=>({id:randomUUID(),path,start:0,end});
async function untilFile(path:string){for(let n=0;n<400;n++){if(await stat(path).then(()=>true,()=>false))return;await new Promise(r=>setTimeout(r,5));}throw new Error('worker not started');}
describe.runIf(process.platform==='darwin')('bounded resumable face analysis',()=>{
  it('covers a ninety-minute recording with one global grid and monotonic progress',async()=>{
    const progress:number[]=[];const result=await service().analyze(req(5400),p=>progress.push(p.completed));
    expect(result.samples).toHaveLength(10800);expect(result.samples[0]!.time).toBe(0);expect(result.samples.at(-1)!.time).toBe(5399.5);
    expect(result.samples.find(s=>s.time===120)?.cut).toBe(true);
    expect(progress.at(-1)).toBe(10800);expect(progress.every((n,i)=>i===0||n>=progress[i-1]!)).toBe(true);
    expect(Number(await readFile(counter,'utf8'))).toBe(45);
  },20000);
  it('retains completed chunks on cancel and resumes after service restart',async()=>{
    await runtime(true);const first=service(),request=req();const pending=first.analyze(request);const reject=expect(pending).rejects.toThrow('cancelled');
    await untilFile(join(dir,'waiting'));first.cancel(request.id);await reject;first.dispose();
    await runtime();const result=await service().analyze(req());expect(result.samples).toHaveLength(520);
    expect(Number(await readFile(counter,'utf8'))).toBe(4);
  });
  it('reuses only unchanged source/settings checkpoints',async()=>{
    const first=service();await first.analyze(req(130));expect(Number(await readFile(counter,'utf8'))).toBe(2);
    await service().analyze(req(130));expect(Number(await readFile(counter,'utf8'))).toBe(2);
    await service().analyze({...req(130),sourceStart:2});expect(Number(await readFile(counter,'utf8'))).toBe(4);
    await writeFile(path,'changed media');await service().analyze(req(130));expect(Number(await readFile(counter,'utf8'))).toBe(6);
  });
});
