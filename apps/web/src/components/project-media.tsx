/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { For, Show, createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { CollectProjectResult, RelinkProjectMediaResult } from '@desktop/project-portability';
import { mainBridge } from '@/lib/ipc';
import { useProject } from '@/context/project';
import { flushProjectEdits } from '@/projects/edits';
import { openProjectFolder, projectKey } from '@/projects/host';
import { chatState } from '@/agent-chat/store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { projectRoute } from '@/hooks/use-project-route';

export function ProjectMedia() {
  const project = useProject();
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [collected, setCollected] = createSignal<CollectProjectResult>();
  const [relink, setRelink] = createSignal<RelinkProjectMediaResult>();
  const [folder, setFolder] = createSignal('');
  const agentRunning = () => (chatState.lists[project.id()] ?? []).some((chat) => chat.status === 'running' || chat.status === 'waiting');
  const run = async (label: string, action: () => Promise<void>) => {
    if (busy() || agentRunning()) return;
    setBusy(label); setError('');
    try { await flushProjectEdits(project.dir()); await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };
  const collect = () => void run('Collecting project…', async () => {
    const target = await mainBridge.call(MAIN_CHANNELS.PROJECTS_COLLECT_PICK, { dir: project.dir() });
    if (!target) return;
    setCollected(await mainBridge.call(MAIN_CHANNELS.PROJECTS_COLLECT, { dir: project.dir(), target }));
  });
  const scan = () => void run('Finding missing media…', async () => {
    const searchDir = await mainBridge.call(MAIN_CHANNELS.PROJECTS_PICK_FOLDER, undefined);
    if (!searchDir) return;
    setRelink(undefined);
    setFolder(searchDir);
    setRelink(await mainBridge.call(MAIN_CHANNELS.PROJECTS_RELINK, { dir: project.dir(), searchDir }));
  });
  const apply = () => void run('Relinking media…', async () => {
    const preview = relink();
    if (!preview || preview.applied) return;
    try {
      setRelink(await mainBridge.call(MAIN_CHANNELS.PROJECTS_RELINK, {
        dir: project.dir(), searchDir: folder(), apply: true, expectedPreview: preview.previewToken,
      }));
    } catch (error) {
      setRelink(undefined);
      throw error;
    }
  });
  const openCopy = () => void run('Opening collected project…', async () => {
    const result = collected(); if (!result) return;
    const copy = await openProjectFolder(result.dir);
    setOpen(false); navigate(projectRoute(projectKey(copy)));
  });
  return <>
    <button class="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(true)}>Media</button>
    <Dialog open={open()} onOpenChange={(value) => { if (!busy()) setOpen(value); }}><DialogPortal><DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" showCloseButton={!busy()}>
      <DialogHeader><DialogTitle>Project media</DialogTitle><DialogDescription>Keep your footage together and reconnect files that have moved.</DialogDescription></DialogHeader>
      <section class="space-y-3 rounded-lg border p-4">
        <div><h3 class="text-sm font-medium">Collect project</h3><p class="mt-1 text-xs text-muted-foreground">Create a new copy with all linked media in its folder. The copy starts with fresh version history and leaves this project untouched.</p></div>
        <Button variant="outline" onClick={collect} disabled={!!busy() || agentRunning()}>Choose destination &amp; collect</Button>
        <Show when={collected()}>{(result) => <div class="space-y-2 text-xs"><p class="text-emerald-400">Collected {result().assetCount} assets · {(result().bytes / 1024 / 1024).toFixed(1)} MB</p><p class="break-all text-muted-foreground">{result().dir}</p><div class="flex gap-2"><Button variant="secondary" disabled={!!busy()} onClick={() => void mainBridge.call(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, {path: result().dir}).catch((error) => setError(String(error)))}>Show in Finder</Button><Button disabled={!!busy() || agentRunning()} onClick={openCopy}>Open copy</Button></div></div>}</Show>
      </section>
      <section class="space-y-3 rounded-lg border p-4">
        <div><h3 class="text-sm font-medium">Relink missing media</h3><p class="mt-1 text-xs text-muted-foreground">Search a folder and its subfolders. Review matches before applying; ambiguous files stay unchanged.</p></div>
        <Button variant="outline" disabled={!!busy() || agentRunning()} onClick={scan}>Choose folder to search</Button>
        <Show when={relink()}>{(result) => <div class="space-y-2 text-xs">
          <p class={result().applied ? 'text-emerald-400' : ''}>{result().applied ? 'Media relinked. A version keeps the previous links.' : `${result().planned.length} matches · ${result().missing.length} not found · ${result().ambiguous.length} ambiguous`}</p>
          <div class="max-h-36 space-y-2 overflow-y-auto">
            <For each={result().planned}>{(match) => <p class="break-all"><span class="text-emerald-400">✓</span> {match.path}<span class="block pl-3 text-muted-foreground">{match.source}</span></p>}</For>
            <For each={result().missing}>{(missing) => <p class="break-all text-amber-400">Not found: {missing.path}{missing.reason ? ` — ${missing.reason}` : ''}</p>}</For>
            <For each={result().ambiguous}>{(ambiguous) => <p class="break-all text-amber-400">Multiple matches: {ambiguous.path}. Choose a more specific folder.</p>}</For>
          </div>
          <Show when={!result().applied && result().planned.length}><Button onClick={apply} disabled={!!busy() || agentRunning()}>Relink {result().planned.length} matched files</Button></Show>
        </div>}</Show>
      </section>
      <Show when={agentRunning()}><p class="text-xs text-muted-foreground">Wait for the agent to finish before collecting or relinking media.</p></Show>
      <Show when={busy()}><p role="status" class="text-sm text-muted-foreground">{busy()}</p></Show>
      <Show when={error()}><p role="alert" class="break-words rounded-md border border-red-400/30 p-3 text-sm text-red-400">{error()}</p></Show>
    </DialogContent></DialogPortal></Dialog>
  </>;
}
