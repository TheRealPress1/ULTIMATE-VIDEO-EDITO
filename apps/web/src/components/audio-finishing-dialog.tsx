import { createSignal, For, onCleanup, Show } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { getActiveEntity, Name, Source } from '@diffusionstudio/runtime';
import { useProject } from '@/context/project';
import { chatState } from '@/agent-chat/store';
import { getDocumentEditor } from '@/engine/editor';
import { audioFinishingMusicTracks, finishSceneAudio, measureSceneAudio } from '@/engine/audio-finishing';
import type { FinishingMusicTrack, SceneAudioFinishingResult } from '@/engine/audio-finishing';
import type { AudioLoudnessMeasurement } from '@desktop/audio-finishing-types';
import type { Entity } from 'koota';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import type { EditorToolDialogProps } from './editor-tool-dialog';

const db = (value: number | null | undefined, suffix: string): string => value === undefined || value === null ? '—' : `${value.toFixed(1)} ${suffix}`;
function Meter(props: { title: string; value: AudioLoudnessMeasurement }) {
  return <div class="rounded-lg border p-3"><p class="mb-2 text-xs font-medium text-muted-foreground">{props.title}</p><div class="grid grid-cols-3 gap-3 text-sm">
    <div><span class="block text-xs text-muted-foreground">Integrated loudness</span><strong>{db(props.value.integratedLufs, 'LUFS')}</strong></div>
    <div><span class="block text-xs text-muted-foreground">True peak</span><strong>{db(props.value.truePeakDb, 'dBTP')}</strong></div>
    <div><span class="block text-xs text-muted-foreground">Loudness range</span><strong>{db(props.value.loudnessRangeLu, 'LU')}</strong></div>
  </div></div>;
}

