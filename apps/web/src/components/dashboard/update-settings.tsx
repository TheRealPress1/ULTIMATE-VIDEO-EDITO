import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { UpdateStatus } from '@desktop/update-types';
import { Button } from '@/components/ui/button';
import { DashboardSurfaceSection } from './shared';

export function UpdateSettings() {
  const [state, setState] = createSignal<UpdateStatus>();
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [openingDownloads, setOpeningDownloads] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | undefined, alive = true;
  const busy = () => pending() || ['checking', 'downloading', 'installing'].includes(state()?.state ?? '');
  const refresh = async () => {
    try {
      const value = await mainBridge.call(MAIN_CHANNELS.UPDATES_STATUS, undefined);
      if (alive) setState(value);
    } catch {
      if (alive) setError('Update status is unavailable in this preview.');
    }
  };
  onMount(() => {
    void refresh();
    timer = setInterval(() => { if (busy()) void refresh(); }, 2000);
  });
  onCleanup(() => { alive = false; clearInterval(timer); });

  const action = async (install = false) => {
    if (busy()) return;
    setPending(true);
    setError('');
    try {
      if (install) {
        await mainBridge.call(MAIN_CHANNELS.UPDATES_INSTALL, undefined);
        await refresh();
      } else {
        const value = await mainBridge.call(MAIN_CHANNELS.UPDATES_CHECK, undefined);
        if (alive) setState(value);
      }
    } catch (error) {
      if (alive) setError(error instanceof Error ? error.message : 'The update could not complete. Try again.');
      await refresh();
    } finally { if (alive) setPending(false); }
  };
  const buttonLabel = () => {
    if (state()?.state === 'installing' || (pending() && state()?.state === 'ready')) return 'Saving and restarting…';
    if (state()?.state === 'checking') return 'Checking for updates…';
    if (state()?.state === 'downloading') return 'Downloading update…';
    return state()?.state === 'ready' ? 'Save and restart to install' : 'Check & download update';
  };
  const openPrivateDownloads = async () => {
    const url = state()?.privateDownloadUrl;
    if (!url || openingDownloads()) return;
    setOpeningDownloads(true);
    setError('');
    try { await mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url }); }
    catch { if (alive) setError('The private downloads page could not open. Try again.'); }
    finally { if (alive) setOpeningDownloads(false); }
  };

  return <DashboardSurfaceSection title="App updates"><div class="space-y-3">
    <p role="status" class="text-sm text-muted-foreground">{state()?.message ?? 'Reading release status…'}</p>
    <Show when={state()}>{current => <p class="text-xs text-muted-foreground">Installed version {current().currentVersion}</p>}</Show>
    <Show when={state() && state()?.state !== 'unavailable'}>
      <Button variant="outline" disabled={busy()} onClick={() => void action(state()?.state === 'ready')}>{buttonLabel()}</Button>
    </Show>
    <Show when={state()?.privateDownloadUrl}>
      <p class="text-sm text-muted-foreground">Download updates from your private GitHub releases. Sign in with your GitHub account.</p>
      <Button variant="outline" disabled={openingDownloads() || busy()} onClick={() => void openPrivateDownloads()}>Open private downloads</Button>
    </Show>
    <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
  </div></DashboardSurfaceSection>;
}
