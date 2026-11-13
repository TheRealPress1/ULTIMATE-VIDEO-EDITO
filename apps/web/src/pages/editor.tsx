/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createMemo, createSignal, onMount } from "solid-js";
import { Canvas } from "@/components/canvas";
import { ChatPanel, projectTab, setSidebarTab } from "@/agent-chat";
import { TopBar } from "@/components/top-bar/top-bar";
import { SceneSwitch } from "@/components/top-bar/scene-switch";
import { WorkspaceTabs } from '@/components/workspace-tabs';
import { Assets } from "@/components/sidebar-left/assets";
import { Footage } from "@/components/sidebar-left/footage";
import { Icon } from "@/components/ui/icon";
import { useExport } from "@/context/export";
import { assetSystem, getActiveEntity, transformSystem } from "@diffusionstudio/runtime";
import { beginEditorLoad } from '@/dapi/session';
import { Timeline, Layers } from "@/components/timeline";
import { TimelineTools } from '@/components/timeline/timeline-tools';
import { Soundboard, Inspector } from "@/components/sidebar-right";
import { EditorTitleBar, FloatingProjectHeader } from "@/components/sidebar-left";
import { DraftBadge, ProjectNameInput } from "@/components/sidebar-left/sidebar-left";
import { useLayout, MIN_PROJECT_PANEL_HEIGHT, MIN_TIMELINE_HEIGHT } from "@/context/layout";
import { RULER_HEIGHT } from "@/engine/timeline";
import { createEffect, onCleanup, untrack } from 'solid-js';
import { toast } from 'somoto';
import { useWorld } from '@diffusionstudio/koota-solid';
import { mount } from '@diffusionstudio/reconciler';
import { getDocumentEditor } from '@/engine/editor';
import { applyExternalEdit } from '@/engine/external-edit';
import { getEditHistory } from '@/engine/history';
import { setInspectEntries } from '@/engine/inspect';
import { attachLibrary, isLibraryFile } from '@/engine/library';
import { disposeFootageService } from '@/engine/footage';
import { disposeVisualService } from '@/engine/visual-footage';
import { attachProjectConfig, isProjectConfigFile } from '@/engine/project-config';
import { rememberProjectBundle } from '@/lib/db';
import { whenPointerIdle } from '@/lib/pointer-idle';
import { isCacheFile } from '@diffusionstudio/assets';
import { createEditWriter, flushProjectEdits, projectEditRevision, projectSaveState, recoverProjectEdits } from '@/projects/edits';
import { compileProject, isWindowsDesktop, refreshProject, watchProject } from '@/projects/host';
import { captureProjectCover } from '@/projects/cover';
import { useProject } from "@/context/project";
import { useEngineContext } from "@/engine";
import { ProjectSafety } from '@/components/project-safety';
import { EditorTools } from '@/components/editor-tools';
import { PlaybackProxyStatus } from '@/components/playback-proxy-status';
import { disposePlaybackProxyService } from '@/engine/playback-proxy';

import type { Mount } from '@diffusionstudio/reconciler';
import type { EditWriter } from '@/projects/edits';

const MIN_CANVAS_HEIGHT = 200;
const INSPECTOR_WIDTH = 264;

