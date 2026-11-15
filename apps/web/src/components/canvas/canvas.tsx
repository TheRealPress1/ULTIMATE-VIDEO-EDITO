/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createComputed, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { findSceneAt, getCameraMatrix, screenToWorld, setCamera, setCameraMatrix, setSolo, worldToLocal, Library, Position, Root, Size } from "@diffusionstudio/runtime";
import { CameraController, EngineCanvas, nodesAt, panBy } from "@/engine";
import { useActiveScene } from "@/engine/hooks";
import { setEditingMode } from "@/engine/timeline/tool";
import { useLayout } from "@/context/layout";
import { insertAsset } from "@/engine/insert-asset";
import { droppedFiles, importFiles, importPaths } from "@/engine/asset-actions";
import { droppedMediaPaths } from "@/components/sidebar-left/media-browser-data";
import { Toolbar } from "./toolbar";
import { CanvasCommands, NodeContextMenu } from "@/components/commands";
import { DesktopAppBanner } from "./desktop-app-banner";
import { toast } from "somoto"
import { SceneInitOverlay } from "./scene-init-overlay";
import { MonitorBar } from "./monitor-bar";
import { ASSET_DRAG_TYPE } from "@/components/sidebar-left/folder-item";

import type { Asset } from "@diffusionstudio/assets";
import type { CameraMatrix } from "@diffusionstudio/runtime";

/** Space left around the scene in the program monitor, in CSS pixels. */
const MONITOR_MARGIN = 10;