export function AudioFinishingDialog(props: EditorToolDialogProps = {}) {
  const world = useWorld(); const project = useProject();
  const [open, setOpen] = createSignal(false); const [scene, setScene] = createSignal<Entity>();
  const [name, setName] = createSignal(''); const [tracks, setTracks] = createSignal<FinishingMusicTrack[]>([]);
  const [musicIds, setMusicIds] = createSignal<string[]>([]);
  const [target, setTarget] = createSignal(-16); const [peak, setPeak] = createSignal(-1);
  const [level, setLevel] = createSignal(true); const [denoise, setDenoise] = createSignal(false);
  const [ducking, setDucking] = createSignal(12); const [threshold, setThreshold] = createSignal(-42);
  const [busy, setBusy] = createSignal(false); const [progress, setProgress] = createSignal(''); const [error, setError] = createSignal('');
  const [measurement, setMeasurement] = createSignal<AudioLoudnessMeasurement>();
  const [result, setResult] = createSignal<SceneAudioFinishingResult>(); const [warnings, setWarnings] = createSignal<string[]>([]);
  let controller: AbortController | undefined; let disposed = false;
  const agentRunning = () => (chatState.lists[project.id()] ?? []).some((chat) => chat.status === 'running' || chat.status === 'waiting');
  onCleanup(() => { disposed = true; controller?.abort(); });
  const show = () => {
    const active = getActiveEntity(world); setScene(active ?? undefined); setName(active?.get(Name)?.value ?? 'Selected scene');
    setTracks(active ? audioFinishingMusicTracks(world, active) : []); setMusicIds([]);
    setMeasurement(undefined); setResult(undefined); setWarnings([]); setProgress('');
    setError(active ? '' : 'Select a scene before measuring or finishing audio.'); setOpen(true);
  };
  const toggle = (id: string) => setMusicIds((values) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const run = async (finish: boolean) => {
    const source = scene(); if (!source || busy() || agentRunning() || result()) return;
    const dir = project.dir(); controller = new AbortController(); const signal = controller.signal;
    setBusy(true); setError(''); setWarnings([]); setProgress('Preparing audio…');
    const options = {
      signal, targetLufs: target(), truePeakDb: peak(), levelDialogue: level(), denoise: denoise(), musicIds: [...musicIds()], duckingDb: ducking(), activityThresholdDb: threshold(),
      assertCurrent: () => { signal.throwIfAborted(); if (disposed || project.dir() !== dir) throw new Error('The open project changed.'); if (agentRunning()) throw new Error('Wait for the agent to finish before processing audio.'); },
      onProgress: (message: string) => { if (!disposed) setProgress(message); },
    };
    try {
      if (finish) { const finished = await finishSceneAudio(world, source, dir, options); if (!disposed) { setResult(finished); setWarnings(finished.warnings); } }
      else { const measured = await measureSceneAudio(world, source, dir, options); if (!disposed) { setMeasurement(measured.measurement); setWarnings(measured.warnings); } }
    } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!disposed) { setBusy(false); setProgress(''); } controller = undefined; }
  };
  const review = () => {
    const id = result()?.sceneId; const created = id && world.query(Source).find((entity) => entity.get(Source)?.value === id);
    if (!created) { setError('The finished scene is no longer open. Reopen the project to review it.'); return; }
    const editor = getDocumentEditor(world); editor.activate(created); editor.select(created); setOpen(false);
  };
  props.triggerRef?.(show);
  return <>
    <Show when={!props.triggerRef}><button type="button" class="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={show}>Audio finish</button></Show>
    <Dialog open={open()} onOpenChange={(value) => { if (!busy()) setOpen(value); }}><DialogPortal><DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy()} onCloseAutoFocus={props.onCloseAutoFocus}>
      <DialogHeader><DialogTitle>{result() ? 'Finished audio is ready to review' : 'Finish dialogue and music'}</DialogTitle><DialogDescription>{name()} · local processing, original scene preserved.</DialogDescription></DialogHeader>
      <Show when={measurement()}>{(value) => <Meter title="Current complete scene mix" value={value()} />}</Show>
      <Show when={!result()}>
        <fieldset class="space-y-4 rounded-lg border p-4" disabled={busy()}>
          <legend class="px-1 text-xs text-muted-foreground">Dialogue</legend>
          <div class="grid grid-cols-2 gap-3"><label class="text-sm">Loudness target (LUFS)<input aria-label="Dialogue loudness target" type="number" min={-36} max={-9} step={1} value={target()} onInput={(event) => setTarget(Number(event.currentTarget.value))} class="mt-1 w-full rounded border bg-background px-3 py-2" /></label><label class="text-sm">True-peak ceiling (dBTP)<input aria-label="Dialogue true peak ceiling" type="number" min={-9} max={-0.1} step={0.1} value={peak()} onInput={(event) => setPeak(Number(event.currentTarget.value))} class="mt-1 w-full rounded border bg-background px-3 py-2" /></label></div>
          <label class="flex items-center gap-3 text-sm"><input type="checkbox" checked={level()} onChange={(event) => setLevel(event.currentTarget.checked)} class="accent-emerald-500" />Even out quiet and loud dialogue</label>
          <label class="flex items-center gap-3 text-sm"><input type="checkbox" checked={denoise()} onChange={(event) => setDenoise(event.currentTarget.checked)} class="accent-emerald-500" />Reduce steady background noise</label>
          <p class="text-xs text-muted-foreground">The dialogue mix becomes a separate finished WAV. Noise reduction can change ambience or consonants; listen before exporting.</p>
        </fieldset>
        <fieldset class="space-y-3 rounded-lg border p-4" disabled={busy()}>
          <legend class="px-1 text-xs text-muted-foreground">Music and background tracks</legend>
          <p class="text-xs text-muted-foreground">Select the audio clips to keep separate. Everything else is treated as dialogue. Background clips remain editable, including existing fades and volume changes.</p>
          <Show when={tracks().length} fallback={<p class="text-sm text-muted-foreground">No separate audio clips directly in this scene. All audible media will be included in the dialogue mix.</p>}>
            <div class="max-h-32 space-y-2 overflow-y-auto"><For each={tracks()}>{(track) => <label class="flex items-center gap-3 text-sm"><input type="checkbox" checked={musicIds().includes(track.id)} onChange={() => toggle(track.id)} class="accent-emerald-500" /><span class="truncate">{track.name}</span></label>}</For></div>
          </Show>
          <Show when={musicIds().length}><div class="grid grid-cols-2 gap-3"><label class="text-sm">Lower music by (dB)<input aria-label="Music ducking amount" type="number" min={0} max={30} value={ducking()} onInput={(event) => setDucking(Number(event.currentTarget.value))} class="mt-1 w-full rounded border bg-background px-3 py-2" /></label><label class="text-sm">Dialogue threshold (dBFS)<input aria-label="Dialogue activity threshold" type="number" min={-70} max={-10} value={threshold()} onInput={(event) => setThreshold(Number(event.currentTarget.value))} class="mt-1 w-full rounded border bg-background px-3 py-2" /></label></div><p class="text-xs text-muted-foreground">Ducking follows audio activity and adds adjustable volume keyframes to a music group.</p></Show>
        </fieldset>
      </Show>
      <Show when={result()}>{(finished) => <>
        <Meter title="Finished dialogue" value={finished().dialogue} />
        <Show when={finished().mix}>{(mix) => <Meter title="Finished complete scene mix" value={mix()} />}</Show>
        <p class="text-sm">Created <strong>{finished().name}</strong>. {finished().musicKeyframeCount ? `${finished().musicKeyframeCount} music ducking keyframes are editable on the Music ducking group. ` : ''}One Undo removes the new scene; the original remains intact.</p>
      </>}</Show>
      <Show when={warnings().length}><div class="space-y-1 rounded border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400"><For each={warnings()}>{(warning) => <p>{warning}</p>}</For></div></Show>
      <Show when={error()}><p role="alert" class="rounded border border-red-400/30 p-3 text-sm text-red-400">{error()}</p></Show>
      <Show when={agentRunning()}><p class="text-xs text-amber-400">Wait for the agent to finish before processing audio.</p></Show>
      <Show when={busy()}><p role="status" class="text-sm text-muted-foreground">{progress()}</p></Show>
      <div class="flex justify-end gap-2"><Show when={busy()} fallback={<Show when={result()} fallback={<><Button variant="outline" onClick={() => void run(false)} disabled={!scene() || agentRunning()}>Measure scene</Button><Button onClick={() => void run(true)} disabled={!scene() || agentRunning()}>Create finished version</Button></>}><Button onClick={review}>Review finished scene</Button></Show>}><Button variant="outline" onClick={() => controller?.abort()}>Cancel processing</Button></Show></div>
    </DialogContent></DialogPortal></Dialog>
  </>;
}