export function EditorPage() {
  const { uiVisible, timelineMinimized, timelineHeight, setTimelineHeight, projectPanelHeight, setProjectPanelHeight } = useLayout();
  const [resizing, setResizing] = createSignal(false);
  const project = useProject();
  const world = useWorld();
  const engine = useEngineContext();
  const { exportScene, exporting } = useExport();
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [conversationWidth, setConversationWidth] = createSignal(360);
  const [resizingConversation, setResizingConversation] = createSignal(false);
  const [footageOpened, setFootageOpened] = createSignal(false);
  createEffect(() => {
    if (projectTab() === "footage") setFootageOpened(true);
  });
  onMount(() => setSidebarTab("chat"));

  const handleExport = () => {
    const scene = getActiveEntity(world);
    if (!scene) {
      toast("Select a scene to export", { description: "Create or select a scene in your project, then export it as a video." });
      return;
    }
    void exportScene(scene);
  };

  let stopConversationResize: (() => void) | undefined;
  const handleConversationResize = (event: PointerEvent) => {
    event.preventDefault();
    const start = event.clientX;
    const width = conversationWidth();
    stopConversationResize?.();
    setResizingConversation(true);
    const move = (next: PointerEvent) => {
      const maximum = Math.max(280, Math.min(560, window.innerWidth - 600));
      setConversationWidth(Math.max(280, Math.min(maximum, width + next.clientX - start)));
    };
    const stop = () => {
      setResizingConversation(false);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      stopConversationResize = undefined;
    };
    stopConversationResize = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  };
  onCleanup(() => stopConversationResize?.());

  // The divider under the agent: dragging it up gives the project panel more of the column.
  const [resizingProject, setResizingProject] = createSignal(false);
  let stopProjectResize: (() => void) | undefined;
  const handleProjectResize = (event: PointerEvent) => {
    event.preventDefault();
    const column = (event.currentTarget as HTMLElement).parentElement!;
    const start = event.clientY;
    const height = projectPanelHeight();
    stopProjectResize?.();
    setResizingProject(true);
    const move = (next: PointerEvent) => {
      const maximum = Math.max(MIN_PROJECT_PANEL_HEIGHT, column.clientHeight - 220);
      setProjectPanelHeight(Math.round(Math.max(MIN_PROJECT_PANEL_HEIGHT, Math.min(maximum, height - (next.clientY - start)))));
    };
    const stop = () => {
      setResizingProject(false);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      stopProjectResize = undefined;
    };
    stopProjectResize = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  };
  onCleanup(() => stopProjectResize?.());

  // Everything below holds the folder's path — the watcher, the library, the
  // writer — and is torn down with the editor.
  createEffect(() => {
    const dir = project.dir();
    if (!dir) return;

    let mounted: Mount | undefined;
    let mountedCode: string | undefined;
    let writer: EditWriter | undefined;
    let unlisten: (() => void) | undefined;
    // A drag asks on every pointer move; the refusal is said once.
    let lastRefusal = 0;
    let disposed = false;
    let generation = 0;

    // The library first: a mounted project's `src` values name its assets.
    const library = attachLibrary(world, dir);
    // The project's own settings (package.json `diffusion`), next to the scene.
    const config = attachProjectConfig(world, dir, false);

    const unmount = (): void => {
      // Before the entities go: what the editor changed is still owed to the
      // file, whatever happens to the scene that showed it.
      unlisten?.();
      unlisten = undefined;
      writer?.dispose();
      writer = undefined;
      mounted?.dispose();
      mounted = undefined;
      mountedCode = undefined;
      // The entries hold the dead mount's signals; the inspector must not.
      setInspectEntries(world, []);
    };

    /** Puts `code` on the stage, unless it is what is there already. */
    const applyBundle = (code: string): void => {
      if (code === mountedCode) return;

      // An edit to the file is usually a small one: bring the stage up to date
      // where it stands, so playback, the selection and the undo history carry
      // on. Only what that cannot do takes the stage down and puts it up again.
      if (mounted && mountedCode !== undefined) {
        const outcome = applyExternalEdit(world, mounted, code);
        if (outcome.applied) {
          mountedCode = code;
          console.debug(`[projects] updated the project in place (${outcome.changes} changes${outcome.undoable ? '' : ', not a step in the history'})`);
          return;
        }
        console.info('[projects] mounted the project again:', outcome.reason);
      }

      // The old render goes first: there is only one stage per world.
      unmount();
      mounted = mount(code, world);
      mountedCode = code;
      // The `@inspect` variables this mount declared, for the inspector.
      setInspectEntries(world, mounted.inspect);
      // The rendered scene knows which element every entity came from, so
      // from here on an edit in the editor can find its way back.
      writer = createEditWriter(dir, world);
      const editor = getDocumentEditor(world);
      const stopWriting = editor.onWrite((edit) => writer?.push(edit));
      const stopRefusing = editor.onRefuse(() => {
        const now = Date.now();
        if (now - lastRefusal < 3000) return;
        lastRefusal = now;
        toast.error("This can't be edited by hand", { description: "The project's code generates it from a list, so one edit would change every copy. Ask the agent to change it." });
      });
      unlisten = () => { stopWriting(); stopRefusing(); };
      // A mount comes from the file: edits recorded against the document it
      // replaced cannot be replayed against this one.
      getEditHistory(world).reset();
    };

    const loadProject = async (): Promise<void> => {
      const current = ++generation;
      const readiness = beginEditorLoad(world);
      try {
        // Recover unsent/in-flight edits before reading source. On later reloads,
        // await the live writer so remount cannot discard a failed save.
        if (current === 1) await recoverProjectEdits(dir);
        else await flushProjectEdits(dir);
        if (disposed || current !== generation) return;
        const editRevision = projectEditRevision(dir);
        // Main finishes interrupted source/version transactions during compile.
        // Only read the manifest/settings afterwards: a cached mount or an
        // earlier read could otherwise show a mix of pre/post-recovery files.
        const result = await compileProject(dir);
        if (disposed || current !== generation) return;
        await Promise.all([library.load(), config.load()]);
        if (disposed || current !== generation) return;

        // A broken edit keeps the last good render on the canvas.
        if (!result.ok) {
          readiness.fail(new Error(`Project failed to compile: ${result.error}`));
          console.error('[projects] compile failed:', result.error);
          toast.error('Project failed to compile', { description: result.error });
          return;
        }

        // A drag holds the entities it moves; what the file changed waits for it to end.
        await whenPointerIdle();
        if (disposed || current !== generation) return;

        try {
          // A compile may have overlapped a new gesture. Start a fresh compile
          // after that gesture reaches disk, rather than remounting stale code.
          if (projectSaveState(dir).status !== 'saved' || projectEditRevision(dir) !== editRevision) {
            await flushProjectEdits(dir);
            if (!disposed && current === generation) await loadProject();
            return;
          }
          applyBundle(result.code);
          // Publish usable scene identities and authored timing before an `open`
          // reply. Asset resolution starts normally; unavailable/slow media stays
          // repairable without holding the route open for decoding or analysis.
          assetSystem(world);
          transformSystem(world);
          readiness.ready();
          // What an export renders a second time, and the next open's head
          // start (see `rememberProjectBundle`) — recorded only once it has
          // actually mounted, so the record never runs ahead of the canvas.
          rememberProjectBundle(untrack(project.id), result.code).catch((error) =>
            console.error('[projects] could not save the bundle', error));
        } catch (error) {
          readiness.fail(error);
          console.error('[projects] render failed:', error);
          toast.error('Project failed to render', { description: (error as Error).message });
        }
      } catch (error) {
        readiness.fail(error);
        throw error;
      }
    };

    const load = (): void => {
      loadProject().catch((error) => {
        console.error('[projects] load failed:', error);
        toast.error('Project failed to load', { description: (error as Error).message });
      });
    };

    load();
  
    // A burst arrives as the whole set of files it touched, so a checkout that
    // rewrites the library and the sources at once reloads both — reading only
    // the last path of a burst would answer for one of them and drop the rest.
    const unwatch = watchProject(dir, (paths) => {
      const changed = paths.filter((path) => !isCacheFile(path));
      if (changed.some(isLibraryFile)) void library.load().catch((error) =>
        toast.error('Could not reload the media library', { description: (error as Error).message }));

      const source = changed.filter((path) => !isLibraryFile(path));
      if (!source.length) return;
      // package.json is the config and the record (`main`, `displayName`)
      // in one, so a hand edit to it reloads both; the app's own config
      // writes never reach here (main keeps them from the watcher).
      if (source.some(isProjectConfigFile)) {
        void config.load().catch((error) =>
          toast.error('Could not reload project settings', { description: (error as Error).message }));
        project.refresh();
      }
      load();
    });

    onCleanup(() => {
      disposed = true;
      disposeFootageService(world, dir);
      disposeVisualService(world, dir);
      disposePlaybackProxyService(world, dir);
      captureProjectCover(dir, engine.snapshot());
      refreshProject(dir);
      unwatch();
      unmount();
      config.dispose();
      void library.dispose().catch((error) => console.error('Media library changes remain unsaved:', error));
    });
  });

  const timelineStyles = createMemo(() => {
    if (!uiVisible()) return { 'grid-template-columns': '1fr', 'grid-template-rows': '1fr' };
    const height = timelineMinimized() ? RULER_HEIGHT : timelineHeight();
    return {
      'grid-template-columns': `34px 184px 1px minmax(0, 1fr)${inspectorOpen() ? ` ${INSPECTOR_WIDTH}px` : ""}`,
      'grid-template-rows': `minmax(0, 1fr) 1px ${height}px`,
    };
  });

  const handleResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = timelineHeight();
    setResizing(true);

    const handleMove = (ev: PointerEvent) => {
      const deltaY = startY - ev.clientY;
      const maxHeight = Math.max(
        MIN_TIMELINE_HEIGHT,
        window.innerHeight - MIN_CANVAS_HEIGHT - 53,
      );
      const next = Math.max(MIN_TIMELINE_HEIGHT, Math.min(maxHeight, startHeight + deltaY));
      setTimelineHeight(next);
    };

    const handleEnd = () => {
      setResizing(false);
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleEnd);
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleEnd);
  };

  return (
    <div class="cutroom-app flex h-screen w-full min-h-0 flex-col overflow-hidden pt-(--titlebar-height)">
      <EditorTitleBar leftWidth={240} controlsWidth={INSPECTOR_WIDTH + 1} />
      <Show when={uiVisible()}>
        <TopBar
          projectId={project.id()}
          center={<WorkspaceTabs />}
          end={
            <>
              <ProjectSafety />
              <EditorTools />
              <button type="button" aria-label={inspectorOpen() ? "Hide inspector" : "Show inspector"} title={inspectorOpen() ? "Hide inspector" : "Show inspector"} class="cutroom-topnav-item cutroom-topnav-icon" onClick={() => setInspectorOpen((open) => !open)}><Icon name="settings" /></button>
              <button type="button" class="cutroom-editor-export" disabled={exporting()} onClick={handleExport}>Export</button>
            </>
          }
        >
          <span class="cutroom-topbar-rule" aria-hidden="true" />
          <ProjectNameInput class="cutroom-topbar-name w-auto field-sizing-content" />
          <DraftBadge />
          <SceneSwitch />
        </TopBar>
      </Show>
      <div class="flex min-h-0 flex-1">
      <Show when={uiVisible()}>
        <section class="cutroom-conversation" aria-label="Project conversation" style={{ width: `${conversationWidth()}px` }}>
          <div class="cutroom-panel cutroom-panel-agent"><ChatPanel /></div>
          <div
            role="separator"
            aria-label="Resize project panel"
            aria-orientation="horizontal"
            class="cutroom-row-resizer"
            classList={{ "is-resizing": resizingProject() }}
            onPointerDown={handleProjectResize}
          />
          <div class="cutroom-panel cutroom-panel-project" style={{ height: `${projectPanelHeight()}px` }}>
            <div classList={{ contents: projectTab() === "assets", hidden: projectTab() !== "assets" }}><Assets /></div>
            <Show when={footageOpened()}>
              <div classList={{ contents: projectTab() === "footage", hidden: projectTab() !== "footage" }}><Footage /></div>
            </Show>
          </div>
        </section>
        <div
          role="separator"
          aria-label="Resize conversation"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={560}
          aria-valuenow={conversationWidth()}
          tabIndex={0}
          class="cutroom-column-resizer"
          classList={{ "is-resizing": resizingConversation() }}
          onPointerDown={handleConversationResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setConversationWidth((width) => Math.max(280, Math.min(560, width + (event.key === "ArrowRight" ? 16 : -16))));
          }}
        />
      </Show>
      <main class="cutroom-editor-workspace">
        <div class="cutroom-editor-grid" style={timelineStyles()}>
          <div class="cutroom-editor-canvas" style={{ "grid-column": uiVisible() ? "1 / 5" : "1" }}><Canvas /><div class="absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)]"><PlaybackProxyStatus paused={exporting()} /></div></div>
          <Show when={uiVisible() && inspectorOpen()}>
            <div class="cutroom-editor-inspector"><Inspector /></div>
          </Show>
          <Show when={uiVisible()}>
            <div class="col-span-full bg-border relative">
              <Show when={!timelineMinimized()}>
                <div class="absolute left-0 right-0 -top-px h-1 z-10 cursor-ns-resize group" onPointerDown={handleResizeStart}>
                  <div class="absolute left-0 right-0 top-px h-px transition-colors group-hover:bg-primary" classList={{ 'bg-primary': resizing() }} />
                </div>
              </Show>
            </div>
            <TimelineTools />
            <Layers />
            <div class="bg-border" />
            <Timeline />
            <Show when={inspectorOpen()}>
              <div class="cutroom-editor-inspector"><Show when={!timelineMinimized()}><Soundboard /></Show></div>
            </Show>
          </Show>
        </div>
      </main>
      </div>
      <Show when={!uiVisible() && !isWindowsDesktop()}><FloatingProjectHeader /></Show>
    </div>
  );
}