export function Canvas() {
  const world = useWorld();
  const { uiVisible, workspace } = useLayout();
  const scene = useActiveScene();
  const sceneSize = useTrait(scene, Size);
  const scenePosition = useTrait(scene, Position);
  let container!: HTMLDivElement;

  /**
   * The Edit workspace shows the active scene alone, as a program monitor:
   * the frame takes the scene's aspect ratio inside the area, and the camera is
   * fitted to it, so the scenes beside it fall outside the canvas and are not
   * drawn. That camera is the monitor's own and is never written to the
   * project, which keeps the Board's view; leaving the Edit workspace puts the
   * Board's camera back.
   */
  const [area, setArea] = createSignal({ width: 0, height: 0 });
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setArea({ width: entry!.contentRect.width, height: entry!.contentRect.height }));
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  const frame = createMemo(() => {
    const size = sceneSize();
    const { width, height } = area();
    if (workspace() !== "edit" || !scene() || !size || !(size.width > 0) || !(size.height > 0) || !(width > 0) || !(height > 0)) return null;
    const fit = Math.min((width - 2 * MONITOR_MARGIN) / size.width, (height - 2 * MONITOR_MARGIN) / size.height);
    if (!(fit > 0)) return null;
    // Whole pixels, rounded down, with the zoom that covers them: the frame never reaches past the scene's edge, where the next scene would show.
    const frameWidth = Math.max(1, Math.floor(size.width * fit));
    const frameHeight = Math.max(1, Math.floor(size.height * fit));
    return { width: frameWidth, height: frameHeight, zoom: Math.max(frameWidth / size.width, frameHeight / size.height) };
  });
  const monitor = () => frame() !== null;
  // The engine's keys need to know whether this is the Edit workspace (see `isEditing`).
  createEffect(() => setEditingMode(world, workspace() === "edit"));

  // Scenes can overlap on the stage, so the camera alone does not keep the others out of the frame: the monitor shows its scene alone.
  createEffect(() => setSolo(world, monitor() ? scene() : null));
  onCleanup(() => setSolo(world, null));

  let boardCamera: CameraMatrix | null = null;
  createComputed(on(monitor, (isMonitor, wasMonitor) => {
    if (isMonitor && !wasMonitor) boardCamera = getCameraMatrix(world);
    else if (!isMonitor && wasMonitor && boardCamera) {
      setCameraMatrix(world, boardCamera);
      boardCamera = null;
    }
  }));
  const fitCamera = () => {
    const fit = frame();
    const at = scenePosition();
    if (fit && at) setCamera(world, { a: fit.zoom, b: 0, c: 0, d: fit.zoom, e: -at.x * fit.zoom, f: -at.y * fit.zoom });
  };
  createEffect(fitCamera);
  // Other code moves the camera to what it has just made (a new scene, a reframe, a cut): the monitor's fit is held every frame.
  onMount(() => {
    let frameId = 0;
    const hold = () => {
      frameId = requestAnimationFrame(hold);
      const fit = frame();
      const at = scenePosition();
      if (!fit || !at) return;
      const [a, b, c, d, e, f] = getCameraMatrix(world);
      if (Math.abs(a - fit.zoom) > 1e-6 || Math.abs(d - fit.zoom) > 1e-6 || b !== 0 || c !== 0 || Math.abs(e + at.x * fit.zoom) > 1e-3 || Math.abs(f + at.y * fit.zoom) > 1e-3) fitCamera();
    };
    frameId = requestAnimationFrame(hold);
    onCleanup(() => cancelAnimationFrame(frameId));
  });

  /**
   * Showing or hiding the panels moves the canvas's corner across the
   * screen; the camera moves back by as much, so what is drawn stays where it
   * was. The computed runs before Solid applies the toggle to the DOM, so it
   * reads where the canvas was; the effect runs after, and reads where it is
   * now. The grid snaps rather than animates, so the new place is final.
   */
  let before!: DOMRect;
  createComputed(on(uiVisible, () => (before = container.getBoundingClientRect()), { defer: true }));
  createEffect(on(uiVisible, () => {
    if (monitor()) return;
    const after = container.getBoundingClientRect();
    const dx = after.left - before.left;
    const dy = after.top - before.top;
    if (dx || dy) panBy(world, dx, dy);
  }, { defer: true }));

  /**
   * Drops onto the canvas: library assets (dragged from the panel) land where
   * they were dropped, in the scene under the pointer; external files are
   * imported into the library first, then land the same way.
   *
   * With no scene under the pointer they land loose on the stage, like an
   * element drawn there (see `@/engine/draw-tool`): the drop says where, so the active
   * scene — which is somewhere else entirely — is not the answer.
   */
  const handleDropEvent = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const library = world.get(Library);
    if (!library) return;

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const worldPt = screenToWorld(world, event.clientX - rect.left, event.clientY - rect.top);
    const scene = findSceneAt(world, worldPt.x, worldPt.y);
    const parent = scene ?? world.get(Root)!;
    const localPt = scene ? worldToLocal(world, scene, worldPt.x, worldPt.y) : worldPt;

    const place = (asset: Asset) => {
      const size = 'width' in asset && 'height' in asset ? { width: asset.width, height: asset.height } : { width: 500, height: 150 };
      const placed = insertAsset(world, asset, {
        parent,
        x: localPt.x - size.width / 2,
        y: localPt.y - size.height / 2,
      });
      if (!placed) toast("Nothing to insert into", { description: "Open a project first." });
    };

    const assetIds = event.dataTransfer?.getData(ASSET_DRAG_TYPE)?.split(',').filter(Boolean) ?? [];
    for (const id of assetIds) {
      const asset = library.get(id);
      if (asset) place(asset);
    }

    const files = droppedFiles(event);
    const paths = droppedMediaPaths(event.dataTransfer);
    if (files.length) {
      for (const asset of await importFiles(library, files, '')) place(asset);
    }
    if (paths.length) {
      for (const asset of await importPaths(library, paths, '')) place(asset);
    }
  }

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div class="flex size-full flex-col bg-background" classList={{ "cutroom-program": monitor() }}>
      <div ref={container} class="relative min-h-0 flex-1">
        <div
          class="absolute inset-0"
          on:drop={handleDropEvent}
          on:dragover={handleDragOver}
        >
          <Show when={!monitor()}><Toolbar /></Show>
          <CanvasCommands />
          <DesktopAppBanner />
          <div
            class={monitor() ? "cutroom-program-frame" : "size-full"}
            style={frame() ? { left: `${(area().width - frame()!.width) / 2}px`, top: `${(area().height - frame()!.height) / 2}px`, width: `${frame()!.width}px`, height: `${frame()!.height}px` } : undefined}
          >
            <NodeContextMenu class="size-full" pick={(event) => nodesAt(world, event)}>
              <EngineCanvas />
              <SceneInitOverlay />
            </NodeContextMenu>
          </div>
          <Show when={!monitor()}><CameraController /></Show>
        </div>
      </div>
      <Show when={monitor()}><MonitorBar /></Show>
    </div>
  );
}
