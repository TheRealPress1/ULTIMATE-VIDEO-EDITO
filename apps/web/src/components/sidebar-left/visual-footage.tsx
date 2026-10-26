import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { SidebarTabs, sidebarTab } from '@/agent-chat';
import { useProject } from '@/context/project';
import { useLibrary } from '@/engine/library';
import { getVisualService, type VisualMatch, type VisualSnapshot } from '@/engine/visual-footage';
import type { SemanticSnapshot } from '@/engine/semantic-footage';
import { CLIP_BYTES } from '@/lib/semantic/model';
import { Button } from '../ui/button';

const empty = (): VisualSnapshot => ({ items: [], loading: false, indexing: false });
const filename = (path: string) => path.split(/[\\/]/).pop() || path;
const timecode = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function VisualFootage() {
  const world = useWorld();
  const project = useProject();
  const library = useLibrary();
  const service = createMemo(() => project.dir() ? getVisualService(world, project.dir()) : undefined);
  const [state, setState] = createSignal<VisualSnapshot>(empty());
  const [query, setQuery] = createSignal('');
  const [mode, setMode] = createSignal<'keywords' | 'description'>('keywords');
  const [semantic, setSemantic] = createSignal<SemanticSnapshot>({ available: false, busy: false, indexedFrames: 0 });
  const [descriptionMatches, setDescriptionMatches] = createSignal<VisualMatch[]>([]);
  const [filter, setFilter] = createSignal('');
  const [error, setError] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const [preview, setPreview] = createSignal<{ match: VisualMatch; url: string }>();
  const [previewLoading, setPreviewLoading] = createSignal(false);
  let video: HTMLVideoElement | undefined;
  let generation = 0;
  let loadedSignature = '';
  let loadingSignature = '';
  const [loadFinished, setLoadFinished] = createSignal(0);
  const clearPreview = () => {
    generation++;
    video?.pause();
    const current = untrack(preview);
    if (current) URL.revokeObjectURL(current.url);
    setPreview(undefined);
    setPreviewLoading(false);
  };
  createEffect(() => {
    const current = service();
    clearPreview();
    setQuery(''); setFilter(''); setError(undefined); setNotice(undefined);
    loadedSignature = ''; loadingSignature = '';
    setState(current?.snapshot() ?? empty());
    setDescriptionMatches([]);
    setSemantic(current?.descriptions.snapshot() ?? { available: false, busy: false, indexedFrames: 0 });
    if (current) {
      onCleanup(current.subscribe(() => setState(current.snapshot())));
      onCleanup(current.descriptions.subscribe(() => setSemantic(current.descriptions.snapshot())));
      void current.descriptions.status().catch((cause) => { if (current === service()) setError(message(cause)); });
    }
  });
  const signature = createMemo(() => JSON.stringify((library()?.list() ?? []).filter((asset) => asset.type === 'VIDEO')
    .map((asset) => [asset.id, asset.path, asset.source, asset.stat?.size, asset.stat?.mtime])));
  createEffect(() => {
    const current = service();
    const next = `${project.dir()}:${signature()}`;
    loadFinished();
    if (!current || !library() || state().indexing || next === loadedSignature || loadingSignature) return;
    loadingSignature = next;
    loadedSignature = next;
    void untrack(() => current.load()).catch((cause) => { if (current === service()) setError(message(cause)); })
      .finally(() => { loadingSignature = ''; setLoadFinished((value) => value + 1); });
  });
  createEffect(() => { if (sidebarTab() !== 'footage') video?.pause(); });
  createEffect(() => {
    const items = state().items;
    const current = untrack(preview);
    if (current && !items.some((item) => item.assetId === current.match.assetId && item.status === 'ready' && item.fingerprint === current.match.fingerprint)) clearPreview();
  });
  onCleanup(clearPreview);
  const matches = createMemo(() => {
    state();
    if (mode() === 'description') return descriptionMatches().filter((match) => (!filter() || match.assetId === filter()) && state().items.some((item) => item.assetId === match.assetId && item.status === 'ready' && item.fingerprint === match.fingerprint));
    return (service()?.search(query()) ?? []).filter((match) => !filter() || match.assetId === filter());
  });
  createEffect(() => { query(); filter(); mode(); setDescriptionMatches([]); });
  const busy = () => state().loading || state().indexing || semantic().busy;
  const runDescription = async (action: 'download' | 'index' | 'search') => {
    const current = service();
    if (!current || busy()) return;
    const searched = query(); const source = filter();
    setError(undefined); setNotice(undefined);
    try {
      if (action === 'download') await current.descriptions.download();
      else if (action === 'index') await current.descriptions.index(source ? [source] : undefined);
      else {
        const result = await current.descriptions.search(searched, source || undefined);
        if (service() !== current || query() !== searched || filter() !== source || mode() !== 'description') return;
        setDescriptionMatches(result.matches);
        if (result.unindexed.length) setNotice(`${result.unindexed.length} video(s) need description indexing or refreshed visual evidence.`);
      }
    } catch (cause) { if (service() === current) setError(message(cause)); }
  };
  const run = async (index: boolean) => {
    const current = service();
    if (!current || busy()) return;
    setError(undefined); setNotice(undefined);
    try { if (index) await current.indexPaths(filter() ? [filter()] : undefined); else await current.load(); }
    catch (cause) { if (service() === current) setError(message(cause)); }
  };
  const showPreview = async (match: VisualMatch) => {
    clearPreview(); setError(undefined);
    const request = generation;
    const current = service();
    if (!current) return;
    setPreviewLoading(true);
    try {
      const asset = await current.validateMatch(match);
      const file = await asset.handle.getFile();
      if (request !== generation || current !== service()) return;
      setPreview({ match, url: URL.createObjectURL(file) });
    } catch (cause) { if (request === generation && current === service()) setError(message(cause)); }
    finally { if (request === generation) setPreviewLoading(false); }
  };
  const copyRange = async (match: VisualMatch) => {
    const current = service();
    if (!current) return;
    try {
      await current.validateMatch(match);
      if (current !== service()) return;
      await navigator.clipboard.writeText(JSON.stringify({ path: match.path, assetId: match.assetId, fingerprint: match.fingerprint,
        sourceIn: match.sourceIn, sourceOut: match.sourceOut, observedAt: match.time }, null, 2));
      setNotice('B-roll source range copied. Ask the agent to audition or insert it in your cut.');
    } catch (cause) { if (current === service()) setError(message(cause)); }
  };
  return <section aria-label="Visual footage search" class="flex flex-1 min-h-0 flex-col text-xs">
    <div class="h-12 shrink-0 flex items-center px-4 border-y border-border"><SidebarTabs /></div>
    <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div><h2 class="font-450 text-sm">Find visual B-roll</h2>
        <p class="text-muted-foreground leading-relaxed mt-1">Search objects, activities and visible text in sampled frames. Local to this Mac; your originals stay intact.</p></div>
      <div class="flex flex-wrap gap-2">
        <Button disabled={busy() || !state().items.length} onClick={() => void run(true)}>{state().indexing ? 'Indexing visuals…' : 'Index visuals'}</Button>
        <Show when={state().indexing} fallback={<Button variant="outline" disabled={busy()} onClick={() => void run(false)}>Refresh</Button>}>
          <Button variant="outline" onClick={() => service()?.cancel()}>Cancel</Button>
        </Show>
      </div>
      <Show when={state().indexing && state().progress}>{(progress) => <div role="status" class="space-y-1">
        <progress class="w-full accent-primary" value={progress().frames?.completed ?? progress().completed} max={Math.max(1, progress().frames?.total ?? progress().total)} aria-label="Visual indexing progress" />
        <p class="text-muted-foreground break-words">{progress().completed}/{progress().total} videos · {filename(progress().path)}{progress().frames ? ` · ${progress().frames!.completed}/${progress().frames!.total} frames` : ''}</p>
      </div>}</Show>
      <Show when={!state().loading && !state().items.length}><p class="text-muted-foreground">Import local videos in Assets to begin.</p></Show>
      <details><summary class="cursor-pointer text-muted-foreground">Visual index · {state().items.filter((item) => item.status === 'ready').length}/{state().items.length} ready</summary>
        <ul class="space-y-2 mt-2"><For each={state().items}>{(item) => <li class="border border-border rounded p-2">
          <p class="break-words">{filename(item.path)} · {item.status}</p>
          <Show when={item.analysis}><p class="text-muted-foreground mt-1">{item.analysis!.samples.length} frames · every {item.analysis!.sampleInterval}s</p></Show>
          <Show when={item.error}><p class="text-destructive mt-1">{item.error}</p></Show>
        </li>}</For></ul>
      </details>
      <label class="block space-y-1.5"><span class="font-450">Describe the B-roll</span>
        <input type="search" maxLength={1000} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && mode() === 'description') void runDescription('search'); }} placeholder={mode() === 'description' ? 'A person speaking in a television studio…' : "Ocean, person bicycle, a sign's text…"} class="w-full h-8 rounded-md border border-border-input bg-transparent px-2 focus-ring" />
      </label>
      <select aria-label="Visual search method" value={mode()} onChange={(event) => setMode(event.currentTarget.value as 'keywords' | 'description')} class="w-full h-8 rounded border border-border-input bg-background px-2 focus-ring">
        <option value="keywords">Labels and visible text</option><option value="description">Description similarity · local CLIP</option>
      </select>
      <select aria-label="Visual source filter" value={filter()} onChange={(event) => setFilter(event.currentTarget.value)} class="w-full h-8 rounded border border-border-input bg-background px-2 focus-ring">
        <option value="">All videos</option><For each={state().items}>{(item) => <option value={item.assetId}>{filename(item.path)}</option>}</For>
      </select>
      <Show when={mode() === 'description'} fallback={<p class="text-muted-foreground leading-relaxed">Matches use label and text keywords, including a small synonym list. Sampling can miss short moments. Preview each suggestion.</p>}>
        <div class="space-y-2 rounded border border-border p-2.5">
          <p class="text-muted-foreground leading-relaxed">CLIP compares your description with sampled images. It ranks similarity, not certainty, and can miss relationships or brief actions. Queries and footage stay on this Mac. English works best; very long descriptions are truncated.</p>
          <Show when={!semantic().available}><p class="text-muted-foreground leading-relaxed">One-time download: {Math.ceil(CLIP_BYTES / 1_000_000)} MB from Hugging Face. OpenAI CLIP, converted by Xenova; files are verified and cached locally. Completed files resume after cancellation.</p></Show>
          <div class="flex flex-wrap gap-2">
            <Show when={!semantic().available}><Button disabled={busy()} onClick={() => void runDescription('download')}>Download description model ({Math.ceil(CLIP_BYTES / 1_000_000)} MB)</Button></Show>
            <Button disabled={busy() || !semantic().available} variant="outline" onClick={() => void runDescription('index')}>Index descriptions</Button>
            <Button disabled={busy() || !semantic().available || !query().trim()} onClick={() => void runDescription('search')}>Find similar frames</Button>
            <Show when={semantic().busy}><Button variant="outline" onClick={() => service()?.descriptions.cancel()}>Cancel</Button></Show>
          </div>
          <Show when={semantic().progress}>{(progress) => <div role="status"><progress class="w-full accent-primary" value={progress().completed} max={Math.max(1, progress().total)} aria-label="Description processing progress" /><p class="text-muted-foreground break-words">{progress().label} · {Math.floor(progress().completed / Math.max(1, progress().total) * 100)}%</p></div>}</Show>
          <Show when={semantic().error && semantic().error !== error()}><p role="alert" class="text-destructive break-words">{semantic().error}</p></Show>
        </div>
      </Show>
      <Show when={error() || state().error}><p role="alert" class="text-destructive break-words">{error() || state().error}</p></Show>
      <Show when={notice()}><p role="status" class="text-muted-foreground">{notice()}</p></Show>
      <Show when={previewLoading()}><p role="status">Loading source preview…</p></Show>
      <Show when={preview()}>{(current) => <div class="rounded-lg border border-border overflow-hidden">
        <video ref={video} src={current().url} controls playsinline preload="metadata" class="w-full max-h-56 bg-black" aria-label="B-roll source preview"
          onLoadedMetadata={() => { if (video) video.currentTime = current().match.evidence.mediaTime; }}
          onTimeUpdate={() => { if (video && video.currentTime >= current().match.sourceOut + current().match.evidence.mediaTime - current().match.time && !video.paused) video.pause(); }}
          onError={() => setError('This source video could not be played.')} />
        <div class="p-2 space-y-2"><p>{filename(current().match.path)} · observed at {timecode(current().match.time)}</p>
          <Button size="small" variant="outline" onClick={() => { if (video) { video.currentTime = current().match.sourceIn + current().match.evidence.mediaTime - current().match.time; void video.play().catch((cause) => setError(message(cause))); } }}>Play suggested range</Button>
          <Button size="small" variant="ghost" onClick={clearPreview}>Close</Button>
        </div>
      </div>}</Show>
      <p class="text-muted-foreground" aria-live="polite">{matches().length} sampled frames{matches().length > 100 ? ' · showing the first 100' : ''}</p>
      <For each={matches().slice(0, 100)}>{(match) => <article class="rounded-lg border border-border p-2.5 space-y-2">
        <button class="w-full text-left focus-ring rounded" onClick={() => void showPreview(match)} aria-label={`Preview ${filename(match.path)} at ${timecode(match.time)}`}>
          <p class="flex justify-between gap-2"><span class="truncate">{filename(match.path)}</span><span class="shrink-0 tabular-nums">{timecode(match.time)}</span></p>
          <Show when={mode() === 'description'}><p class="text-muted-foreground mt-1">Description similarity: {match.score.toFixed(3)} · review before using</p></Show>
          <p class="text-muted-foreground mt-1 leading-relaxed">{match.evidence.labels.slice(0, 8).map((entry) => `${entry.text.replaceAll('_', ' ')} ${Math.round(entry.confidence * 100)}%`).join(' · ') || 'No confident image labels'}</p>
          <Show when={match.evidence.people}><p class="text-muted-foreground mt-1">People detected: {match.evidence.people}</p></Show>
          <Show when={match.evidence.text.length}><p class="mt-1 break-words">Visible text: {match.evidence.text.map((entry) => entry.text).join(' · ').slice(0, 280)}</p></Show>
        </button>
        <div class="flex items-center justify-between gap-2"><span class="text-muted-foreground tabular-nums">{timecode(match.sourceIn)}–{timecode(match.sourceOut)}</span>
          <Button size="small" variant="outline" onClick={() => void copyRange(match)}>Copy source range</Button></div>
      </article>}</For>
      <Show when={!matches().length && !busy()}><p class="text-muted-foreground leading-relaxed">{mode() === 'description' ? 'Index visuals, then index descriptions and find similar frames.' : state().items.some((item) => item.status === 'ready') ? 'No matching sampled frame. Try fewer words, browse the recorded labels, or inspect the source.' : 'Index visuals to browse and search these videos.'}</p></Show>
    </div>
  </section>;
}
