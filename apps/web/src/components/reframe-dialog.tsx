import { createSignal, For, Index, onCleanup, Show } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { authoredElement } from '@diffusionstudio/reconciler';
import { Computed, focusRect, FrameRate, getActiveEntity, Name, Source } from '@diffusionstudio/runtime';
import { toolByName } from '@diffusionstudio/dapi';
import type { Entity } from 'koota';
import { useProject } from '@/context/project';
import { chatState } from '@/agent-chat/store';
import { getDocumentEditor } from '@/engine/editor';
import { createReframeVariants, REFRAME_FORMATS } from '@/engine/reframe';
import type { ReframeFormat, ReframeMode, ReframeResult } from '@/engine/reframe';
import type { SpeakerFramingOptions, SpeakerFramingOverride, SpeakerFramingPreference } from '@/engine/speaker-framing-options';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import type { EditorToolDialogProps } from './editor-tool-dialog';

const FRAMING_CHOICES = [
  { value: 'auto', label: 'Automatic' }, { value: 'left', label: 'Follow left person' },
  { value: 'right', label: 'Follow right person' }, { value: 'wide', label: 'Stay wide' },
] as const;
type CorrectionRow = { id: number; start: string; end: string; preference: SpeakerFramingOverride['preference'] };

/** Create editable format variants, then let the user inspect each before export. */
export function ReframeDialog(props: EditorToolDialogProps = {}) {
  const world = useWorld();
  const project = useProject();
  const [open, setOpen] = createSignal(false);
  const [scene, setScene] = createSignal<Entity>();
  const [sceneName, setSceneName] = createSignal('');
  const [formats, setFormats] = createSignal<ReframeFormat[]>(['vertical', 'square', 'landscape']);
  const [mode, setMode] = createSignal<ReframeMode>('speakers');
  const [preference, setPreference] = createSignal<SpeakerFramingPreference>('auto');
  const [corrections, setCorrections] = createSignal<CorrectionRow[]>([]);
  const [sceneEnd, setSceneEnd] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal('');
  const [error, setError] = createSignal('');
  const [result, setResult] = createSignal<ReframeResult>();
  let controller: AbortController | undefined;
  let correctionId = 0;
  const speakerFraming = (): SpeakerFramingOptions => ({ preference: preference(), overrides: corrections().map(({ start, end, preference }) => ({ start: Number(start), end: Number(end), preference })) });
  const correctionError = () => {
    if (mode() !== 'speakers') return '';
    if (corrections().some(row => !row.start.trim() || !row.end.trim())) return 'Enter a start and end for each framing correction.';
    const value = speakerFraming(), parsed = toolByName('reframe').input.shape.speakerFraming.safeParse(value);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Check the framing correction ranges.';
    if (value.overrides?.some(range => range.end > sceneEnd() + 1e-6)) return `Framing corrections must stay within this scene (0–${sceneEnd().toFixed(2)} seconds).`;
    return '';
  };
  const updateCorrection = (id: number, patch: Partial<Omit<CorrectionRow, 'id'>>) => setCorrections(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
  const addCorrection = () => {
    const ranges = speakerFraming().overrides?.filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start).sort((a, b) => a.start - b.start) ?? [];
    const gaps: { start: number; end: number }[] = []; let cursor = 0;
    for (const range of ranges) { if (range.start > cursor) gaps.push({ start: cursor, end: Math.min(range.start, sceneEnd()) }); cursor = Math.max(cursor, range.end); }
    if (cursor < sceneEnd()) gaps.push({ start: cursor, end: sceneEnd() });
    const playhead = Math.max(0, scene()?.get(Computed)?.localTimeInSeconds ?? 0);
    const gap = gaps.find(gap => playhead >= gap.start && playhead < gap.end) ?? gaps.find(gap => gap.start >= playhead) ?? gaps[0];
    if (!gap) { setError('The scene already has corrections throughout. Adjust or remove a range to add another.'); return; }
    const start = playhead >= gap.start && playhead < gap.end ? playhead : gap.start;
    setCorrections(rows => [...rows, { id: ++correctionId, start: String(Math.round(start * 1000) / 1000), end: String(Math.round(Math.min(gap.end, start + 5) * 1000) / 1000), preference: 'wide' }]);
    setError('');
  };
  const agentRunning = () => (chatState.lists[project.id()] ?? []).some((chat) => chat.status === 'running' || chat.status === 'waiting');
  onCleanup(() => controller?.abort());

  const show = () => {
    const active = getActiveEntity(world);
    if (active !== scene()) { setPreference('auto'); setCorrections([]); }
    setScene(active ?? undefined);
    setSceneEnd(Math.max(0, active?.get(Computed)?.end ?? 0) / (world.get(FrameRate)?.value || 30));
    setSceneName(active?.get(Name)?.value || 'Selected scene');
    setError(active ? '' : 'Select a scene on the canvas before creating other formats.');
    setResult(undefined); setProgress(''); setOpen(true);
  };
  const toggle = (format: ReframeFormat) => setFormats((values) => values.includes(format) ? values.filter((value) => value !== format) : [...values, format]);
  const create = async () => {
    const source = scene();
    if (!source || busy() || agentRunning() || !formats().length || result()) return;
    const invalid = correctionError(); if (invalid) { setError(invalid); return; }
    const dir = project.dir();
    controller = new AbortController();
    const signal = controller.signal;
    setBusy(true); setError(''); setProgress('Preparing scene…');
    try {
      const output = await createReframeVariants(world, dir, source, {
        formats: [...formats()], mode: mode(), ...(mode() === 'speakers' ? { speakerFraming: speakerFraming() } : {}), signal,
        assertCurrent: () => {
          signal.throwIfAborted();
          if (project.dir() !== dir) throw new Error('The project changed. Open the intended project and try again.');
          if (agentRunning()) throw new Error('Wait for the agent to finish before reframing.');
        },
        onProgress: (event) => setProgress(event.phase === 'creating' ? 'Creating editable scenes…' : `Analyzing clip ${Math.min(event.total, Math.floor(event.completed) + 1)} of ${event.total} · ${Math.round(100 * event.completed / Math.max(1, event.total))}%`),
      });
      setResult(output); setProgress('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); controller = undefined; }
  };
  const review = (id: string) => {
    const target = world.query(Source).find((entity) => entity.get(Source)?.value === id);
    if (!target) { setError('This scene changed. Close this dialog and select it on the canvas.'); return; }
    const editor = getDocumentEditor(world);
    editor.activate(target); editor.select(target);
    const props = authoredElement(target)?.props;
    if (props && typeof props.width === 'number' && typeof props.height === 'number') {
      focusRect(world, { x: typeof props.x === 'number' ? props.x : 0, y: typeof props.y === 'number' ? props.y : 0, width: props.width, height: props.height });
    }
    setOpen(false);
  };

  props.triggerRef?.(show);
  return <>
    <Show when={!props.triggerRef}><button type="button" class="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={show}>Reframe</button></Show>
    <Dialog open={open()} onOpenChange={(value) => { if (!busy()) setOpen(value); }}>
      <DialogPortal><DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" showCloseButton={!busy()} onCloseAutoFocus={props.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{result() ? 'Your new formats are ready' : 'Frame your edit'}</DialogTitle>
          <DialogDescription>{sceneName()} · editable scenes with the same timing and audio.</DialogDescription>
        </DialogHeader>
        <Show when={!result()}>
          <div class="grid grid-cols-3 gap-3">
            <For each={REFRAME_FORMATS}>{(format) => <label class={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border px-2 py-4 text-center ${formats().includes(format.id) ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-border'}`}>
              <input type="checkbox" aria-label={format.label} checked={formats().includes(format.id)} onChange={() => toggle(format.id)} disabled={busy()} class="accent-emerald-500" />
              <span class="flex h-14 items-center justify-center" aria-hidden="true"><span class="block rounded border-2 border-current text-muted-foreground" style={{ width: `${48 * Math.min(1, format.width / format.height)}px`, height: `${48 * Math.min(1, format.height / format.width)}px` }} /></span>
              <strong class="text-sm">{format.label}</strong><span class="text-xs text-muted-foreground">{format.width} × {format.height}</span>
            </label>}</For>
          </div>
          <fieldset class="space-y-3 rounded-lg border p-4" disabled={busy()}>
            <legend class="px-1 text-xs text-muted-foreground">Framing</legend>
            <label class="flex items-start gap-3 text-sm"><input type="radio" name="reframe-mode" value="speakers" checked={mode() === 'speakers'} onChange={() => setMode('speakers')} class="mt-1 accent-emerald-500" /><span>Follow the speaker<span class="mt-1 block text-xs text-muted-foreground">Match speech with the visible person speaking. Hold briefly or show the full picture when uncertain.</span></span></label>
            <label class="flex items-start gap-3 text-sm"><input type="radio" name="reframe-mode" value="follow" checked={mode() === 'follow'} onChange={() => setMode('follow')} class="mt-1 accent-emerald-500" /><span>Follow faces<span class="mt-1 block text-xs text-muted-foreground">Analyze on your Mac and add adjustable crop movements. Center the picture where no face is found.</span></span></label>
            <label class="flex items-start gap-3 text-sm"><input type="radio" name="reframe-mode" value="center" checked={mode() === 'center'} onChange={() => setMode('center')} class="mt-1 accent-emerald-500" /><span>Center crop<span class="mt-1 block text-xs text-muted-foreground">Keep a steady crop throughout each clip.</span></span></label>
          </fieldset>
          <Show when={mode() === 'speakers'}>
            <fieldset class="space-y-3 rounded-lg border p-4" disabled={busy()}>
              <legend class="px-1 text-xs text-muted-foreground">Speaker framing</legend>
              <label class="block text-sm">Default framing
                <select aria-label="Default speaker framing" value={preference()} onChange={event => setPreference(event.currentTarget.value as SpeakerFramingPreference)} class="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm">
                  <For each={FRAMING_CHOICES}>{choice => <option value={choice.value}>{choice.label}</option>}</For>
                </select>
              </label>
              <p class="text-xs leading-relaxed text-muted-foreground">{preference() === 'auto' ? 'Follow sustained speaker evidence and keep a wider view when it is unclear.' : preference() === 'wide' ? 'Keep the complete picture visible. Narrow formats can have empty space above and below.' : 'Choose the person on that side when each shot begins, then follow them if they move. If they disappear, show the complete picture.'}</p>
              <details class="rounded-md border border-dashed p-3">
                <summary class="cursor-pointer text-sm font-medium">Correct a time range{corrections().length ? ` · ${corrections().length}` : ''}</summary>
                <div class="mt-3 space-y-3">
                  <p class="text-xs leading-relaxed text-muted-foreground">Use this scene’s timeline in seconds, after trims and speed changes (0–{sceneEnd().toFixed(2)}s). Each range replaces the default. Ranges can touch, but cannot overlap.</p>
                  <Index each={corrections()}>{(row, index) => <div class="space-y-2 rounded-md bg-muted/40 p-3">
                    <div class="flex items-center justify-between"><span class="text-xs font-medium">Correction {index + 1}</span><button type="button" aria-label={`Remove correction ${index + 1}`} class="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={busy()} onClick={() => setCorrections(rows => rows.filter(item => item.id !== row().id))}>Remove</button></div>
                    <div class="grid grid-cols-2 gap-3">
                      <label class="text-xs">Start (seconds)<input aria-label={`Correction ${index + 1} start seconds`} type="number" min={0} max={sceneEnd()} step="0.01" value={row().start} onInput={event => updateCorrection(row().id, { start: event.currentTarget.value })} class="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm" /></label>
                      <label class="text-xs">End (seconds)<input aria-label={`Correction ${index + 1} end seconds`} type="number" min={0} max={sceneEnd()} step="0.01" value={row().end} onInput={event => updateCorrection(row().id, { end: event.currentTarget.value })} class="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm" /></label>
                    </div>
                    <select aria-label={`Correction ${index + 1} framing`} value={row().preference} onChange={event => updateCorrection(row().id, { preference: event.currentTarget.value as SpeakerFramingOverride['preference'] })} class="w-full rounded-md border bg-background px-2 py-2 text-sm">
                      <For each={FRAMING_CHOICES}>{choice => <option value={choice.value}>{choice.label}</option>}</For>
                      <option value="hold">Hold previous framing</option>
                    </select>
                    <Show when={row().preference === 'hold'}><p class="text-xs text-muted-foreground">Freeze the camera from just before this range. A new shot resets to the full picture.</p></Show>
                  </div>}</Index>
                  <Show when={correctionError()}><p role="alert" class="text-xs text-red-400">{correctionError()}</p></Show>
                  <Button variant="outline" size="small" onClick={addCorrection} disabled={busy() || corrections().length >= 100 || sceneEnd() <= 0 || !!correctionError()}>Add time range</Button>
                </div>
              </details>
            </fieldset>
          </Show>
          <p class="text-xs text-muted-foreground">Captions keep their words and timing. Analysis supports up to two hours per clip and saves completed sections, so canceling or restarting does not lose that work.</p>
        </Show>
        <Show when={agentRunning()}><p class="text-xs text-amber-400">Wait for the agent to finish before creating formats.</p></Show>
        <Show when={error()}><p role="alert" class="rounded-md border border-red-400/30 bg-red-400/5 p-3 text-sm text-red-400">{error()}</p></Show>
        <Show when={busy()}><p role="status" class="text-sm text-muted-foreground">{progress()}</p></Show>
        <Show when={result()}>{(output) => <>
          <div class="space-y-2"><For each={output().variants}>{(variant) => <div class="flex items-center gap-3 rounded-lg border p-3"><div class="min-w-0 flex-1"><p class="truncate text-sm font-medium">{variant.name}</p><p class="text-xs text-muted-foreground">{variant.width} × {variant.height}</p></div><Button variant="outline" onClick={() => review(variant.sceneId)}>Review</Button></div>}</For></div>
          <Show when={output().speakerSummary}>{(summary) => <p class="text-xs text-muted-foreground">Visible-speaker evidence in {Math.round(summary().coverage * 100)}% of analyzed footage · {summary().switches} speaker switches · {Math.round(summary().fallbackSeconds)}s of conservative framing.</p>}</Show>
          <Show when={output().speakerSummary?.manualSeconds}>{seconds => <p class="text-xs text-muted-foreground">{Math.round(seconds())}s follows your framing corrections. These choices do not increase speaker evidence coverage.</p>}</Show>
          <Show when={output().warnings.length}><div class="max-h-36 overflow-y-auto rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400"><For each={output().warnings}>{(warning) => <p class="mb-1 last:mb-0">{warning}</p>}</For></div></Show>
          <p class="text-xs text-muted-foreground">Select a video layer to adjust its position keyframes. One Undo removes these new formats together.</p>
        </>}</Show>
        <div class="flex justify-end gap-2">
          <Show when={result() && mode() === 'speakers'}><Button variant="outline" onClick={() => { setResult(undefined); setError(''); }}>Adjust framing</Button></Show>
          <Show when={busy()} fallback={<Button variant="secondary" onClick={() => setOpen(false)}>{result() ? 'Done' : 'Cancel'}</Button>}><Button variant="secondary" onClick={() => { controller?.abort(); setProgress('Canceling…'); }}>Cancel analysis</Button></Show>
          <Show when={!result()}><Button disabled={busy() || agentRunning() || !scene() || !formats().length || !!correctionError()} onClick={() => void create()}>{busy() ? 'Creating…' : `Create ${formats().length} format${formats().length === 1 ? '' : 's'}`}</Button></Show>
        </div>
      </DialogContent></DialogPortal>
    </Dialog>
  </>;
}
