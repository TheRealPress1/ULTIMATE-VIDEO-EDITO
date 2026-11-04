import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { createImageEncoder, warmupAssets } from '@diffusionstudio/encoder';
import { AssetId, Animation, Keyframe, KeyframeTrack, Computed, FrameRate, Source, Workarea, getAsset, getAssetFile, getEntityTree, getLibrary, isScene } from '@diffusionstudio/runtime';
import { isUrlSource } from '@diffusionstudio/assets';
import type { Entity, World } from 'koota';
import type { AnalysisCacheRequest, AnalysisCacheResult } from '@desktop/analysis-cache-types';
import { createCapture } from './capture';
import { encodeScenePcm, hasAudio, isAudibleMedia } from './scene-audio';
import { analyzePcm } from '@/dapi/lib/audio-finish';
import { flushProjectEdits } from '@/projects/edits';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { DEFAULT_PAUSE_THRESHOLDS, PAUSE_JOIN_SECONDS, inspectAudioSamples, inspectFramePixels, mergeQualityFindings, mergeReportFindings, resolvePauseThresholds, reviewFrames, type AudioPauseThresholds, type QualityFinding } from './quality-analysis';
import { inspectTextLayout } from './quality-layout';

export type QualityReport = {
  sceneId: string; fingerprint: string; createdAt: string; duration: number; sampledFrames: number;
  findings: QualityFinding[]; limitations: string[]; audioReviewed: boolean;
};
export const REVIEW_MAX_SECONDS = 7200;
export const REVIEW_CHUNK_SECONDS = 120;
const AUDIO_OVERLAP = 1;
const CACHE_ENGINE = 'quality-review-chunks-v2';
type ReviewChunk = { start: number; end: number; sampledFrames: number; findings: QualityFinding[]; audioReviewed: boolean };
let running = false;

