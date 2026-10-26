/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { useWorld } from "@diffusionstudio/koota-solid";
import { toast } from "somoto";

import { SidebarTabs, sidebarTab } from "@/agent-chat";
import { useProject } from "@/context/project";
import { getFootageService, type FootageItem, type FootageMatch, type FootageSnapshot } from "@/engine/footage";
import { useLibrary } from "@/engine/library";
import { Button } from "../ui/button";
import { VisualFootage } from './visual-footage';

const RESULT_LIMIT = 200;
const PASSAGE_LIMIT = 100;
const emptySnapshot = (): FootageSnapshot => ({ items: [], loading: false, indexing: false });

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function timecode(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const hours = Math.floor(tenths / 36_000);
  const minutes = Math.floor(tenths / 600) % 60;
  const rest = (tenths % 600) / 10;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function passageRange(passage: FootageMatch): string {
  return `${timecode(passage.sourceIn)}–${timecode(passage.sourceOut)}`;
}

const statusLabel: Record<FootageItem["status"], string> = {
  unindexed: "Not indexed",
  partial: "Paused · resume",
  ready: "Ready",
  indexing: "Indexing…",
  stale: "Changed · reindex",
  error: "Needs attention",
  "no-speech": "No speech found",
};

type SourcePreview = { passage: FootageMatch; url: string; video: boolean };

/** Search original media and assemble a new scene without seeking the working timeline. */
export function Footage() {
  const [mode, setMode] = createSignal<'speech' | 'visual'>('speech');
  return <div class="flex flex-1 min-h-0 flex-col">
    <div class="flex gap-2 p-2" role="group" aria-label="Footage search mode">
      <Button size="small" variant={mode() === 'speech' ? 'default' : 'ghost'} aria-pressed={mode() === 'speech'} onClick={() => setMode('speech')}>Spoken words</Button>
      <Button size="small" variant={mode() === 'visual' ? 'default' : 'ghost'} aria-pressed={mode() === 'visual'} onClick={() => setMode('visual')}>Visual B-roll</Button>
    </div>
    <Show when={mode() === 'visual'} fallback={<SpeechFootage />}><VisualFootage /></Show>
  </div>;
}

function SpeechFootage() {
  const world = useWorld();
  const project = useProject();
  const library = useLibrary();
  const libraryAttached = createMemo(() => !!library());
  const service = createMemo(() => project.dir() ? getFootageService(world, project.dir()) : undefined);
  // Transcript and thumbnail updates can replace the list too. Only source
  // identities/stat changes need another disk-index load.
  const sourceSignature = createMemo(() => JSON.stringify((library()?.list() ?? [])
    .filter((asset) => asset.type === "VIDEO" || asset.type === "AUDIO")
    .map((asset) => [asset.id, asset.path, asset.source, asset.stat?.size, asset.stat?.mtime])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))));
  const [snapshot, setSnapshot] = createSignal<FootageSnapshot>(emptySnapshot());
  const indexing = createMemo(() => snapshot().indexing);
  const [query, setQuery] = createSignal("");
  const [fileFilter, setFileFilter] = createSignal("");
  const [selected, setSelected] = createSignal<FootageMatch[]>([]);
  const [sceneName, setSceneName] = createSignal("");
  const [building, setBuilding] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();
  const [loadError, setLoadError] = createSignal<string>();
  const [loadCompleted, setLoadCompleted] = createSignal(0);
  const [notice, setNotice] = createSignal<string>();
  const [preview, setPreview] = createSignal<SourcePreview>();
  const [previewLoading, setPreviewLoading] = createSignal<string>();
  const [previewError, setPreviewError] = createSignal<string>();
  let previewRequest = 0;
  let mediaElement: HTMLMediaElement | undefined;
  let previewElement: HTMLDivElement | undefined;
  let loadedService: ReturnType<typeof getFootageService> | undefined;
  let loadedSignature: string | undefined;
  let loadingService: ReturnType<typeof getFootageService> | undefined;

  const clearPreview = () => {
    previewRequest++;
    mediaElement?.pause();
    const current = untrack(preview);
    if (current) URL.revokeObjectURL(current.url);
    setPreview(undefined);
    setPreviewLoading(undefined);
    setPreviewError(undefined);
  };

  createEffect(() => {
    const current = service();
    setSelected([]);
    setQuery("");
    setFileFilter("");
    setActionError(undefined);
    setLoadError(undefined);
    setNotice(undefined);
    clearPreview();
    if (!current) {
      setSnapshot(emptySnapshot());
      return;
    }
    setSnapshot(current.snapshot());
    const unsubscribe = current.subscribe(() => setSnapshot(current.snapshot()));
    onCleanup(unsubscribe);
  });

  createEffect(() => {
    const current = service();
    const signature = sourceSignature();
    loadCompleted();
    // Defer changed sources until a running batch finishes. Do not reload an
    // unchanged batch and erase its useful per-file transcription errors.
    if (!current || !libraryAttached() || indexing()) return;
    if (loadingService === current) return;
    if (current === loadedService && signature === loadedSignature) return;
    loadedService = current;
    loadedSignature = signature;
    loadingService = current;
    setLoadError(undefined);
    // A load owned by another caller may have captured an older asset list.
    // Once it settles, load this signature again rather than losing an import.
    const alreadyLoading = untrack(() => current.snapshot().loading);
    void untrack(async () => {
      await current.load();
      if (alreadyLoading && service() === current) await current.load();
    }).catch((error: unknown) => {
      if (service() === current) setLoadError(errorMessage(error));
    }).finally(() => {
      if (loadingService === current) loadingService = undefined;
      setLoadCompleted((value) => value + 1);
    });
  });

  createEffect(() => {
    const state = snapshot();
    if (state.loading) return;
    const currentItems = new Map(state.items.map((item) => [item.assetId, item]));
    const isCurrent = (passage: FootageMatch) => {
      const item = currentItems.get(passage.assetId);
      return item?.status === "ready" && item.fingerprint === passage.fingerprint;
    };
    const previous = untrack(selected);
    const remaining = previous.filter(isCurrent);
    if (remaining.length !== previous.length) {
      setSelected(remaining);
      setNotice("Changed or unavailable footage was removed from your selection. Index it again to use the updated speech.");
    }
    const currentPreview = untrack(preview);
    if (currentPreview && !isCurrent(currentPreview.passage)) clearPreview();
    if (untrack(fileFilter) && !currentItems.has(untrack(fileFilter))) setFileFilter("");
  });

  createEffect(() => {
    if (sidebarTab() !== "footage") mediaElement?.pause();
  });
  onCleanup(clearPreview);

  const matches = createMemo(() => {
    snapshot(); // Search is backed by the service's latest index snapshot.
    const all = service()?.search(query()) ?? [];
    return fileFilter() ? all.filter((match) => match.assetId === fileFilter()) : all;
  });
  const visibleMatches = createMemo(() => matches().slice(0, RESULT_LIMIT));
  const selectedIds = createMemo(() => new Set(selected().map((passage) => passage.id)));
  const selectedDuration = createMemo(() => selected().reduce((duration, passage) => duration + passage.sourceOut - passage.sourceIn, 0));
  const readyCount = createMemo(() => snapshot().items.filter((item) => item.status === "ready").length);
  const busy = () => snapshot().loading || snapshot().indexing || building();

  const indexFootage = async () => {
    const current = service();
    if (!current || busy()) return;
    setActionError(undefined);
    setNotice(undefined);
    try {
      await current.indexAll();
    } catch (error) {
      if (service() !== current) return;
      if (error instanceof Error && error.name === "AbortError") setNotice("Indexing stopped. Completed speech sections are saved; resume to continue.");
      else setActionError(errorMessage(error));
    }
  };

  const togglePassage = (passage: FootageMatch) => {
    if (building()) return;
    setNotice(undefined);
    if (selectedIds().has(passage.id)) {
      setSelected((items) => items.filter((item) => item.id !== passage.id));
    } else if (selected().length < PASSAGE_LIMIT) {
      setSelected((items) => [...items, passage]);
    } else {
      setNotice(`A cut can contain up to ${PASSAGE_LIMIT} passages. Create this cut before adding more.`);
    }
  };

  const movePassage = (index: number, offset: number) => {
    setSelected((items) => {
      const target = index + offset;
      if (target < 0 || target >= items.length) return items;
      const reordered = [...items];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      return reordered;
    });
  };

  const previewPassage = async (passage: FootageMatch) => {
    clearPreview();
    const request = previewRequest;
    const current = service();
    setPreviewLoading(passage.id);
    try {
      await current?.validateSelections([passage]);
      const asset = library()?.get(passage.assetId);
      if (!asset || (asset.type !== "VIDEO" && asset.type !== "AUDIO")) throw new Error("This source is no longer available. Refresh its footage index.");
      const file = await asset.handle.getFile();
      if (request !== previewRequest || current !== service()) return;
      setPreview({ passage, url: URL.createObjectURL(file), video: asset.type === "VIDEO" });
      queueMicrotask(() => {
        if (request === previewRequest) previewElement?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    } catch (error) {
      if (request === previewRequest && current === service()) setPreviewError(errorMessage(error));
    } finally {
      if (request === previewRequest) setPreviewLoading(undefined);
    }
  };

  const seekToPassage = () => {
    const current = preview();
    if (current && mediaElement) mediaElement.currentTime = current.passage.sourceIn;
  };
  const stopAtPassageEnd = () => {
    const current = preview();
    if (current && mediaElement && !mediaElement.paused && mediaElement.currentTime >= current.passage.sourceOut) mediaElement.pause();
  };
  const playPassage = async () => {
    seekToPassage();
    try {
      await mediaElement?.play();
    } catch (error) {
      setPreviewError(errorMessage(error));
    }
  };

  const createCut = async () => {
    const current = service();
    if (!current || busy() || !selected().length) return;
    setActionError(undefined);
    setNotice(undefined);
    setBuilding(true);
    try {
      const result = await current.createCut([...selected()], { name: sceneName().trim() || undefined });
      if (current !== service()) return;
      setSelected([]);
      setSceneName("");
      setNotice(`Created a new scene with ${result.clipCount} passage${result.clipCount === 1 ? "" : "s"} and captions.`);
      toast.success("Transcript cut created", { description: `${timecode(result.duration)} in a new scene.` });
    } catch (error) {
      if (current === service()) setActionError(errorMessage(error));
    } finally {
      setBuilding(false);
    }
  };

  return (
    <section aria-label="Footage search" class="flex flex-1 min-h-0 flex-col text-foreground text-xs">
      <div class="h-12 shrink-0 flex items-center px-4 border-y border-border [[data-platform=win32]_&]:border-t-0">
        <SidebarTabs />
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <div class="p-4 space-y-3 border-b border-border">
          <div>
            <h2 class="font-450 text-sm">Find the moment</h2>
            <p class="text-muted-foreground leading-relaxed mt-1">Search spoken words, preview the source, and turn selected passages into a new cut.</p>
          </div>
          <div class="flex items-center gap-2">
            <Button onClick={() => void indexFootage()} disabled={busy() || !snapshot().items.length || !service()}>
              {snapshot().loading ? "Loading index…" : snapshot().indexing ? "Indexing footage…" : snapshot().items.some(item => item.partial?.completed) ? "Resume indexing" : "Index footage"}
            </Button>
            <Show when={snapshot().indexing}>
              <Button variant="outline" onClick={() => service()?.cancel()}>Cancel</Button>
            </Show>
            <Show when={!snapshot().indexing && !snapshot().loading}>
              <span class="text-muted-foreground ml-auto">{readyCount()}/{snapshot().items.length} ready</span>
            </Show>
          </div>
          <Show when={snapshot().indexing && snapshot().progress}>
            {(progress) => (
              <div class="space-y-1.5" role="status" aria-live="polite">
                <progress class="w-full h-1.5 accent-primary" value={progress().completed} max={Math.max(1, progress().total)} aria-label="Footage indexing progress" />
                <p class="text-muted-foreground truncate" title={progress().currentPath}>{progress().completed} of {progress().total}{progress().currentPath ? ` · ${fileName(progress().currentPath!)}` : ""}</p>
                <Show when={progress().message}><p class="text-muted-foreground leading-relaxed">{progress().message}</p></Show>
              </div>
            )}
          </Show>
          <Show when={!snapshot().loading && !snapshot().items.length}>
            <p class="text-muted-foreground leading-relaxed">Import video or audio in Assets to start indexing speech.</p>
          </Show>
          <Show when={snapshot().items.length > 0}>
            <details class="group">
              <summary class="cursor-pointer text-muted-foreground hover:text-foreground focus-ring rounded">Footage status ({snapshot().items.length})</summary>
              <ul class="mt-2 space-y-2 max-h-48 overflow-y-auto">
                <For each={snapshot().items}>{(item) => (
                  <li class="rounded border border-border px-2 py-1.5">
                    <div class="flex gap-2 justify-between">
                      <span class="truncate" title={item.path}>{fileName(item.path)}</span>
                      <span class="shrink-0 text-muted-foreground" classList={{ "text-emerald-400": item.status === "ready", "text-destructive": item.status === "error" }}>{item.partial?.completed && item.status !== "ready" ? `${statusLabel[item.status]} · ${item.partial.completed}/${item.partial.total} sections` : statusLabel[item.status]}</span>
                    </div>
                    <Show when={item.error}><p class="mt-1 text-destructive leading-relaxed break-words">{item.error}</p></Show>
                  </li>
                )}</For>
              </ul>
            </details>
          </Show>
          <Show when={snapshot().error || actionError() || loadError()}>
            <p role="alert" class="text-destructive leading-relaxed break-words">{actionError() || loadError() || snapshot().error}</p>
          </Show>
          <Show when={notice()}><p role="status" class="text-muted-foreground leading-relaxed">{notice()}</p></Show>
        </div>

        <div class="p-4 space-y-3 border-b border-border">
          <label class="block space-y-1.5">
            <span class="font-450">Search spoken words</span>
            <input type="search" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Try a name, topic, or exact phrase…" class="w-full h-8 rounded-md border border-border-input bg-transparent px-2 focus-ring" />
          </label>
          <Show when={snapshot().items.length > 1}>
            <label class="flex items-center gap-2 text-muted-foreground">
              <span class="shrink-0">Source</span>
              <select aria-label="Filter footage source" value={fileFilter()} onChange={(event) => setFileFilter(event.currentTarget.value)} class="min-w-0 flex-1 h-7 rounded border border-border-input bg-background px-1 focus-ring text-foreground">
                <option value="">All footage</option>
                <For each={snapshot().items}>{(item) => <option value={item.assetId}>{fileName(item.path)}</option>}</For>
              </select>
            </label>
          </Show>

          <Show when={previewLoading()}><p role="status" class="text-muted-foreground">Loading source preview…</p></Show>
          <Show when={preview()}>
            {(current) => (
              <div ref={previewElement} class="rounded-lg border border-border overflow-hidden bg-background">
                <div class="flex items-center justify-between px-2 py-1.5 border-b border-border">
                  <span class="font-450">Source preview</span>
                  <Button size="small" variant="ghost" onClick={clearPreview} aria-label="Close source preview">Close</Button>
                </div>
                <Show when={current().video} fallback={
                  <audio ref={(element) => { mediaElement = element; }} src={current().url} controls preload="metadata" onLoadedMetadata={seekToPassage} onTimeUpdate={stopAtPassageEnd} onError={() => setPreviewError("This source could not be played.")} class="w-full my-2" aria-label={`Preview ${fileName(current().passage.path)}`} />
                }>
                  <video ref={(element) => { mediaElement = element; }} src={current().url} controls playsinline preload="metadata" onLoadedMetadata={seekToPassage} onTimeUpdate={stopAtPassageEnd} onError={() => setPreviewError("This source could not be played.")} class="w-full max-h-52 bg-black" aria-label={`Preview ${fileName(current().passage.path)}`} />
                </Show>
                <div class="px-2 py-2 space-y-2">
                  <div class="flex items-center gap-2"><span class="truncate flex-1 text-muted-foreground" title={current().passage.path}>{fileName(current().passage.path)}</span><span class="shrink-0 tabular-nums text-muted-foreground">{passageRange(current().passage)}</span></div>
                  <Button size="small" variant="outline" onClick={() => void playPassage()}>Play passage</Button>
                </div>
              </div>
            )}
          </Show>
          <Show when={previewError()}><p role="alert" class="text-destructive leading-relaxed">{previewError()}</p></Show>

          <div class="flex justify-between items-center text-muted-foreground" aria-live="polite">
            <span>{matches().length} {query().trim() ? "matching" : "available"} passage{matches().length === 1 ? "" : "s"}</span>
            <Show when={query()}><button type="button" class="hover:text-foreground focus-ring rounded" onClick={() => setQuery("")}>Clear search</button></Show>
          </div>
          <Show when={visibleMatches().length} fallback={
            <p class="text-muted-foreground leading-relaxed py-2">{snapshot().loading ? "Loading saved transcripts…" : readyCount() ? "No matching speech. Try a shorter phrase or another source." : "Index your footage to browse and search its transcript."}</p>
          }>
            <div class="space-y-2">
              <For each={visibleMatches()}>{(passage) => (
                <article class="rounded-lg border border-border overflow-hidden" classList={{ "border-emerald-600/70 bg-emerald-500/5": selectedIds().has(passage.id) }}>
                  <button type="button" onClick={() => void previewPassage(passage)} class="block text-left w-full p-2.5 hover:bg-accent/50 focus-ring" aria-label={`Preview ${fileName(passage.path)} at ${passageRange(passage)}`}>
                    <div class="flex items-center gap-2 text-muted-foreground mb-1.5"><span class="truncate flex-1" title={passage.path}>{fileName(passage.path)}</span><span class="shrink-0 tabular-nums text-[10px]">{passageRange(passage)}</span></div>
                    <p class="leading-relaxed whitespace-pre-wrap break-words">{passage.text}</p>
                  </button>
                  <div class="px-2.5 pb-2 flex items-center justify-between gap-2">
                    <button type="button" class="text-muted-foreground hover:text-foreground focus-ring rounded" onClick={() => void previewPassage(passage)} disabled={previewLoading() === passage.id}>{previewLoading() === passage.id ? "Loading…" : "Preview"}</button>
                    <Button size="small" variant={selectedIds().has(passage.id) ? "on" : "outline"} disabled={building()} aria-pressed={selectedIds().has(passage.id)} aria-label={`${selectedIds().has(passage.id) ? "Remove" : "Add"} passage from ${fileName(passage.path)} at ${timecode(passage.sourceIn)}`} onClick={() => togglePassage(passage)}>{selectedIds().has(passage.id) ? "Selected ✓" : "+ Add to cut"}</Button>
                  </div>
                </article>
              )}</For>
            </div>
          </Show>
          <Show when={matches().length > RESULT_LIMIT}><p class="text-muted-foreground leading-relaxed">Showing the first {RESULT_LIMIT} passages. Refine your search or choose a source to find more.</p></Show>
        </div>
      </div>

      <div class="shrink-0 border-t border-border p-3 space-y-2 bg-background">
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-450">Your cut <span class="text-muted-foreground">({selected().length})</span></h3>
          <Show when={selected().length}><button type="button" class="text-muted-foreground hover:text-foreground focus-ring rounded disabled:opacity-50" disabled={building()} onClick={() => setSelected([])}>Clear selection</button></Show>
        </div>
        <Show when={selected().length} fallback={<p class="text-muted-foreground leading-relaxed">Add passages in the order you want them to play.</p>}>
          <ol class="max-h-40 overflow-y-auto space-y-2">
            <For each={selected()}>{(passage, index) => (
              <li class="rounded border border-border p-2">
                <div class="flex gap-2 items-start">
                  <span class="text-muted-foreground tabular-nums mt-0.5">{index() + 1}.</span>
                  <button type="button" onClick={() => void previewPassage(passage)} class="min-w-0 flex-1 text-left focus-ring rounded" title={passage.text}>
                    <p class="line-clamp-2 leading-relaxed">{passage.text}</p>
                    <p class="text-muted-foreground mt-1 truncate text-[10px]">{fileName(passage.path)} · {passageRange(passage)}</p>
                  </button>
                </div>
                <div class="flex gap-1 justify-end mt-1.5">
                  <Button size="small" variant="ghost" disabled={building() || index() === 0} aria-label={`Move passage ${index() + 1} earlier`} onClick={() => movePassage(index(), -1)}>↑</Button>
                  <Button size="small" variant="ghost" disabled={building() || index() === selected().length - 1} aria-label={`Move passage ${index() + 1} later`} onClick={() => movePassage(index(), 1)}>↓</Button>
                  <Button size="small" variant="ghost" disabled={building()} aria-label={`Remove passage ${index() + 1}`} onClick={() => togglePassage(passage)}>Remove</Button>
                </div>
              </li>
            )}</For>
          </ol>
          <input aria-label="New cut scene name" value={sceneName()} onInput={(event) => setSceneName(event.currentTarget.value)} placeholder="Scene name (optional)" maxLength={120} disabled={building()} class="w-full h-7 rounded border border-border-input bg-transparent px-2 focus-ring" />
        </Show>
        <div class="flex items-center gap-2">
          <Button class="flex-1" disabled={busy() || !selected().length} onClick={() => void createCut()}>{building() ? "Creating cut…" : "Create cut"}</Button>
          <Show when={selected().length}><span class="text-muted-foreground tabular-nums">{timecode(selectedDuration())}</span></Show>
        </div>
        <Show when={selected().length}><p class="text-[10px] text-muted-foreground">Creates a new scene with captions and the source aspect ratio.</p></Show>
      </div>
    </section>
  );
}
