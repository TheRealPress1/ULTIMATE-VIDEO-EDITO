/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, Show } from 'solid-js';
import { useTag, useTrait, useWorld } from '@diffusionstudio/koota-solid';
import {
  ClipHeight,
  Expanded,
  Hidden,
  Hovering,
  Locked,
  Muted,
  Name,
  Selected,
  Soloed,
  findGeometryAsset,
  isAdjustmentLayer,
  isCaption,
  isGroup,
  isClipShape,
  isEllipse,
  isPath,
  isPolygon,
  isScene,
  isSequence,
  isText,
} from '@diffusionstudio/runtime';
import { Icon } from '@/components/ui/icon';
import { NodeContextMenu, TIMELINE_MENU } from '@/components/commands';
import { useEditor } from '@/engine/hooks';
import { toggleSoloed as toggleEntitySoloed } from '@/engine/input/shortcuts';
import { trackCapabilities } from '@/engine/track-capabilities';
import { DEFAULT_CLIP_HEIGHT, MAX_CLIP_HEIGHT, MIN_CLIP_HEIGHT, getClipFallbackName } from '@/engine/timeline';
import { NESTED_INDENT_PX } from './config';
import { useLayerContext } from './context';
import { setRowHover } from './hover';
import { TrackSlot, TrackToggle } from './track-toggle';

import type { World } from 'koota';
import type { TimelineNode } from '@diffusionstudio/runtime';
import type { LayerRowProps } from './layer';

