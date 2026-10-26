import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { useProject } from '@/context/project';
import { useLibrary } from '@/engine/library';
import { getPlaybackProxyService, type PlaybackProxySnapshot } from '@/engine/playback-proxy';

/** Quiet background preparation; the editor remains usable throughout. */
export function PlaybackProxyStatus(props: { paused?: boolean }) {
  const world = useWorld();
  const project = useProject();
  const library = useLibrary();
  const service = createMemo(() => project.dir() && library() ? getPlaybackProxyService(world, project.dir()) : undefined);
  const [state, setState] = createSignal<PlaybackProxySnapshot>({ enabled: true, paused: false, items: [] });
  createEffect(() => {
    const current = service();
    if (!current) return;
    setState(current.snapshot());
    const unsubscribe = current.subscribe(() => setState(current.snapshot()));
    const timer = setInterval(() => { void current.verifySources(); }, 15_000);
    onCleanup(() => { clearInterval(timer); unsubscribe(); current.dispose(); });
  });
  createEffect(() => { service()?.setPaused(!!props.paused); });
  createEffect(() => {
    const current = service();
    library()?.list();
    if (current) void untrack(() => current.refresh());
  });
  const pending = () => state().items.some((item) => item.status === 'preparing' || item.status === 'queued');
  const failed = () => state().items.some((item) => item.status === 'error');
  const ready = () => state().items.filter((item) => item.status === 'ready').length;
  const label = () => !state().enabled ? 'Original playback' : pending()
    ? state().paused ? 'Lighter playback paused for export' : 'Preparing lighter playback'
    : ready() ? `Lighter playback ready${ready() > 1 ? ` · ${ready()} videos` : ''}` : 'Using original playback';
  const detail = () => state().items.find((item) => item.status === 'preparing')?.path ?? state().items.find((item) => item.error)?.error;
  return <Show when={state().items.length}>
    <div class="flex min-w-0 items-center gap-2 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm" title={detail()} aria-live="polite">
      <span class="size-1.5 shrink-0 rounded-full" classList={{ 'bg-emerald-500': state().enabled && !!ready(), 'bg-amber-400 animate-pulse': state().enabled && pending() && !state().paused, 'bg-neutral-500': !state().enabled || (!ready() && !pending()) }} />
      <span class="truncate">{label()}</span>
      <button type="button" class="shrink-0 hover:text-foreground underline underline-offset-2" onClick={() => service()?.setEnabled(!state().enabled)}>
        {state().enabled ? 'Use originals' : 'Use lighter playback'}
      </button>
      <Show when={state().enabled && failed() && !pending()}><button type="button" class="hover:text-foreground" onClick={() => service()?.retry()}>Retry</button></Show>
    </div>
  </Show>;
}
