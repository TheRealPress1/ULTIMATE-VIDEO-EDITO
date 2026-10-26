import { describe, expect, it } from 'vitest';
import { inspectAudioSamples, inspectFramePixels, mergeQualityFindings, reviewFrames } from './quality-analysis';
describe('rendered review measurements', () => {
  it('distinguishes dark pixels and letterboxing from a bright frame', () => {
    const data = new Uint8ClampedArray(40*40*4).fill(255);
    expect(inspectFramePixels({width:40,height:40,data}).darkFraction).toBe(0);
    for(let y=0;y<40;y++)for(let x=0;x<40;x++)if(x<2||y<2||x>37||y>37){const i=(y*40+x)*4;data[i]=data[i+1]=data[i+2]=0;}
    expect(inspectFramePixels({width:40,height:40,data}).border).toBe(true);
    data.fill(0); expect(inspectFramePixels({width:40,height:40,data}).darkFraction).toBe(1);
  });
  it('samples workarea endpoints and cut boundaries without leaving the scene', () => {
    const frames=reviewFrames(45,300,30,[90,150,400]);
    expect(frames[0]).toBe(45);expect(frames.at(-1)).toBe(299);
    expect(frames).toEqual(expect.arrayContaining([89,90,91,149,150,151]));
    expect(reviewFrames(0,300000,30,Array.from({length:10000},(_,i)=>i*20))).toHaveLength(120);
  });
  it('reports measured clipping, long silence and a join discontinuity', () => {
    const samples=new Float32Array(48000*3); for(let i=48000;i<samples.length;i++) samples[i]=.4*Math.sin(i*.1);
    samples[96000]=1;
    const findings=inspectAudioSamples([samples],48000,[1,2]);
    expect(findings.map(f=>f.code)).toEqual(expect.arrayContaining(['audio-clipping','audio-silence','audio-join']));
    expect(findings.find(f=>f.code==='audio-silence')?.end).toBe(1);
  });
  it('does not merge findings on separate layers',()=>{
    const base={code:'caption',severity:'warning' as const,message:'Check',evidence:'layout' as const};
    expect(mergeQualityFindings([{...base,time:0,node:'a'},{...base,time:1,node:'a'},{...base,time:1,node:'b'}],2)).toHaveLength(2);
  });
  it('rejects malformed samples and an empty workarea',()=>{
    expect(()=>reviewFrames(5,5,30)).toThrow();expect(()=>inspectAudioSamples([new Float32Array([NaN])],48000)).toThrow();
  });
});
