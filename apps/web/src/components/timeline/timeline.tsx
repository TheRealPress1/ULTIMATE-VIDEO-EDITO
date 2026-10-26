/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { onCleanup, onMount } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { FrameRate, framesToSeconds } from '@diffusionstudio/runtime';
import { droppedFiles, importFiles, insertAssetsInTimeline } from '@/engine/asset-actions';
import { useLibrary } from '@/engine/library';
import { useTimeline } from '@/context/timeline';
import { ASSET_DRAG_TYPE } from '@/components/sidebar-left/folder-item';
import { NodeContextMenu, TIMELINE_MENU } from '@/components/commands';

/**
 * The timeline's canvas. What is drawn on it is the timeline system's
 * business (see `@/engine/timeline`); this is the element it draws on and
 * what dropping an asset onto it means.
 */
export function Timeline() {
  const world = useWorld();
  const timeline = useTimeline();
  const library = useLibrary();

  onMount(() => timeline.attachCanvas());
  onCleanup(() => timeline.detachCanvas());

  /**
   * Assets dropped on the timeline start where they were dropped, unlike
   * ones dropped on the canvas, which start at the playhead: the whole point
   * of aiming at a place on the timeline is to say when.
   *
   * Video clips follow one another in selection order; audio starts at the
   * drop position. With no scene active, the first clip sets its format.
   */
  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const lib = library();
    if (!lib) return;

    const fps = world.get(FrameRate)?.value ?? 30;
    const start = framesToSeconds(Math.max(0, timeline.clientToFrame(event.clientX)), fps);

    // Read the transfer before the first await: it is gone by the time an
    // import resolves.
    const ids = event.dataTransfer?.getData(ASSET_DRAG_TYPE)?.split(',').filter(Boolean) ?? [];
    const files = droppedFiles(event);

    const assets = ids.map((id) => lib.get(id)).filter((asset) => asset != null);
    if (files.length) assets.push(...await importFiles(lib, files, ''));
    if (!assets.length) return;

    insertAssetsInTimeline(world, assets, start);
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
  };

  return (
    <NodeContextMenu class="relative size-full" layout={TIMELINE_MENU} pick={timeline.nodesAt}>
      <canvas
        class="absolute inset-0"
        id="timeline-canvas"
        on:drop={handleDrop}
        on:dragover={handleDragOver}
      />
    </NodeContextMenu>
  );
}
