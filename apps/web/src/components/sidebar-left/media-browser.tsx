/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Media tab: a Finder-style, read-only view of folders anywhere on the
// computer. Dragging a clip or a folder out links it where it is, as an
// import does. The logic is in media-browser-data.ts; reads happen in the
// main process (media-browser.ts), which never writes into these folders.

import { batch, createEffect, createMemo, createRoot, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { toast } from "somoto";
import { MAIN_CHANNELS, type MediaEntry, type MediaListing, type MediaPlace, type MediaProbe } from "@desktop/main-channels";

import { SidebarTabs } from "@/agent-chat";
import { store as settings } from "@/init";
import { mainBridge } from "@/lib/ipc";
import { createStoredSignal } from "@/lib/store";
import { isDesktop } from "@/projects/host";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import {
  baseName,
  columnPaths,
  detailRows,
  dragPaths,
  filterEntries,
  formatDuration,
  formatSize,
  MEDIA_PATHS_DRAG_TYPE,
  mediaKind,
  mergePlaces,
  pathSegments,
  permissionNoteFor,
  placeFor,
  select,
  sortEntries,
  visibleGridRange,
  visibleRange,
  type BrowserPlace,
  type MediaKind,
  type Selection,
  type SortKey,
  type SortOrder,
  type ViewMode,
  type VisibleRange,
} from "./media-browser-data";

const ROW_HEIGHT = 24;
const TILE_HEIGHT = 92;
const TILE_MIN_WIDTH = 84;
const COLUMN_WIDTH = 168;
const PRIVACY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

const prefs = createRoot(() => {
  const [added, setAdded] = createStoredSignal(settings.define<string[]>("mediaBrowser.places", []));
  const [notesSeen, setNotesSeen] = createStoredSignal(settings.define<string[]>("mediaBrowser.permissionNotes", []));
  const [view, setView] = createStoredSignal(settings.define<ViewMode>("mediaBrowser.view", "list"));
  const [sort, setSort] = createStoredSignal(settings.define<SortOrder>("mediaBrowser.sort", { key: "name", descending: false }));
  const [kinds, setKinds] = createStoredSignal(settings.define<MediaKind[]>("mediaBrowser.kinds", []));
  const [lastPath, setLastPath] = createStoredSignal(settings.define<string | null>("mediaBrowser.path", null));
  return { added, setAdded, notesSeen, setNotesSeen, view, setView, sort, setSort, kinds, setKinds, lastPath, setLastPath };
});

const parentOf = (path: string): string => path.replace(/\/[^/]+\/?$/, "") || "/";

const KIND_ICON: Record<MediaKind, string> = { video: "video-small", audio: "audio-small", image: "image-small" };
const KIND_LABEL: Record<MediaKind, string> = { video: "Video", audio: "Audio", image: "Image" };
const SORT_LABEL: Record<SortKey, string> = { name: "Name", date: "Date modified", kind: "Kind", duration: "Duration", size: "Size" };

/** The Media tab, beside Project and Footage. */
export function MediaBrowser() {
  return (
    <div class="flex flex-1 min-h-0 flex-col">
      <div class="h-9 shrink-0 flex items-center px-4 border-y border-border [[data-platform=win32]_&]:border-t-0"><SidebarTabs group="project" /></div>
      <Show when={isDesktop()} fallback={<p class="p-4 text-xs text-muted-foreground">The media browser runs in the desktop app.</p>}>
        <Browser />
      </Show>
    </div>
  );
}

function Browser() {
  const [systemPlaces, setSystemPlaces] = createSignal<MediaPlace[]>([]);
  const places = createMemo(() => mergePlaces(systemPlaces(), prefs.added()));
  const [path, setPath] = createSignal<string | null>(prefs.lastPath());
  const [listings, setListings] = createSignal<ReadonlyMap<string, MediaListing>>(new Map());
  const [loading, setLoading] = createSignal<ReadonlySet<string>>(new Set());
  const [probes, setProbes] = createSignal<ReadonlyMap<string, MediaProbe>>(new Map());
  const [selection, setSelection] = createSignal<Selection>({ selected: [], anchor: null });
  let body: HTMLDivElement | undefined;

  const refreshPlaces = async () => {
    try {
      setSystemPlaces(await mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_PLACES, undefined));
    } catch (error) {
      toast.error("Could not list places", { description: (error as Error).message });
    }
  };
  onMount(() => {
    void refreshPlaces();
    // Drives come and go; a glance back at the app is when to look again.
    window.addEventListener("focus", refreshPlaces);
    onCleanup(() => window.removeEventListener("focus", refreshPlaces));
  });

  // Start where the user left off, or in the first place once places are known.
  createEffect(() => {
    if (path() === null && places().length) setPath(places()[0]!.path);
  });
  createEffect(() => {
    const current = path();
    if (current) prefs.setLastPath(current);
  });

  const note = createMemo(() => {
    const current = path();
    return current ? permissionNoteFor(current, places(), prefs.notesSeen()) : null;
  });

  /** The folders on screen: every column in the columns view, the current folder otherwise. */
  const shownFolders = createMemo(() => {
    const current = path();
    if (!current || note()) return [];
    return prefs.view() === "columns" ? columnPaths(current, places()) : [current];
  });

  const load = async (folder: string) => {
    setLoading((set) => new Set(set).add(folder));
    try {
      const listing = await mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_LIST, { path: folder, request: `list:${folder}` });
      if (listing.status !== "cancelled") setListings((map) => new Map(map).set(folder, listing));
    } catch (error) {
      toast.error(`Could not read ${baseName(folder)}`, { description: (error as Error).message });
    } finally {
      setLoading((set) => {
        const next = new Set(set);
        next.delete(folder);
        return next;
      });
    }
  };

  // List what comes on screen, every visit (folders change); stop reading what left it.
  createEffect(on(shownFolders, (folders, previous) => {
    for (const folder of folders) if (!previous?.includes(folder)) void load(folder);
    for (const folder of previous ?? []) {
      if (!folders.includes(folder) && loading().has(folder)) void mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_CANCEL, { request: `list:${folder}` });
    }
  }));

  const kindFilter = createMemo(() => new Set(prefs.kinds()));
  const durations = createMemo(() => {
    const map = new Map<string, number>();
    for (const [file, probe] of probes()) if (probe.status === "ok" && probe.details.duration !== undefined) map.set(file, probe.details.duration);
    return map;
  });
  const entriesOf = (folder: string): MediaEntry[] => {
    const listing = listings().get(folder);
    if (!listing || listing.status !== "ok") return [];
    return sortEntries(filterEntries(listing.entries, kindFilter()), prefs.sort(), durations());
  };
  const entryAt = (file: string): MediaEntry | undefined => listings().get(parentOf(file))?.entries.find((entry) => entry.path === file);

  // --- probing: the selected clip, and the rows the list view shows -------

  const probing = new Set<string>();
  const probe = async (file: string, request: string) => {
    if (probes().has(file) || probing.has(file)) return;
    probing.add(file);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_PROBE, { path: file, request });
      if (result.status !== "cancelled") setProbes((map) => new Map(map).set(file, result));
    } catch {
      // The details panel says "Reading…" until another selection asks again.
    } finally {
      probing.delete(file);
    }
  };

  const selectedFile = createMemo(() => {
    const { selected } = selection();
    if (selected.length !== 1) return undefined;
    const entry = entryAt(selected[0]!);
    return entry?.kind === "file" ? entry : undefined;
  });
  createEffect(() => {
    const entry = selectedFile();
    if (entry && !entry.cloud) void probe(entry.path, "details");
  });

  const rowRequests = new Set<string>();
  const probeRows = (entries: MediaEntry[]) => {
    const wanted = new Set(entries.filter((entry) => entry.kind === "file" && !entry.cloud && mediaKind(entry.name) !== "image").map((entry) => entry.path));
    for (const file of rowRequests) {
      if (!wanted.has(file)) {
        rowRequests.delete(file);
        void mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_CANCEL, { request: `row:${file}` });
      }
    }
    for (const file of wanted) {
      if (rowRequests.has(file) || probes().has(file)) continue;
      rowRequests.add(file);
      void probe(file, `row:${file}`).finally(() => rowRequests.delete(file));
    }
  };
  onCleanup(() => {
    for (const file of rowRequests) void mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_CANCEL, { request: `row:${file}` });
    void mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_CANCEL, { request: "details" });
  });

  // --- navigation and selection -------------------------------------------

  const open = (folder: string) => batch(() => {
    setPath(folder);
    setSelection({ selected: [], anchor: null });
  });

  const choose = (folder: string, entry: MediaEntry, event: MouseEvent) => {
    const keys = entriesOf(folder).map((item) => item.path);
    const modifiers = { toggle: event.metaKey || event.ctrlKey, extend: event.shiftKey };
    batch(() => {
      setSelection((current) => select(keys, current, entry.path, modifiers));
      // In columns a click opens: a folder gets a column, a file closes the ones after it.
      if (prefs.view() === "columns" && !modifiers.toggle && !modifiers.extend) {
        setPath(entry.kind === "directory" ? entry.path : folder);
      }
    });
  };

  const goUp = () => {
    const current = path();
    if (!current || current === "/") return;
    const place = placeFor(current, places());
    if (place && place.path === current) return;
    open(parentOf(current));
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const current = path();
    if (!current) return;
    if ((event.key === "ArrowUp" && event.metaKey) || event.key === "Backspace") {
      event.preventDefault();
      goUp();
      return;
    }
    // Arrows move through the folder the selection is in.
    const anchor = selection().anchor;
    const folder = anchor ? parentOf(anchor) : current;
    const keys = entriesOf(folder).map((entry) => entry.path);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!keys.length) return;
      const index = anchor ? keys.indexOf(anchor) : -1;
      const next = keys[Math.min(keys.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]!;
      batch(() => {
        setSelection((selected) => select(keys, selected, next, { extend: event.shiftKey }));
        if (prefs.view() === "columns" && !event.shiftKey) setPath(entryAt(next)?.kind === "directory" ? next : folder);
      });
    } else if (event.key === "Enter" || (event.key === "ArrowDown" && event.metaKey)) {
      const entry = anchor ? entryAt(anchor) : undefined;
      if (entry?.kind === "directory") open(entry.path);
    }
  };

  const handleDragStart = (folder: string, entry: MediaEntry, event: DragEvent) => {
    const paths = dragPaths(entriesOf(folder), selection().selected, entry.path);
    if (!paths.length || !event.dataTransfer) {
      event.preventDefault();
      toast("This file is in the cloud", { description: "Download it in Finder first, then drag it in." });
      return;
    }
    event.dataTransfer.setData(MEDIA_PATHS_DRAG_TYPE, paths.join("\n"));
    event.dataTransfer.effectAllowed = "copy";
  };

  const addFolder = async () => {
    const folder = await mainBridge.call(MAIN_CHANNELS.MEDIA_BROWSER_PICK_FOLDER, undefined);
    if (!folder) return;
    if (!prefs.added().includes(folder)) prefs.setAdded([...prefs.added(), folder]);
    open(folder);
  };
  const removeFolder = (folder: string) => prefs.setAdded(prefs.added().filter((item) => item !== folder));

  const acknowledge = () => {
    const key = note();
    if (key) prefs.setNotesSeen([...prefs.notesSeen(), key]);
  };

  const retry = () => {
    const current = path();
    if (current) void load(current);
  };

  const isOnTrail = (folder: string): boolean => {
    const current = path();
    return !!current && (current === folder || current.startsWith(`${folder}/`));
  };

  const rowProps = (folder: string) => ({
    // In columns the trail of open folders stays highlighted, as in Finder.
    selected: (entry: MediaEntry) => selection().selected.includes(entry.path) || (prefs.view() === "columns" && entry.kind === "directory" && isOnTrail(entry.path)),
    onClick: (entry: MediaEntry, event: MouseEvent) => choose(folder, entry, event),
    onOpen: (entry: MediaEntry) => entry.kind === "directory" && open(entry.path),
    onDragStart: (entry: MediaEntry, event: DragEvent) => handleDragStart(folder, entry, event),
    duration: (entry: MediaEntry) => durations().get(entry.path),
  });

  // Keep the newest column in view.
  createEffect(on(shownFolders, () => {
    if (prefs.view() === "columns") queueMicrotask(() => body?.scrollTo({ left: body.scrollWidth }));
  }));

  return (
    <div class="flex flex-1 min-h-0 flex-col text-xs" tabIndex={0} onKeyDown={handleKeyDown} aria-label="Media browser">
      <Toolbar path={path()} places={places()} onOpen={open} onUp={goUp} />
      <div class="flex flex-1 min-h-0">
        <Places places={places()} current={path()} onOpen={open} onAdd={addFolder} onRemove={removeFolder} />
        <div ref={body} class="flex flex-1 min-w-0 min-h-0" classList={{ "overflow-x-auto": prefs.view() === "columns" }}>
          <Show when={!note()} fallback={<PermissionNote place={note()!} places={places()} onContinue={acknowledge} />}>
            <For each={shownFolders()}>
              {(folder) => (
                <FolderView
                  folder={folder}
                  listing={listings().get(folder)}
                  loading={loading().has(folder)}
                  entries={entriesOf(folder)}
                  view={prefs.view()}
                  onRetry={retry}
                  onVisible={prefs.view() === "list" ? probeRows : undefined}
                  {...rowProps(folder)}
                />
              )}
            </For>
          </Show>
        </div>
      </div>
      <Show when={selection().selected.length > 0}>
        <Details selected={selection().selected} entry={selectedFile()} probe={selectedFile() ? probes().get(selectedFile()!.path) : undefined} />
      </Show>
    </div>
  );
}

