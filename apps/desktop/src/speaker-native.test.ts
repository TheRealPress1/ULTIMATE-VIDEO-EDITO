import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { SpeakerSample } from './speaker-types';
const exec = promisify(execFile);
// Opt in after build:native. Fixtures are generated locally with Apple frameworks.
const native = process.env.UVE_SPEAKER_NATIVE_TESTS === '1' && process.platform === 'darwin';
describe.skipIf(!native)('packaged native visible-speaker source clock', () => {
  let root: string, fixture: string;
  const binary=resolve('dist/speaker-analysis'), model=resolve('dist/speaker-model.mlmodelc');
  beforeAll(async()=>{
    root=await mkdtemp(join(tmpdir(),'uve-speaker-native-')); fixture=join(root,'offset-rotated-vfr.mp4');
    await mkdir(root,{recursive:true});
    await exec('swiftc',['-parse-as-library','-O',resolve('src/native/speaker_test_fixture.swift'),'-o',join(root,'make-fixture'),'-framework','AVFoundation','-framework','CoreVideo']);
    await exec(join(root,'make-fixture'),[fixture]);
  },30_000);
  afterAll(async()=>{if(root)await rm(root,{recursive:true,force:true});});
  it('preserves VFR source-relative times, nonzero first PTS, rotation, and intervening cuts',async()=>{
    const {stdout}=await exec(binary,[fixture,model,'0','2','2','.5']);
    const rows=stdout.trim().split('\n').map(s=>JSON.parse(s));
    expect(rows[0]).toMatchObject({type:'header',sourceStart:2,width:64,height:128,total:4,duration:2});
    const samples=rows.filter((v):v is SpeakerSample=>v.type==='sample');
    expect(samples.map(s=>s.time)).toEqual([0,.5,1,1.5]);
    expect(samples.every(s=>s.activeTrackId===null&&s.reason==='silence')).toBe(true);
    expect(samples[1]!.cut).toBe(true);
    expect(rows.at(-1)).toEqual({type:'done',completed:4});
  },20_000);
  it('fills the final sample when a trim ends between the25fps grid and a half-second timestamp',async()=>{
    const {stdout}=await exec(binary,[fixture,model,'0','1.51','2','.5']);
    const rows=stdout.trim().split('\n').map(s=>JSON.parse(s));
    expect(rows.filter(row=>row.type==='sample').map(row=>row.time)).toEqual([0,.5,1,1.5]);
    expect(rows.at(-1)).toEqual({type:'done',completed:4});
  },20_000);
  it('interpolates detections and median-smooths crop motion without crossing a cut',async()=>{
    const helpers=(await readFile(resolve('src/native/speaker_analysis.swift'),'utf8')).split('@main struct SpeakerAnalysis')[0]!;
    const assertions=`
@main struct Regression {
 static func main() {
  var frames=(0..<40).map{FrameEvidence(time:Double($0)/25,cut:$0==30,boxes:[])}
  for i in stride(from:0,through:25,by:5) {frames[i].boxes=[FaceBox(id:0,x:0.1+Double(i)*0.002,y:0.2,w:0.1,h:0.2,confidence:0.9)]}
  frames[31].boxes=[FaceBox(id:9,x:0.5,y:0.2,w:0.1,h:0.2,confidence:0.9)]
  let tracks=prepareTracks(frames,width:100,height:100)
  precondition(tracks.count==2 && tracks[0].boxes.count==30)
  precondition(tracks[1].boxes.count==5 && tracks[1].scores.allSatisfy{$0==nil})
  precondition(abs(tracks[0].boxes[2].x-0.104)<0.000001)
  precondition(abs(tracks[0].cropBoxes[10].x-tracks[0].cropBoxes[9].x)<0.003)
  precondition(tracks[0].first+tracks[0].boxes.count==30)
  let clipped=displayBox(FaceBox(id:3,x:-0.05,y:0.9,w:0.2,h:0.2,confidence:0.8))!
  precondition(clipped.x==0 && abs(clipped.w-0.15)<0.000001 && abs(clipped.h-0.1)<0.000001)
  print("interpolation, smoothing and shot boundary passed")
 }
}
`;
    await writeFile(join(root,'geometry.swift'),helpers+assertions);
    await exec('swiftc',['-parse-as-library','-O',join(root,'geometry.swift'),'-o',join(root,'geometry'),'-framework','AVFoundation','-framework','Vision','-framework','CoreImage','-framework','CoreML','-framework','Accelerate']);
    expect((await exec(join(root,'geometry'))).stdout).toContain('shot boundary passed');
  },30_000);
  it('rejects a mismatched renderer presentation origin',async()=>{
    await expect(exec(binary,[fixture,model,'0','1','0','.5'])).rejects.toThrow('source video clock changed');
  },20_000);
});
