import { createSignal, For, onCleanup, Show } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { FrameRate, getActiveEntity, Name, setActive, setPlayhead } from '@diffusionstudio/runtime';
import type { Entity } from 'koota';
import { useProject } from '@/context/project';
import { chatState } from '@/agent-chat/store';
import { useEngineContext } from '@/engine';
import { reviewScene, type QualityReport } from '@/engine/quality-review';
import { flushProjectEdits } from '@/projects/edits';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from './ui/dialog';
import type { EditorToolDialogProps } from './editor-tool-dialog';

export function QualityReviewDialog(props: EditorToolDialogProps = {}) {
  const world=useWorld(),project=useProject(),engine=useEngineContext();
  const [open,setOpen]=createSignal(false),[busy,setBusy]=createSignal(false),[audio,setAudio]=createSignal(true);
  const [message,setMessage]=createSignal(''),[error,setError]=createSignal(''),[report,setReport]=createSignal<QualityReport>();
  const [name,setName]=createSignal('Scene');let controller:AbortController|undefined,scene:Entity|undefined,reviewDir='';let alive=true;
  const agentRunning=()=>(chatState.lists[project.id()]??[]).some(c=>c.status==='running'||c.status==='waiting');
  onCleanup(()=>{alive=false;controller?.abort();});
  const show=()=>{scene=getActiveEntity(world)??undefined;reviewDir=project.dir();setName(scene?.get(Name)?.value||'Scene');setReport(undefined);setError(scene?'':'Select a scene first.');setMessage('');setOpen(true);};
  const run=async()=>{
    if(!scene||busy()||agentRunning())return;controller=new AbortController();setBusy(true);setError('');setReport(undefined);engine.stop();
    try{const result=await reviewScene(world,scene,reviewDir,{signal:controller.signal,audio:audio(),onProgress:setMessage,assertCurrent:()=>{if(!alive||project.dir()!==reviewDir||agentRunning())throw new Error('The project or active edit changed. Run review again.');}});if(alive)setReport(result);}
    catch(e){if(alive)setError(controller.signal.aborted?'Review canceled.':(e as Error).message);}
    finally{if(alive){setBusy(false);setMessage('');engine.start();}}
  };
  const seek=async(time:number)=>{
    try{const current=report();if(!scene?.isAlive()||!current||project.dir()!==reviewDir)throw new Error('Re-run review for the open scene.');
      await flushProjectEdits(reviewDir);const state=await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSIONS,{dir:reviewDir});
      if(state.fingerprint!==current.fingerprint)throw new Error('The edit changed since this review. Run it again.');
      setActive(world,scene);setPlayhead(world,scene,Math.round(time*(world.get(FrameRate)?.value??30)));setOpen(false);
    }catch(e){setError((e as Error).message);}
  };
  props.triggerRef?.(show);
  return <>
    <Show when={!props.triggerRef}><button type="button" class="text-sm text-muted-foreground hover:text-foreground" onClick={show}>Review</button></Show>
    <Dialog open={open()} onOpenChange={value=>{if(!busy())setOpen(value);}}><DialogPortal><DialogContent class="max-w-3xl max-h-[85vh] overflow-y-auto" onCloseAutoFocus={props.onCloseAutoFocus}>
      <DialogHeader><DialogTitle>Quality review</DialogTitle><DialogDescription>Check rendered frames and audio in {name()}. Completed sections are saved automatically and resume after cancellation or restart. Findings point to moments to inspect; your edit stays unchanged.</DialogDescription></DialogHeader>
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" checked={audio()} disabled={busy()} onChange={e=>setAudio(e.currentTarget.checked)}/> Include audio clipping, pauses and joins</label>
      <div class="flex gap-2"><Button onClick={()=>void run()} disabled={busy()||!scene||agentRunning()}>{report()?'Run again':'Review scene'}</Button><Show when={busy()}><Button variant="outline" onClick={()=>controller?.abort()}>Cancel</Button></Show></div>
      <Show when={message()}><p aria-live="polite" class="text-sm text-muted-foreground">{message()}</p></Show>
      <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
      <Show when={report()}>{r=><>
        <p class="text-sm">Reviewed {r().sampledFrames} frames{r().audioReviewed?' and the audio mix':''}. {r().findings.length} observations.</p>
        <Show when={!r().findings.length}><p class="text-sm text-muted-foreground">No issues were detected in these samples. Play through the complete edit before publishing.</p></Show>
        <div class="divide-y rounded-lg border"><For each={r().findings}>{finding=><button type="button" class="w-full text-left px-4 py-3 hover:bg-muted/40" onClick={()=>void seek(finding.time)}>
          <span class="block text-xs text-muted-foreground">{finding.time.toFixed(2)}s{finding.end?`–${finding.end.toFixed(2)}s`:''} · {finding.evidence} · inspect moment</span><span class="text-sm">{finding.message}</span>
        </button>}</For></div>
        <div class="text-xs text-muted-foreground space-y-1"><For each={r().limitations}>{note=><p>{note}</p>}</For></div>
      </>}</Show>
    </DialogContent></DialogPortal></Dialog>
  </>;
}