function Toolbar(props: { path: string | null; places: BrowserPlace[]; onOpen: (path: string) => void; onUp: () => void }) {
  const segments = () => (props.path ? pathSegments(props.path, props.places) : []);
  const toggleKind = (kind: MediaKind) => {
    const kinds = prefs.kinds();
    prefs.setKinds(kinds.includes(kind) ? kinds.filter((item) => item !== kind) : [...kinds, kind]);
  };
  return (
    <div class="shrink-0 border-b border-border">
      <nav class="flex h-8 items-center gap-0.5 px-2 min-w-0" aria-label="Path">
        <Button variant="ghost" size="icon" class="text-muted-foreground" aria-label="Enclosing folder" onClick={props.onUp}>
          <Icon name="chevron-right" class="-rotate-90 size-4" />
        </Button>
        <ol class="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          <For each={segments()}>
            {(segment, index) => (
              <li class="flex min-w-0 items-center gap-0.5" classList={{ "shrink-0": index() === segments().length - 1 }}>
                <Show when={index() > 0}><span class="text-muted-foreground/60">›</span></Show>
                <button
                  type="button"
                  class="truncate rounded px-1 focus-ring hover:text-foreground"
                  classList={{ "text-foreground": index() === segments().length - 1, "text-muted-foreground": index() !== segments().length - 1 }}
                  title={segment.path}
                  onClick={() => props.onOpen(segment.path)}
                >
                  {segment.label}
                </button>
              </li>
            )}
          </For>
        </ol>
      </nav>
      <div class="flex h-8 items-center gap-1 px-2">
        <div class="flex items-center gap-0.5" role="group" aria-label="View">
          <For each={["columns", "list", "grid"] as ViewMode[]}>
            {(mode) => (
              <Button size="small" variant={prefs.view() === mode ? "secondary" : "ghost"} aria-pressed={prefs.view() === mode} onClick={() => prefs.setView(mode)}>
                {mode === "columns" ? "Columns" : mode === "list" ? "List" : "Grid"}
              </Button>
            )}
          </For>
        </div>
        <div class="mx-1 h-4 w-px bg-border" />
        <div class="flex items-center gap-0.5" role="group" aria-label="Show only">
          <For each={["video", "audio", "image"] as MediaKind[]}>
            {(kind) => (
              <Button size="small" variant={prefs.kinds().includes(kind) ? "secondary" : "ghost"} aria-pressed={prefs.kinds().includes(kind)} onClick={() => toggleKind(kind)}>
                {KIND_LABEL[kind]}
              </Button>
            )}
          </For>
        </div>
        <div class="flex-1" />
        <select
          class="h-5 rounded bg-transparent text-xxs text-muted-foreground outline-none focus-ring hover:text-foreground"
          aria-label="Sort by"
          value={prefs.sort().key}
          onChange={(event) => prefs.setSort({ ...prefs.sort(), key: event.currentTarget.value as SortKey })}
        >
          <For each={Object.keys(SORT_LABEL) as SortKey[]}>{(key) => <option value={key}>{SORT_LABEL[key]}</option>}</For>
        </select>
        <Button
          size="small"
          variant="ghost"
          aria-label={prefs.sort().descending ? "Descending" : "Ascending"}
          onClick={() => prefs.setSort({ ...prefs.sort(), descending: !prefs.sort().descending })}
        >
          {prefs.sort().descending ? "↓" : "↑"}
        </Button>
      </div>
    </div>
  );
}

