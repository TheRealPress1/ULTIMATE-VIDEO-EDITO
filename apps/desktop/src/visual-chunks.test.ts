import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalVisualIndexService } from './visual-index';
let dir: string, source: string, runtimePath: string, calls: string;
const services: LocalVisualIndexService[] = [];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'uve-visual-sections-')));
  source = join(dir, 'source.mp4'); runtimePath = join(dir, 'worker.cjs'); calls = join(dir, 'calls.jsonl');
  await writeFile(source, 'original source'); await runtime();
});
afterEach(async () => { services.splice(0).forEach((value) => value.dispose()); await rm(dir, { recursive: true, force: true }); });
async function runtime(hangSecond = false) {
  await writeFile(runtimePath, `#!${process.execPath}
const fs=require('node:fs');
const [path,d,i,o,s,e]=process.argv.slice(2),duration=Number(d),sampleInterval=Number(i),sourceStart=Number(o);
const startIndex=s===undefined?0:Number(s),endIndex=e===undefined?Math.ceil(duration/sampleInterval-1e-9):Number(e),total=endIndex-startIndex;
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({startIndex,endIndex,sampleInterval,sourceStart})+'\\n');
const count=fs.readFileSync(${JSON.stringify(calls)},'utf8').trim().split('\\n').length;
function output(){const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
emit({type:'header',duration,sourceStart,sampleInterval,width:1920,height:1080,total});
for(let n=startIndex;n<endIndex;n++){const time=n*sampleInterval;emit({type:'sample',time,mediaTime:sourceStart+time,labels:[{text:'interview',confidence:.9}],text:[],people:2});}
emit({type:'done',completed:total});}
if(${hangSecond}&&count===2){fs.writeFileSync(${JSON.stringify(join(dir, 'waiting'))},'yes');setInterval(()=>{},1000);}else output();`, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
}
function service() { const value = new LocalVisualIndexService({ runtimePath, killGraceMs: 10 }); services.push(value); return value; }
const request = (duration = 250) => ({ id: randomUUID(), dir, source, duration, sourceStart: 2.375 });
const invocations = async () => (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { startIndex: number; endIndex: number; sampleInterval: number; sourceStart: number });
async function waitForWorker() {
  for (let n = 0; n < 400; n++) {
    if (await stat(join(dir, 'waiting')).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The worker did not start.');
}
describe.runIf(process.platform === 'darwin')('bounded resumable visual indexing', () => {
  it('covers ninety minutes on the original global PTS grid, bounded to 720 total frames', async () => {
    const progress: number[] = [];
    const result = await service().index(request(5400), (event) => progress.push(event.completed));
    expect(result.analysis?.samples).toHaveLength(675);
    expect(result.analysis?.samples.at(-1)).toMatchObject({ time: 5392, mediaTime: 5394.375 });
    expect(result.analysis?.sampleInterval).toBe(8);
    expect(progress.at(-1)).toBe(675);
    expect(progress.every((value, index) => !index || value >= progress[index - 1]!)).toBe(true);
    const runs = await invocations();
    expect(runs).toHaveLength(45);
    expect(runs.every((run) => (run.endIndex - run.startIndex) * run.sampleInterval <= 120)).toBe(true);
    expect(runs.flatMap((run) => Array.from({ length: run.endIndex - run.startIndex }, (_, index) => run.startIndex + index))).toEqual(Array.from({ length: 675 }, (_, index) => index));
    await rm(runtimePath);
    expect(await service().index(request(5400))).toEqual(result);
  }, 20000);
  it('keeps only complete checkpoints and resumes after cancellation and process restart', async () => {
    await runtime(true);
    const first = service(), input = request(), pending = first.index(input);
    const rejection = expect(pending).rejects.toThrow('cancelled');
    await waitForWorker(); first.cancel(input.id); await rejection; first.dispose();
    expect((await service().get(request())).analysis).toBeNull();
    await runtime();
    const result = await service().index(request());
    expect(result.analysis?.samples).toHaveLength(50);
    expect((await invocations()).map((run) => run.startIndex)).toEqual([0, 24, 24, 48]);
  });
  it('invalidates source-clock, interval and media changes, and rebuilds corrupt checkpoint files', async () => {
    await service().index(request(130)); expect(await invocations()).toHaveLength(2);
    await service().index({ ...request(130), sourceStart: 3 }); expect(await invocations()).toHaveLength(4);
    await service().index({ ...request(130), sampleInterval: 10 }); expect(await invocations()).toHaveLength(6);
    // Completed whole-file index is disposable; corrupt section JSON is a miss.
    await rm(join(dir, '.cutroom', 'visual-index.json'));
    for (const file of await readdir(join(dir, '.cutroom', 'analysis'))) await writeFile(join(dir, '.cutroom', 'analysis', file), '{broken');
    await service().index(request(130)); expect(await invocations()).toHaveLength(8);
    await writeFile(source, 'changed source');
    await service().index(request(130)); expect(await invocations()).toHaveLength(10);
  });
  it('accepts two-hour metadata while keeping the sampled grid bounded', async () => {
    const input = request(7200);
    // Cancellation after the first section verifies the 2h request without doing 60 workers.
    const value = service();
    await expect(value.index(input, (progress) => { if (progress.completed === 12) value.cancel(input.id); })).rejects.toThrow('cancelled');
    expect((await invocations())[0]).toMatchObject({ startIndex: 0, endIndex: 12, sampleInterval: 10 });
    await expect(service().index(request(7201))).rejects.toThrow('two hours');
  });
});