function cachedChunk(value: unknown, start: number, end: number, frames: number, audio: boolean): ReviewChunk | undefined {
  if (!value || typeof value !== 'object') return;
  const chunk = value as ReviewChunk;
  if (chunk.start !== start || chunk.end !== end || chunk.sampledFrames !== frames || chunk.audioReviewed !== audio || !Array.isArray(chunk.findings) || chunk.findings.length > 1000) return;
  for (const f of chunk.findings) if (!f || typeof f.code !== 'string' || f.code.length > 100 || !['warning','error'].includes(f.severity) || typeof f.message !== 'string' || f.message.length > 2000 || !['pixels','layout','audio'].includes(f.evidence) || !Number.isFinite(f.time) || f.time < start - 1e-6 || f.time >= end + 1e-6 || (f.end !== undefined && (!Number.isFinite(f.end) || f.end < f.time || f.end > end + 1e-6)) || (f.node !== undefined && (typeof f.node !== 'string' || f.node.length > 1000))) return;
  return chunk;
}
async function cacheGet(request: AnalysisCacheRequest, signal: AbortSignal): Promise<AnalysisCacheResult> {
  const id = crypto.randomUUID();
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_CANCEL, { id }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try { signal.throwIfAborted(); const result = await mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_GET, { ...request, id }); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
async function cachePut(request: AnalysisCacheRequest, fingerprint: string, chunk: string, value: ReviewChunk, signal: AbortSignal): Promise<void> {
  const id = crypto.randomUUID();
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_CANCEL, { id }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try { signal.throwIfAborted(); await mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_PUT, { ...request, id, fingerprint, chunk, value }); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', cancel); }
}

/** Isolated rendered observations in bounded, restartable sections. Originals remain read-only. */
export async function reviewScene(world: World, scene: Entity, dir: string, options: {
  signal?: AbortSignal; audio?: boolean; onProgress?: (message: string) => void; assertCurrent?: () => void;
  /** Quiet-pause thresholds for the audio pass; the defaults report a second below -60 dBFS. */
  pauses?: AudioPauseThresholds;
} = {}): Promise<QualityReport> {
  if (running) throw new Error('A quality review is already running.');
  if (!isScene(scene)) throw new Error('Choose a complete scene for review.');
  running = true;
  const signal = options.signal ?? new AbortController().signal;
  const current = () => { signal.throwIfAborted(); options.assertCurrent?.(); if (!scene.isAlive()) throw new Error('The scene changed during review.'); };
  let capture: Awaited<ReturnType<typeof createCapture>> | undefined;
  try {
    current(); await flushProjectEdits(dir); current();
    const before = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSIONS, { dir }); current();
    const sceneId = scene.get(Source)?.value;
    if (!sceneId) throw new Error('Save this scene before reviewing it.');
    const fps = world.get(FrameRate)?.value ?? 30;
    const library = getLibrary(world), sourceStats = new Map<string,{size:number;mtime:number}>();
    const liveNodes = getEntityTree(world,scene);
    const isMotion = (node: Entity) => node.has?.(Keyframe) || node.has?.(KeyframeTrack) || node.has?.(Animation);
    if (liveNodes.length > 100000 || liveNodes.filter(node => !isMotion(node)).length > 2000) throw new Error('Review supports up to 2,000 drawable/media layers and 100,000 total nodes. Review a smaller scene.');
    for (const node of liveNodes) {
      const id=node.get(AssetId)?.value;if(!id)continue;
      const asset=getAsset(world,id);if(!asset||sourceStats.has(asset.source))continue;
      if(isUrlSource(asset.source))throw new Error('Download linked media locally before reviewing this scene.');
      const stat=await library.fs.stat(asset.source);current();
      if(!stat||asset.stat&&(stat.size!==asset.stat.size||Math.floor(stat.mtime)!==Math.floor(asset.stat.mtime)))throw new Error('A media file changed or is unavailable. Re-import it before reviewing.');
      await getAssetFile(asset,true);current();sourceStats.set(asset.source,{size:stat.size,mtime:stat.mtime});
    }
    const unchanged = async () => {
      current(); await flushProjectEdits(dir); current();
      for(const [source,expected] of sourceStats){const actual=await library.fs.stat(source);current();if(!actual||actual.size!==expected.size||actual.mtime!==expected.mtime)throw new Error('A media file changed during review. Run review again.');}
      const after=await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSIONS,{dir});current();
      if(after.fingerprint!==before.fingerprint)throw new Error('The project changed during review. Run review again for the current edit.');
    };
    capture = await createCapture(world,scene,{dir,frameRate:fps}); current();
    await warmupAssets(capture.world);current();
    const computed = capture.node.get(Computed)!;
    const workarea = capture.node.get(Workarea);
    const start = Math.max(0,Math.min(computed.end,workarea?.start ?? 0));
    const end = Math.max(start,Math.min(computed.end,workarea?.end || computed.end));
    const duration = (end-start)/fps;
    if (!Number.isFinite(duration) || duration <= 0 || duration > REVIEW_MAX_SECONDS || computed.end / fps > REVIEW_MAX_SECONDS) throw new Error('Quality review supports scenes up to two hours.');
    const nodes = getEntityTree(capture.world,capture.node).filter(node => !isMotion(node));
    const boundaries = nodes.flatMap(node=>{const c=node.get(Computed);return c?[c.start,c.end]:[];});
    const audioBoundaries = nodes.filter(node=>isAudibleMedia(node,capture!.node)).flatMap(node=>{const c=node.get(Computed);return c?[c.start/fps,c.end/fps]:[];});
    const includeAudio = options.audio !== false && hasAudio(world,scene);
    const pauses = resolvePauseThresholds(options.pauses);
    // Default thresholds keep the original key, so sections saved before they existed stay reusable.
    const custom = includeAudio && (pauses.thresholdDb !== DEFAULT_PAUSE_THRESHOLDS.thresholdDb || pauses.minSeconds !== DEFAULT_PAUSE_THRESHOLDS.minSeconds);
    const cacheRequest = { dir, key: JSON.stringify([CACHE_ENGINE,before.fingerprint,sceneId,fps,start,end,includeAudio,...custom?[pauses.thresholdDb,pauses.minSeconds]:[]]), sources: [...sourceStats.keys()] };
    options.onProgress?.('Checking saved review sections…');
    const cached = await cacheGet(cacheRequest, signal); current();
    const checkpointed = /^[a-f0-9]{64}$/.test(cached?.fingerprint ?? '') && !!cached?.chunks;
    const findings: QualityFinding[] = [];
    const count = Math.ceil(duration / REVIEW_CHUNK_SECONDS);
    let sampledFrames = 0, resumed = 0;
    for (let index = 0; index < count; index++) {
      current();
      const from = start + index * REVIEW_CHUNK_SECONDS * fps, to = Math.min(end,from + REVIEW_CHUNK_SECONDS * fps);
      const frames = reviewFrames(from,to,fps,boundaries);
      const key = `section-${index}`;
      let chunk = cachedChunk(cached?.chunks?.[key], from/fps, to/fps, frames.length, includeAudio);
      if (chunk) { resumed++; options.onProgress?.(`Restored review section ${index+1}/${count}…`); }
      else {
        const local: QualityFinding[] = [];
        let processed = 0;
        const encoder = await createImageEncoder(capture.world,{
          frames: frames.map(f=>f-start), resolution: Math.min(360,360*computed.height/computed.width),
          onFrame: (relative,canvas)=>{
            current(); const time=(start+relative)/fps;
            const observation=inspectFramePixels(canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height));
            if(observation.darkFraction>.98)local.push({code:'dark-frame',severity:'warning',message:'This rendered sample is almost entirely black. Confirm the fade or gap is intentional.',time,evidence:'pixels'});
            else if(observation.border)local.push({code:'dark-border',severity:'warning',message:'Dark edges surround this frame. Review letterboxing or the crop.',time,evidence:'pixels'});
            local.push(...inspectTextLayout(capture!.world,nodes,canvas,time));
            options.onProgress?.(`Reviewing section ${index+1}/${count} · frames ${++processed}/${frames.length}…`);
          },
        });
        const cancel=()=>encoder.cancel();signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)encoder.cancel();
        try {const result=await encoder.render();current();if(result.type==='error')throw result.error;if(result.type!=='success')throw new Error('Review canceled.');}
        finally {signal.removeEventListener('abort',cancel);}
        if (includeAudio) {
          options.onProgress?.(`Reviewing audio section ${index+1}/${count}…`);
          const audioStart=Math.max(start/fps,from/fps-AUDIO_OVERLAP),audioEnd=Math.min(end/fps,to/fps+AUDIO_OVERLAP);
          const file=await encodeScenePcm(world,scene,dir,{signal,window:{start:audioStart,end:audioEnd}});current();
          const input=new Input({formats:ALL_FORMATS,source:new BlobSource(file)});
          const abort=()=>input.dispose();signal.addEventListener('abort',abort,{once:true});
          try {
            const track=await input.getPrimaryAudioTrack();if(!track)throw new Error('The rendered mix has no audio track.');
            const pcm=await analyzePcm(new AudioBufferSink(track).buffers(0),true,signal,64*1024*1024);
            if (Math.abs(pcm.frames / pcm.sampleRate - (audioEnd-audioStart)) > Math.max(0.05,1/fps)) throw new Error('The rendered audio section was incomplete. Run review again.');
            const channels=Array.from({length:pcm.channels},()=>new Float32Array(pcm.frames));
            for(const block of pcm.blocks)block.channels.forEach((values,i)=>channels[i]!.set(values,block.frame));
            for(const finding of inspectAudioSamples(channels,pcm.sampleRate,audioBoundaries.map(time=>time-audioStart),pauses)) {
              const time=audioStart+finding.time,finish=finding.end===undefined?undefined:audioStart+finding.end;
              if(time>=to/fps || (finish??time)<from/fps)continue;
              local.push({...finding,time:Math.max(from/fps,time),...(finish===undefined?{}:{end:Math.min(to/fps,finish)})});
            }
          } finally {signal.removeEventListener('abort',abort);input.dispose();}
        }
        chunk={start:from/fps,end:to/fps,sampledFrames:frames.length,findings:mergeQualityFindings(local,PAUSE_JOIN_SECONDS,1000),audioReviewed:includeAudio};
        if (checkpointed) { await unchanged(); await cachePut(cacheRequest,cached.fingerprint,key,chunk,signal); current(); }
      }
      sampledFrames+=chunk.sampledFrames;findings.push(...chunk.findings);
    }
    await unchanged();
    const limitations=['Sampled frames can miss brief problems between samples. Dark shots and borders may be intentional.','Layout checks flag potential clipping; review styling and captions visually.','Lip-sync, speaker identity, narrative quality, and HDR mastering are not measured.',`Review covers ${count} bounded section${count===1?'':'s'}${resumed?`; reused ${resumed} completed section${resumed===1?'':'s'}`:''}. Audio overlaps section joins by one second.`];
    if(findings.length>2000)limitations.push('The report is limited to 2,000 grouped observations. Review shorter workareas to inspect additional findings.');
    return {sceneId,fingerprint:before.fingerprint,createdAt:new Date().toISOString(),duration,sampledFrames,
      findings:mergeReportFindings(findings,Math.max(2,duration/Math.max(1,sampledFrames/2)),pauses,2000),limitations,audioReviewed:includeAudio};
  } finally {capture?.dispose();running=false;}
}