export function NodeLayer(props: LayerRowProps) {
  const world = useWorld();
  const editor = useEditor();

  const entity = () => props.layer.entity;

  const clipHeight = useTrait(entity, ClipHeight);
  const height = () => clipHeight()?.value ?? DEFAULT_CLIP_HEIGHT;

  const muted = useTag(entity, Muted);
  const soloed = useTag(entity, Soloed);
  const hidden = useTag(entity, Hidden);
  const locked = useTag(entity, Locked);
  const hovering = useTag(entity, Hovering);
  const selected = useTag(entity, Selected);
  // The rows that are tracks of the scene carry their switches always, as a header does; the rows below them, on hover.
  const nested = () => props.depth > 0;
  const anyOn = () => muted() || soloed() || hidden() || locked();
  const controlsVisible = createMemo(() => !nested() || hovering() || anyOn());
  // What there is on the row to switch: the eye for a picture, the mute and the solo for a sound.
  const capabilities = createMemo(() => trackCapabilities(world, entity()));

  const { resized: resizedSignal, drag } = useLayerContext();
  const [resized, setResized] = resizedSignal;

  const [editing, setEditing] = createSignal(false);
  let originalName = '';

  const nameTrait = useTrait(entity, Name);
  const name = createMemo(() => nameTrait()?.value || getClipFallbackName(world, entity()));
  const icon = createMemo(() => getLayerIcon(world, props.layer));

  const toggleMuted = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'muted', !muted());
  };

  const toggleHidden = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'hidden', !hidden());
  };

  const toggleExpanded = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'expanded', !entity().has(Expanded));
  };

  /**
   * Solo is monitoring rather than composition — it says what you want to
   * hear right now, which the file has nothing to say about — so it is the
   * trait and not an edit; a track, or any number of them, can hold it.
   */
  const toggleSoloed = (e?: Event) => {
    e?.stopPropagation();
    toggleEntitySoloed(entity());
  };

  const toggleLocked = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'locked', !locked());
  };

  /**
   * A press on a row selects it, shift-clicking to extend the selection. A
   * plain press also arms a drag: moving far enough turns the press into
   * dragging the layer to a new place in the tree.
   */
  const handleRowPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || resized() !== null) return;
    if ((e.target as HTMLElement | null)?.closest('button')) return;

    editor.select(entity(), { extend: e.shiftKey });
    if (!e.shiftKey) drag.begin(e, entity());
  };

  let resizeStartY = 0;
  let resizeStartHeight = 0;

  const handleResizeMove = (e: PointerEvent) => {
    const next = Math.max(MIN_CLIP_HEIGHT, Math.min(MAX_CLIP_HEIGHT, resizeStartHeight + e.clientY - resizeStartY));
    editor.editProperty(entity(), 'clipHeight', next);
  };

  const handleResizeEnd = () => {
    setResized(null);
    document.removeEventListener('pointermove', handleResizeMove);
    document.removeEventListener('pointerup', handleResizeEnd);
  };

  const handleResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartY = e.clientY;
    resizeStartHeight = height();
    setResized(entity());

    document.addEventListener('pointermove', handleResizeMove);
    document.addEventListener('pointerup', handleResizeEnd);
  };

  const startEditing = () => {
    originalName = name();
    setEditing(true);
  };

  const finishEditing = (input: HTMLInputElement) => {
    if (!editing()) return;
    // An empty name is not a name; the row falls back to what it had.
    if (!input.value.trim()) editor.editProperty(entity(), 'name', originalName);
    setEditing(false);
  };

  const handleNameInput = (e: InputEvent) => {
    editor.editProperty(entity(), 'name', (e.currentTarget as HTMLInputElement).value);
  };

  const handleNameKeyDown = (e: KeyboardEvent) => {
    // The canvas is listening for keys; a name being typed is not a shortcut.
    e.stopPropagation();
    const input = e.currentTarget as HTMLInputElement;

    if (e.key === 'Escape') {
      editor.editProperty(entity(), 'name', originalName);
      input.blur();
    } else if (e.key === 'Enter') {
      input.blur();
    }
  };

  const mountNameInput = (input: HTMLInputElement) => {
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  };

  return (
    <NodeContextMenu
      layout={TIMELINE_MENU}
      pick={() => [entity()]}
      data-layer-row
      class="w-full text-muted-foreground group relative select-none"
      onPointerEnter={() => setRowHover(world, entity())}
      onPointerLeave={() => setRowHover(world, null)}
      onPointerDown={handleRowPointerDown}
      classList={{
        'bg-accent': selected(),
        'bg-accent/70': !selected() && hovering() && resized() === null && drag.dragging() === null,
        'bg-accent/40': !selected() && !(hovering() && resized() === null) && props.ancestorSelected,
        'opacity-60': drag.dragging() === entity(),
      }}
      style={{ height: height() + 'px' }}
    >
      <div class="w-full pl-0.5 pr-2 flex items-center justify-between h-full">
        <div
          data-layer-label
          class="flex-1 min-w-0 overflow-hidden"
          style={{
            'mask-image': controlsVisible() && !editing() ? 'linear-gradient(to right, #000 calc(100% - 1.25rem), transparent)' : undefined,
            '-webkit-mask-image': controlsVisible() && !editing() ? 'linear-gradient(to right, #000 calc(100% - 1.25rem), transparent)' : undefined,
          }}
        >
          <div
            class="flex items-center gap-0.5 w-max"
            style={{
              'padding-left': `${props.depth * NESTED_INDENT_PX}px`,
              transform: editing() ? 'none' : 'translateX(calc(var(--layer-x, 0px) * -1))',
            }}
          >
            <button
              disabled={!props.layer.expandable}
              onClick={toggleExpanded}
              class="size-4 shrink-0 flex items-center justify-center overflow-clip invisible group-hover/layers:visible focus-ring rounded-sm"
            >
              <Show when={props.layer.expandable}>
                <Icon name={props.expanded ? "chevron-down" : "chevron-right"} class="hover:text-foreground" />
              </Show>
            </button>
            <div class="size-4 shrink-0 flex items-center justify-center overflow-clip mr-0.5">
              <Icon name={icon()} />
            </div>
            <Show
              when={editing()}
              fallback={
                <span class="text-xs px-0.5 shrink-0 whitespace-nowrap text-foreground" onDblClick={startEditing}>
                  {name()}
                </span>
              }
            >
              <input
                ref={mountNameInput}
                type="text"
                class="text-xs bg-input border border-primary rounded-sm outline-none px-0.5 w-32 text-foreground"
                value={name()}
                onInput={handleNameInput}
                onKeyDown={handleNameKeyDown}
                onBlur={(e) => finishEditing(e.currentTarget)}
                onPointerDown={(e) => e.stopPropagation()}
                onDblClick={(e) => e.stopPropagation()}
              />
            </Show>
          </div>
        </div>

        <div
          class="items-center flex gap-0.5 shrink-0 pl-1"
          classList={{
            'hidden': resized() !== null,
            'w-0 overflow-hidden group-hover:w-auto': nested() && !anyOn(),
          }}
        >
          <Show when={capabilities().visual} fallback={<TrackSlot />}>
            <TrackToggle label={hidden() ? 'Show' : 'Hide'} on={hidden()} reveal={nested()} onClick={toggleHidden}>
              <Icon name={hidden() ? 'eye-off' : 'eye-on'} />
            </TrackToggle>
          </Show>
          <Show when={capabilities().audio} fallback={<><TrackSlot /><TrackSlot /></>}>
            <TrackToggle label={muted() ? 'Unmute' : 'Mute'} on={muted()} reveal={nested()} onClick={toggleMuted}>
              <span class="text-[11px] font-semibold leading-none">M</span>
            </TrackToggle>
            <TrackToggle label={soloed() ? 'Unsolo' : 'Solo (heard in preview only)'} tone="solo" on={soloed()} reveal={nested()} onClick={toggleSoloed}>
              <span class="text-[11px] font-semibold leading-none">S</span>
            </TrackToggle>
          </Show>
          <TrackToggle label={locked() ? 'Unlock' : 'Lock'} on={locked()} reveal={nested()} onClick={toggleLocked}>
            <Icon name={locked() ? 'lock-closed' : 'lock-open'} />
          </TrackToggle>
        </div>
      </div>

      {/* Drag the bottom edge to make the row taller. */}
      <div
        class="absolute bottom-0 left-0 right-0 h-[3px] cursor-ns-resize translate-y-0.5 z-20 group/resize"
        onPointerDown={handleResizeStart}
      >
        <div
          class="absolute left-0 right-0 top-px h-px transition-colors group-hover/resize:bg-primary"
          classList={{ 'bg-primary': resized() === entity() }}
        />
      </div>
    </NodeContextMenu>
  )
}

function getLayerIcon(world: World, layer: TimelineNode) {
  const entity = layer.entity;

  if (isClipShape(entity)) return "mask-small";
  if (isAdjustmentLayer(entity)) return "adjustment-layer";
  if (isScene(entity)) return "scene-frame-small";
  if (isSequence(entity)) return "timeline-sequence-small";
  if (isGroup(entity)) return "group";
  if (isCaption(entity)) return "captions-small";
  if (isText(entity)) return "text-small";
  if (isEllipse(entity)) return "tool.ellipse-small";
  if (isPolygon(entity)) return "tool.polygon-small";
  if (isPath(entity)) return "vector-path";

  switch (findGeometryAsset(world, entity)?.type) {
    case 'IMAGE':
      return "image-small";
    case 'VIDEO':
    case 'SEQUENCE':
    case 'MASK':
      return "video-small";
    case 'AUDIO':
      return "audio-small";
    default:
      return "rectangle-small";
  }
}
