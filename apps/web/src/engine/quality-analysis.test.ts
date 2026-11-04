import { describe, expect, it } from 'vitest';
import { inspectAudioSamples, inspectFramePixels, mergeQualityFindings, mergeReportFindings, resolvePauseThresholds, reviewFrames } from './quality-analysis';
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
  it('reports shorter or louder pauses with caller thresholds, keeping the default report unchanged',()=>{
    // Speech at about -9 dBFS with a 0.3 s gap at -50 dBFS (RMS 0.00316) and a 1.2 s gap of digital silence.
    const rate=48000,samples=new Float32Array(rate*4);
    for(let i=0;i<samples.length;i++)samples[i]=.5*Math.sin(i*.05);
    for(let i=rate;i<rate*1.3;i++)samples[i]=.00316*Math.SQRT2*Math.sin(i*.05);
    samples.fill(0,rate*2.5,rate*3.7);
    const defaults=inspectAudioSamples([samples],rate).filter(f=>f.code==='audio-silence');
    expect(defaults.map(f=>[f.time,f.end])).toEqual([[2.5,3.7]]);
    expect(defaults[0]!.message).toMatch(/at least one second/);
    const tight=inspectAudioSamples([samples],rate,[],{thresholdDb:-45,minSeconds:.25}).filter(f=>f.code==='audio-silence');
    expect(tight.map(f=>[f.time,f.end])).toEqual([[1,1.3],[2.5,3.7]]);
    expect(tight[0]!.message).toMatch(/below -45 dBFS for 0\.30s/);
    expect(inspectAudioSamples([samples],rate,[],{thresholdDb:-45,minSeconds:.5}).filter(f=>f.code==='audio-silence')).toHaveLength(1);
    expect(()=>inspectAudioSamples([samples],rate,[],{thresholdDb:-80})).toThrow('between -70 and -20');
    expect(()=>resolvePauseThresholds({minSeconds:.05})).toThrow('0.1 and 5');
  });
  it('keeps each tight pause its own finding in the whole report, rejoining only a pause split by a section seam',()=>{
    // Three 0.3 s pauses 1.2 s apart, as a tight pass leaves them.
    const rate=48000,samples=new Float32Array(rate*5);
    for(let i=0;i<samples.length;i++)samples[i]=.5*Math.sin(i*.05);
    for(const at of [1,2.5,4])samples.fill(0,rate*at,rate*(at+.3));
    const tight={thresholdDb:-45,minSeconds:.25};
    const section=inspectAudioSamples([samples],rate,[],tight);
    const report=mergeReportFindings(section,2,tight);
    expect(report.map(f=>[f.time,f.end].map(t=>Math.round(t!*1000)/1000))).toEqual([[1,1.3],[2.5,2.8],[4,4.3]]);
    for(const f of report)expect(f.message).toMatch(/for 0\.30s/);
    // One pause cut at a 120 s section seam is reported once, worded from its whole span.
    const piece={code:'audio-silence',severity:'warning' as const,evidence:'audio' as const,message:'piece'};
    const seam=mergeReportFindings([{...piece,time:119.8,end:120},{...piece,time:120,end:120.15}],2,tight);
    expect(seam).toEqual([expect.objectContaining({time:119.8,end:120.15,message:expect.stringMatching(/for 0\.35s/)})]);
    // Visual findings still group across the report gap.
    const dark={code:'dark-frame',severity:'warning' as const,evidence:'pixels' as const,message:'Dark'};
    expect(mergeReportFindings([{...dark,time:1},{...dark,time:2.5},{...dark,time:4}],2)).toEqual([expect.objectContaining({time:1,end:4})]);
  });
  it('does not merge findings on separate layers',()=>{
    const base={code:'caption',severity:'warning' as const,message:'Check',evidence:'layout' as const};
    expect(mergeQualityFindings([{...base,time:0,node:'a'},{...base,time:1,node:'a'},{...base,time:1,node:'b'}],2)).toHaveLength(2);
  });
  it('rejects malformed samples and an empty workarea',()=>{
    expect(()=>reviewFrames(5,5,30)).toThrow();expect(()=>inspectAudioSamples([new Float32Array([NaN])],48000)).toThrow();
  });
});