function Places(props: { places: BrowserPlace[]; current: string | null; onOpen: (path: string) => void; onAdd: () => void; onRemove: (path: string) => void }) {
  const groups: Array<[BrowserPlace["group"], string]> = [["favorites", "Favorites"], ["volumes", "Locations"], ["added", "Added"]];
  const active = () => (props.current ? placeFor(props.current, props.places)?.path : undefined);
  return (
    <nav class="w-28 shrink-0 overflow-y-auto border-r border-border py-1" aria-label="Places">
      <For each={groups}>
        {([group, label]) => (
          <Show when={props.places.some((place) => place.group === group)}>
            <div class="px-2 pt-2 pb-0.5 text-xxs text-muted-foreground">{label}</div>
            <For each={props.places.filter((place) => place.group === group)}>
              {(place) => (
                <div class="group/place flex items-center">
                  <button
                    type="button"
                    class="flex-1 min-w-0 truncate rounded px-2 py-0.5 text-left focus-ring hover:bg-accent"
                    classList={{ "bg-accent text-foreground": active() === place.path, "text-muted-foreground": active() !== place.path }}
                    title={place.path}
                    onClick={() => props.onOpen(place.path)}
                  >
                    {place.label}
                  </button>
                  <Show when={group === "added"}>
                    <button
                      type="button"
                      class="hidden px-1 text-muted-foreground hover:text-foreground group-hover/place:block focus-ring"
                      aria-label={`Remove ${place.label} from Places`}
                      onClick={() => props.onRemove(place.path)}
                    >
                      ×
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        )}
      </For>
      <button type="button" class="mt-2 w-full truncate px-2 py-0.5 text-left text-muted-foreground hover:text-foreground focus-ring" onClick={props.onAdd}>
        + Add folder…
      </button>
    </nav>
  );
}

function PermissionNote(props: { place: string; places: BrowserPlace[]; onContinue: () => void }) {
  const name = () => props.places.find((place) => place.path === props.place)?.label ?? baseName(props.place);
  return (
    <div class="m-auto max-w-64 p-4 text-center">
      <p class="text-foreground">macOS may ask whether Blackout can read “{name()}”.</p>
      <p class="mt-2 text-muted-foreground">Blackout only reads folders you browse here. It never writes, moves or deletes anything in them.</p>
      <Button class="mt-3" size="default" onClick={props.onContinue}>Continue</Button>
    </div>
  );
}

type RowHandlers = {
  selected: (entry: MediaEntry) => boolean;
  onClick: (entry: MediaEntry, event: MouseEvent) => void;
  onOpen: (entry: MediaEntry) => void;
  onDragStart: (entry: MediaEntry, event: DragEvent) => void;
  duration: (entry: MediaEntry) => number | undefined;
};

type FolderViewProps = RowHandlers & {
  folder: string;
  listing: MediaListing | undefined;
  loading: boolean;
  entries: MediaEntry[];
  view: ViewMode;
  onRetry: () => void;
  onVisible?: (entries: MediaEntry[]) => void;
};

function FolderView(props: FolderViewProps) {
  const state = (): "reading" | "denied" | "missing" | "empty" | "ok" | "idle" => {
    if (!props.listing) return props.loading ? "reading" : "idle";
    if (props.listing.status === "denied" || props.listing.status === "missing") return props.listing.status;
    return props.entries.length ? "ok" : "empty";
  };
  return (
    <div
      class="flex min-h-0 flex-col"
      classList={{ "shrink-0 border-r border-border": props.view === "columns", "flex-1 min-w-0": props.view !== "columns" }}
      style={props.view === "columns" ? { width: `${COLUMN_WIDTH}px` } : undefined}
    >
      <Switch>
        <Match when={state() === "reading"}><p class="p-3 text-muted-foreground">Reading…</p></Match>
        <Match when={state() === "denied"}>
          <div class="p-3">
            <p class="text-foreground">Blackout isn’t allowed to read this folder.</p>
            <p class="mt-1 text-muted-foreground">Allow it in System Settings › Privacy &amp; Security › Files and Folders, then try again.</p>
            <div class="mt-2 flex flex-wrap gap-1">
              <Button size="small" variant="secondary" onClick={() => void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: PRIVACY_SETTINGS_URL })}>Open System Settings</Button>
              <Button size="small" variant="ghost" onClick={props.onRetry}>Try again</Button>
            </div>
          </div>
        </Match>
        <Match when={state() === "missing"}><p class="p-3 text-muted-foreground">This folder is gone, or its drive was ejected.</p></Match>
        <Match when={state() === "empty"}><p class="p-3 text-muted-foreground">No media here.</p></Match>
        <Match when={state() === "ok" && props.view === "grid"}><GridTiles {...props} /></Match>
        <Match when={state() === "ok"}><ListRows {...props} details={props.view === "list"} /></Match>
      </Switch>
    </div>
  );
}

