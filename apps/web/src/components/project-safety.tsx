/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { For, Show, createSignal, onCleanup } from 'solid-js';
import { toast } from 'somoto';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { ProjectVersion, ProjectVersionInspection } from '@desktop/project-versions';
import { mainBridge } from '@/lib/ipc';
import { useProject } from '@/context/project';
import { useEngineContext } from '@/engine';
import { captureVersionPreview } from '@/projects/version-preview';
import { flushProjectEdits, projectSaveState, retryProjectEdits } from '@/projects/edits';
import { isDesktop } from '@/projects/host';
import { chatState } from '@/agent-chat/store';
import { ProjectMedia } from './project-media';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from '@/components/ui/dialog';

export function ProjectSafety() {
  const project = useProject();
  const engine = useEngineContext();
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [versions, setVersions] = createSignal<ProjectVersion[]>([]);
  const [fingerprint, setFingerprint] = createSignal('');
  const [label, setLabel] = createSignal('');
  const [error, setError] = createSignal('');
  const [restore, setRestore] = createSignal<ProjectVersion>();
  const [inspection, setInspection] = createSignal<ProjectVersionInspection>();
  const [currentPreview, setCurrentPreview] = createSignal<string>();
  const [layerRestore, setLayerRestore] = createSignal<ProjectVersionInspection['layers'][number]>();
  const [notice, setNotice] = createSignal('');
  let alive = true;
  onCleanup(() => { alive = false; });
  const assertCurrent = (dir: string) => {
    if (!alive || project.dir() !== dir) throw new Error('The project changed. Open Versions again.');
  };
  const state = () => projectSaveState(project.dir());
  const agentRunning = () => (chatState.lists[project.id()] ?? []).some((chat) => chat.status === 'running' || chat.status === 'waiting');
  const refresh = async () => {
    const dir = project.dir();
    const result = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSIONS, { dir });
    assertCurrent(dir);
    setVersions(result.versions); setFingerprint(result.fingerprint);
  };
  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (error) {
      if (!alive) return;
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      if (!open()) toast.error('Project action failed', { description: message });
    }
    finally { if (alive) setBusy(false); }
  };
  const showVersions = () => {
    setOpen(true); setRestore(undefined); setInspection(undefined); setCurrentPreview(undefined); setLayerRestore(undefined);
    void run(async () => { await flushProjectEdits(project.dir()); await refresh(); });
  };
  const retry = () => void run(async () => {
    await retryProjectEdits(project.dir());
    await mainBridge.call(MAIN_CHANNELS.PROJECTS_RELOAD, { dir: project.dir() });
    if (open()) await refresh();
    toast.success('Project saved');
  });
  const create = () => void run(async () => {
    if (agentRunning()) throw new Error('Wait for the agent to finish before saving a version.');
    const dir = project.dir();
    await flushProjectEdits(dir);
    assertCurrent(dir);
    await refresh();
    const expectedFingerprint = fingerprint();
    let preview: string | undefined;
    try { preview = await captureVersionPreview(engine, dir); }
    catch { /* Preserve the version even when a canvas image is unavailable. */ }
    await flushProjectEdits(dir);
    assertCurrent(dir);
    if (agentRunning()) throw new Error('The agent started while preparing the preview. Save a version again after it finishes.');
    const version = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSION_CREATE, { dir, label: label().trim() || undefined, preview, expectedFingerprint });
    assertCurrent(dir);
    setLabel(''); await refresh();
    const details = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSION_INSPECT, { dir, id: version.id });
    assertCurrent(dir); setInspection(details);
    setCurrentPreview(preview); setLayerRestore(undefined); setRestore(undefined);
    setNotice(preview ? 'Version saved with a preview.' : 'Version saved. A preview was unavailable.');
    toast.success('Version saved');
  });
  const inspect = (version: ProjectVersion) => void run(async () => {
    const dir = project.dir();
    setRestore(undefined); setLayerRestore(undefined); setInspection(undefined); setCurrentPreview(undefined);
    await flushProjectEdits(dir);
    assertCurrent(dir);
    const details = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSION_INSPECT, { dir, id: version.id });
    assertCurrent(dir);
    let preview: string | undefined;
    try { preview = await captureVersionPreview(engine, dir); }
    catch { /* The layer comparison remains available without an image. */ }
    await flushProjectEdits(dir);
    assertCurrent(dir);
    const current = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSIONS, { dir });
    assertCurrent(dir);
    if (current.fingerprint !== details.fingerprint) throw new Error('The project changed while preparing the comparison. Compare this version again.');
    setInspection(details); setFingerprint(details.fingerprint); setCurrentPreview(preview);
  });
  const restoreLayer = () => void run(async () => {
    const layer = layerRestore(); const details = inspection();
    if (!layer || !details || agentRunning()) return;
    const dir = project.dir();
    await flushProjectEdits(dir);
    assertCurrent(dir);
    if (agentRunning()) throw new Error('Wait for the agent to finish, then compare the version again.');
    await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSION_RESTORE_LAYER, { dir, id: details.version.id, file: layer.file, layerId: layer.id, expectedFingerprint: details.fingerprint });
    assertCurrent(dir);
    setLayerRestore(undefined); setInspection(undefined); setCurrentPreview(undefined); await refresh();
    setNotice('Layer restored. Your previous edit is saved in a recovery checkpoint.');
    toast.success('Layer restored');
  });
  const restoreVersion = () => void run(async () => {
    const selected = restore();
    if (!selected || agentRunning()) return;
    const dir = project.dir();
    await flushProjectEdits(dir);
    assertCurrent(dir);
    if (agentRunning()) throw new Error('Wait for the agent to finish, then compare the version again.');
    await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSION_RESTORE, { dir, id: selected.id, expectedFingerprint: fingerprint() });
    assertCurrent(dir);
    setRestore(undefined); setInspection(undefined); setCurrentPreview(undefined); setLayerRestore(undefined); await refresh();
    toast.success('Version restored', { description: 'Your previous edits are saved as a recovery checkpoint.' });
  });
  return <Show when={isDesktop() && project.dir()}>
    <div class="flex shrink-0 items-center gap-2 text-xs">
      <span class={state().status === 'error' ? 'text-red-400' : 'text-muted-foreground'} title={state().error ?? (state().savedAt ? `Saved ${new Date(state().savedAt!).toLocaleTimeString()}` : 'Edits save automatically')} aria-live="polite">
        <span class={`mr-1.5 inline-block size-1.5 rounded-full ${state().status === 'error' ? 'bg-red-400' : state().status === 'saving' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
        {state().status === 'error' ? 'Save failed' : state().status === 'saving' ? 'Saving…' : 'Saved'}
      </span>
      <Show when={state().status === 'error'}><button class="text-red-400 underline" disabled={busy()} onClick={retry}>Retry</button></Show>
      <button class="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={showVersions}>Versions</button>
      <ProjectMedia />
    </div>
    <Dialog open={open()} onOpenChange={(value) => { if (!busy()) setOpen(value); }}>
      <DialogPortal><DialogContent class={`max-h-[calc(100dvh-2rem)] overflow-y-auto ${inspection() ? 'sm:max-w-3xl' : 'sm:max-w-xl'}`} showCloseButton={!busy()}>
        <DialogHeader>
          <DialogTitle>Project versions</DialogTitle>
          <DialogDescription>Compare earlier edits, recover a layer, or return to a saved version.</DialogDescription>
        </DialogHeader>
        <div class="flex gap-2">
          <input class="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm" aria-label="Version name" placeholder="Name this version (optional)" maxlength={120} value={label()} onInput={(event) => setLabel(event.currentTarget.value)} disabled={busy()} />
          <Button onClick={create} disabled={busy() || agentRunning()}>Save version</Button>
        </div>
        <Show when={agentRunning()}><p class="text-xs text-muted-foreground">Wait for the agent to finish before saving or restoring a version.</p></Show>
        <Show when={notice()}><p role="status" class="text-sm text-emerald-400">{notice()}</p></Show>
        <Show when={error()}><div role="alert" class="break-words rounded-md border border-red-400/30 bg-red-400/5 p-3 text-sm text-red-400">{error()}<div class="mt-2 flex gap-3"><button class="underline" onClick={() => void run(async () => { setRestore(undefined); setLayerRestore(undefined); setInspection(undefined); await refresh(); })} disabled={busy()}>Refresh versions</button><Show when={state().status === 'error'}><button class="underline" disabled={busy()} onClick={retry}>Retry save</button></Show></div></div></Show>
        <Show when={restore()}>{(selected) => <div class="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm">
          <p class="break-words">Restore <strong>{selected().label}</strong>?</p>
          <p class="mt-1 text-xs text-muted-foreground">Composition, captions, asset links and settings return to this version. Original footage stays in place. A checkpoint keeps the current edit recoverable.</p>
          <div class="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => setRestore(undefined)} disabled={busy()}>Cancel</Button><Button onClick={restoreVersion} disabled={busy() || agentRunning()}>{busy() ? 'Restoring…' : 'Restore version'}</Button></div>
        </div>}</Show>
        <div class={`${inspection() ? 'max-h-40' : 'max-h-72'} overflow-y-auto rounded-md border`} aria-busy={busy()}>
          <Show when={versions().length} fallback={<p class="p-6 text-center text-sm text-muted-foreground">{busy() ? 'Loading versions…' : 'Save a version to keep this point in your edit.'}</p>}>
            <For each={versions()}>{(version) => <div class="flex items-center gap-3 border-b px-3 py-3 last:border-b-0">
              <span class={`size-2 shrink-0 rounded-full ${version.kind === 'manual' ? 'bg-emerald-400' : version.kind === 'before-restore' ? 'bg-amber-400' : 'bg-muted-foreground/50'}`} />
              <div class="min-w-0 flex-1"><p class="truncate text-sm font-medium">{version.label}</p><p class="mt-1 text-xs text-muted-foreground">{new Date(version.createdAt).toLocaleString()} · {version.kind === 'before-restore' ? 'Recovery checkpoint' : version.kind === 'manual' ? 'Named version' : 'Automatic'}</p><Show when={version.externalTranscripts}><p class="text-xs text-amber-400">{version.externalTranscripts} external caption file(s) remain linked.</p></Show></div>
              <Button variant="outline" onClick={() => inspect(version)} disabled={busy()}>Compare</Button>
              <Button variant="outline" onClick={() => { setLayerRestore(undefined); setRestore(version); }} disabled={busy() || agentRunning() || version.fingerprint === fingerprint()}>{version.fingerprint === fingerprint() ? 'Current' : 'Restore'}</Button>
            </div>}</For>
          </Show>
        </div>
        <Show when={inspection()}>{(details) => <section class="min-w-0 space-y-3" aria-label="Version comparison">
          <h3 class="truncate text-sm font-semibold">Comparing: {details().version.label}</h3>
          <div class="grid grid-cols-2 gap-3">
            <div><p class="mb-1 text-xs text-muted-foreground">Saved preview</p><Show when={details().preview} fallback={<div class="flex aspect-video items-center rounded-md border bg-muted/20 p-3 text-center text-xs text-muted-foreground">No image was saved with this checkpoint. Its layers are listed below.</div>}>{(src) => <img src={src()} alt="Preview when this version was saved" class="aspect-video w-full rounded-md border bg-black object-contain" />}</Show></div>
            <div><p class="mb-1 text-xs text-muted-foreground">Current preview</p><Show when={currentPreview()} fallback={<div class="flex aspect-video items-center justify-center rounded-md border bg-muted/20 text-xs text-muted-foreground">Preview unavailable</div>}>{(src) => <img src={src()} alt="Current project preview" class="aspect-video w-full rounded-md border bg-black object-contain" />}</Show></div>
          </div>
          <p class="text-xs text-muted-foreground">Previews show the active scene or canvas at capture time; their view and playback position may differ. Recover a layer without reverting other edits.</p>
          <Show when={details().truncated}><p class="text-xs text-amber-400">Some comparison details are shortened. The saved version retains the complete edit.</p></Show>
          <Show when={layerRestore()}>{(layer) => <div class="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm">
            <p>Restore <strong>{layer().name || layer().tag}</strong> from this version?</p>
            <p class="mt-1 text-xs text-muted-foreground">This layer and its recoverable dependencies return to the saved version. Other edits stay in place. A recovery checkpoint keeps the current edit recoverable.</p>
            <div class="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => setLayerRestore(undefined)} disabled={busy()}>Cancel</Button><Button onClick={restoreLayer} disabled={busy() || agentRunning()}>{busy() ? 'Restoring…' : 'Restore this layer'}</Button></div>
          </div>}</Show>
          <div class="max-h-56 overflow-y-auto rounded-md border">
            <Show when={details().layers.length} fallback={<p class="p-4 text-xs text-muted-foreground">No individually recoverable layers were found. You can restore the entire version.</p>}>
              <For each={details().layers}>{(layer) => <div class="flex items-start gap-3 border-b p-3 last:border-b-0">
                <div class="min-w-0 flex-1"><p class="truncate text-sm font-medium">{layer.name || layer.tag}</p><p class={`mt-1 text-xs ${layer.status === 'missing' ? 'text-amber-400' : 'text-muted-foreground'}`}>{layer.status === 'missing' ? 'Removed from current edit' : layer.status === 'changed' ? 'Changed since this version' : 'Unchanged'} · {layer.tag}</p><Show when={layer.reason}><p class="mt-1 text-xs text-muted-foreground">{layer.reason}</p></Show></div>
                <Button variant="outline" disabled={busy() || agentRunning() || !layer.canRestore || layer.status === 'unchanged'} onClick={() => { setRestore(undefined); setLayerRestore(layer); }}>Restore layer</Button>
              </div>}</For>
            </Show>
          </div>
          <details class="text-xs text-muted-foreground"><summary class="cursor-pointer">{details().files.filter((file) => file.status !== 'unchanged').length} changed project files</summary><div class="mt-2 space-y-1"><For each={details().files.filter((file) => file.status !== 'unchanged')}>{(file) => <p class="break-all">{file.path} · {file.status}</p>}</For></div></details>
        </section>}</Show>
        <p class="text-xs text-muted-foreground">Keeps up to 50 versions within 100 MB in your project folder. Automatic checkpoints are spaced at least 30 seconds apart. Keep a separate backup of your footage.</p>
      </DialogContent></DialogPortal>
    </Dialog>
  </Show>;
}