/** Tracks a scroll container's offset and height, for virtualized drawing. */
function createViewport() {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  const [width, setWidth] = createSignal(0);
  let element: HTMLDivElement | undefined;
  const ref = (node: HTMLDivElement) => {
    element = node;
    const observer = new ResizeObserver(() => {
      setHeight(node.clientHeight);
      setWidth(node.clientWidth);
    });
    observer.observe(node);
    onCleanup(() => observer.disconnect());
  };
  const onScroll = () => element && setScrollTop(element.scrollTop);
  return { ref, onScroll, scrollTop, height, width };
}

function ListRows(props: FolderViewProps & { details: boolean }) {
  const viewport = createViewport();
  const range = createMemo<VisibleRange>(() => visibleRange(viewport.scrollTop(), viewport.height(), ROW_HEIGHT, props.entries.length));
  const rows = createMemo(() => props.entries.slice(range().start, range().end));
  createEffect(() => props.onVisible?.(rows()));
  return (
    <div ref={viewport.ref} class="relative flex-1 min-h-0 overflow-y-auto" onScroll={viewport.onScroll} role="listbox" aria-multiselectable="true">
      <div style={{ height: `${props.entries.length * ROW_HEIGHT}px` }} />
      <For each={rows()}>
        {(entry, index) => (
          <div
            role="option"
            aria-selected={props.selected(entry)}
            draggable={true}
            class="absolute inset-x-0 flex items-center gap-1.5 px-2 cursor-default select-none"
            classList={{ "bg-accent text-foreground": props.selected(entry), "text-muted-foreground hover:bg-accent/50": !props.selected(entry) }}
            style={{ top: `${(range().start + index()) * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }}
            title={entry.name}
            onClick={(event) => props.onClick(entry, event)}
            onDblClick={() => props.onOpen(entry)}
            onDragStart={(event) => props.onDragStart(entry, event)}
          >
            <EntryIcon entry={entry} class="size-4" />
            <span class="min-w-0 flex-1 truncate">{entry.name}</span>
            <Show when={entry.cloud}><span class="shrink-0 text-xxs text-muted-foreground">In the cloud</span></Show>
            <Show when={props.details && entry.kind === "file" && !entry.cloud}>
              <span class="w-10 shrink-0 text-right tabular-nums text-xxs">{props.duration(entry) !== undefined ? formatDuration(props.duration(entry)!) : ""}</span>
              <span class="w-14 shrink-0 text-right tabular-nums text-xxs">{formatSize(entry.size)}</span>
            </Show>
            <Show when={!props.details && entry.kind === "directory"}><span class="text-muted-foreground/60">›</span></Show>
          </div>
        )}
      </For>
    </div>
  );
}

function GridTiles(props: FolderViewProps) {
  const viewport = createViewport();
  const columns = () => Math.max(1, Math.floor(viewport.width() / TILE_MIN_WIDTH));
  const range = createMemo(() => visibleGridRange(viewport.scrollTop(), viewport.height(), TILE_HEIGHT, columns(), props.entries.length));
  const tiles = createMemo(() => props.entries.slice(range().start, range().end));
  return (
    <div ref={viewport.ref} class="relative flex-1 min-h-0 overflow-y-auto" onScroll={viewport.onScroll} role="listbox" aria-multiselectable="true">
      <div style={{ height: `${Math.ceil(props.entries.length / columns()) * TILE_HEIGHT}px` }} />
      <For each={tiles()}>
        {(entry, index) => {
          const position = () => range().start + index();
          return (
            <div
              role="option"
              aria-selected={props.selected(entry)}
              draggable={true}
              class="absolute flex flex-col items-center gap-1 p-1.5 cursor-default select-none rounded"
              classList={{ "bg-accent text-foreground": props.selected(entry), "text-muted-foreground hover:bg-accent/50": !props.selected(entry) }}
              style={{
                top: `${Math.floor(position() / columns()) * TILE_HEIGHT}px`,
                left: `${(position() % columns()) * (100 / columns())}%`,
                width: `${100 / columns()}%`,
                height: `${TILE_HEIGHT}px`,
              }}
              title={entry.name}
              onClick={(event) => props.onClick(entry, event)}
              onDblClick={() => props.onOpen(entry)}
              onDragStart={(event) => props.onDragStart(entry, event)}
            >
              {/* An icon, not a thumbnail: a thumbnail would mean a decoder per tile. */}
              <div class="flex aspect-video w-full items-center justify-center rounded bg-muted">
                <EntryIcon entry={entry} class="size-6" />
              </div>
              <span class="w-full truncate text-center text-xxs">{entry.name}</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function EntryIcon(props: { entry: MediaEntry; class?: string }) {
  const name = () => {
    if (props.entry.kind === "directory") return "navigation.folder";
    const kind = mediaKind(props.entry.name);
    return kind ? KIND_ICON[kind] : "attachment";
  };
  return <Icon name={name()} class={props.class} />;
}

function Details(props: { selected: string[]; entry: MediaEntry | undefined; probe: MediaProbe | undefined }) {
  const body = (): JSX.Element => {
    const entry = props.entry;
    if (!entry) return <p class="text-muted-foreground">{props.selected.length > 1 ? `${props.selected.length} items selected` : baseName(props.selected[0] ?? "")}</p>;
    if (entry.cloud) return <p class="text-muted-foreground">In the cloud. Download it in Finder to see its details and add it.</p>;
    const probe = props.probe;
    if (!probe) return <p class="text-muted-foreground">Reading…</p>;
    if (probe.status === "unavailable") return <p class="text-muted-foreground">Clip details need the app’s media tools.</p>;
    if (probe.status === "failed") return <p class="text-muted-foreground">Can’t read this file: {probe.error}</p>;
    if (probe.status !== "ok") return <p class="text-muted-foreground">Reading…</p>;
    return (
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <For each={detailRows(probe.details)}>
          {([label, value]) => (
            <>
              <dt class="text-muted-foreground">{label}</dt>
              <dd class="truncate tabular-nums">{value}</dd>
            </>
          )}
        </For>
      </dl>
    );
  };
  return (
    <section class="shrink-0 border-t border-border px-3 py-2" aria-label="Details">
      <Show when={props.entry}>
        {(entry) => (
          <div class="mb-1 flex items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate text-foreground">{entry().name}</span>
            <span class="shrink-0 text-xxs text-muted-foreground">{formatSize(entry().size)} · {new Date(entry().mtime).toLocaleDateString()}</span>
          </div>
        )}
      </Show>
      {body()}
      <p class="mt-1 text-xxs text-muted-foreground/80">Drag to the timeline or the Project panel to link it where it is.</p>
    </section>
  );
}
