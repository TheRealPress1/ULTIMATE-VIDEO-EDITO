/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AdjustmentLayer, Audio, Cache, Caption, Computed, FrameRate, Geometry,
  Group, Hidden, Opacity, PaintType, Scene, Sequential, Source,
  SourceError, Workarea, framesToSeconds, getIntrinsicPaint, getParentEntity,
  isClipPath, isMaskContainer, isText,
} from "@diffusionstudio/runtime";

import { resolveNode } from "../lib/nodes";
import { betweenCutsOfOneRecording, canvasBounds, inheritLook, shortVisibleStretches, stretchLayer, visibleStretches } from "@/engine/visible-stretches";

import type { CheckIssue } from "@diffusionstudio/dapi";
import type { Entity, World } from "koota";
import type { Bounds, InheritedLook, StretchLayer } from "@/engine/visible-stretches";
import type { ToolHandler } from "../handler";

// Absolute frames, [start, end).
type Interval = { start: number; end: number };

function kindOf(entity: Entity): string {
  const parent = getParentEntity(entity);
  if (parent && isMaskContainer(parent)) return isClipPath(parent) ? "clip-path" : "mask";
  if (entity.has(Scene)) return "scene";
  if (entity.has(Group)) return entity.has(Sequential) ? "sequence" : "group";
  if (entity.has(AdjustmentLayer)) return "adjustment-layer";
  if (entity.has(Audio)) return "audio";
  if (entity.has(Caption)) return "caption";
  if (isText(entity)) return "text";
  switch (getIntrinsicPaint(entity)) {
    case PaintType.VIDEO: return "video";
    case PaintType.IMAGE: return "image";
    case PaintType.HTML: return "html";
    default: return "shape";
  }
}

// Whether the node itself puts pixels on screen. Containers don't (their
// leaves do), adjustment layers and the nodes of clip paths and masks only
// shape what others draw, and a scene's implicit background is exactly what a
// "black frame" looks like — so none of those count as coverage.
function drawsPixels(entity: Entity): boolean {
  return entity.has(Geometry)
    && !entity.has(Scene)
    && !entity.has(Group)
    && !entity.has(AdjustmentLayer)
    && !entity.has(Audio);
}

type WalkState = {
  nodes: number;
  byKind: Record<string, number>;
  depth: number;
  issues: CheckIssue[];
  coverage: Interval[];
  /** Frames→seconds on the checked node's own clock (capture --time's). */
  rel: (frames: number) => number;
  /** The scene canvas the visible-stretch pass measures against; null turns it off. */
  canvas: Bounds | null;
  /** Full-frame candidates in paint order, for the visible-stretch pass. */
  layers: StretchLayer[];
};

/**
 * One pass over the subtree: count, classify, surface per-node issues, and
 * collect the intervals where something actually draws. `window` is the
 * intersection of every ancestor's visible span — null once an ancestor is
 * hidden, transparent, or out of window, at which point nothing below can
 * contribute pixels (but still counts toward stats and per-node issues).
 */
function visit(world: World, entity: Entity, window: Interval | null, depth: number, state: WalkState, look: InheritedLook = { opacity: 1 }): void {
  state.nodes += 1;
  const kind = kindOf(entity);
  state.byKind[kind] = (state.byKind[kind] ?? 0) + 1;
  if (depth > state.depth) state.depth = depth;

  const stamp = entity.get(Source)?.value;
  const failure = entity.get(SourceError);
  if (failure) {
    state.issues.push({
      code: "source-error",
      severity: "error",
      node: stamp,
      message: `Source failed to load: ${failure.value}`,
    });
  }

  const computed = entity.get(Computed)!;
  let visible = window;

  if (computed.duration === 0) {
    state.issues.push({
      code: "zero-duration",
      severity: "warning",
      node: stamp,
      message: "Zero duration — the node never renders",
    });
    visible = null;
  }

  if (entity.has(Hidden)) visible = null;

  // A keyframed node may animate its opacity up from 0, so only a static 0
  // is called out (and dropped from coverage).
  const animated = (entity.get(Cache)?.keyframeTracks.length ?? 0) > 0;
  if (entity.get(Opacity)?.value === 0 && !animated) {
    state.issues.push({
      code: "transparent",
      severity: "warning",
      node: stamp,
      message: "Opacity is 0 — the node renders fully transparent",
    });
    visible = null;
  }

  if (visible !== null) {
    const start = Math.max(visible.start, computed.start);
    const end = Math.min(visible.end, computed.end);
    if (start >= end) {
      state.issues.push({
        code: "never-visible",
        severity: "warning",
        node: stamp,
        message: `Never visible — plays ${state.rel(computed.start)}s to ${state.rel(computed.end)}s, outside the window its ancestors play`,
      });
      visible = null;
    } else {
      visible = { start, end };
    }
  }

  // What this node hands down to the layers it holds, for the visible-stretch pass.
  const own = inheritLook(entity, look);
  if (visible !== null && drawsPixels(entity)) {
    state.coverage.push(visible);
    // Visiting order is paint order: a node draws before its children, and
    // a later sibling's subtree draws over an earlier one's.
    const layer = state.canvas && stretchLayer(world, entity, visible, own, state.canvas, state.layers.length, stamp);
    if (layer) state.layers.push(layer);
  }

  const cache = entity.get(Cache);
  for (const child of cache?.children ?? []) visit(world, child, visible, depth + 1, state, own);
  // The nodes of clip paths and masks are worth counting and checking, but
  // they add no pixels.
  const containers = [
    ...cache?.clipPaths ?? [],
    ...cache?.masks ?? [],
    ...(cache?.effects ?? []).flatMap((effect) => effect.get(Cache)?.masks ?? []),
  ];
  for (const container of containers) {
    for (const child of container.get(Cache)?.children ?? []) {
      visit(world, child, null, depth + 1, state);
    }
  }
}

/** The spans of `window` no coverage interval touches. */
function findGaps(window: Interval, coverage: Interval[]): Interval[] {
  const sorted = [...coverage].sort((a, b) => a.start - b.start);
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const { start, end } of sorted) {
    if (start > cursor) gaps.push({ start: cursor, end: Math.min(start, window.end) });
    cursor = Math.max(cursor, end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  // Sub-frame slivers are rounding, not black frames.
  return gaps.filter((gap) => gap.end - gap.start >= 1);
}

/** The scene `entity` draws into: itself, or its nearest scene ancestor. */
function sceneOf(entity: Entity): Entity | null {
  for (let node: Entity | null = entity; node; node = getParentEntity(node)) if (node.has(Scene)) return node;
  return null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export const check: ToolHandler<"check"> = async ({ id, minVisibleSeconds = 0.4 }, ctx) => {
  const { world } = ctx.requireSession();
  const target = resolveNode(world, id);
  const fps = world.get(FrameRate)?.value ?? 30;

  const computed = target.get(Computed)!;

  // The span the node actually plays: its bounds, narrowed by a workarea
  // when one is set (workarea frames count from the node's start, the way
  // the encoder and playback read them).
  let window: Interval = { start: computed.start, end: computed.end };
  const workarea = target.get(Workarea);
  if (workarea) {
    const start = Math.min(computed.end, computed.start + Math.max(0, workarea.start));
    const end = Math.max(start, Math.min(computed.end, workarea.end ? computed.start + workarea.end : computed.end));
    window = { start, end };
  }

  const rel = (frames: number) => Math.round(framesToSeconds(frames - computed.start, fps) * 1000) / 1000;
  const scene = minVisibleSeconds > 0 ? sceneOf(target) : null;
  const canvas = scene && canvasBounds(world, scene);
  const state: WalkState = { nodes: 0, byKind: {}, depth: 0, issues: [], coverage: [], rel, canvas, layers: [] };
  visit(world, target, window, 0, state);

  const issues: CheckIssue[] = [];
  if (window.end > window.start) {
    if (state.coverage.length === 0) {
      // A group of only audio clips is a legitimate thing to check; an
      // empty visual subtree is not.
      const audioOnly = (state.byKind["audio"] ?? 0) > 0;
      issues.push({
        code: "no-visuals",
        severity: audioOnly ? "warning" : "error",
        message: audioOnly
          ? "No visual content in the subtree — fine for audio-only nodes, black frames otherwise"
          : "No visual content anywhere in the subtree — every frame renders empty",
      });
    } else {
      const gaps = findGaps(window, state.coverage);
      if (gaps.length > 0) {
        const total = gaps.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
        issues.push({
          code: "black-frames",
          severity: "error",
          message: `No visuals scheduled in ${gaps.length} span${gaps.length === 1 ? "" : "s"} totaling ${rel(computed.start + total)}s — likely black frames`,
          ranges: gaps.map((gap) => ({ start: rel(gap.start), end: rel(gap.end) })),
        });
      }
    }
  }
  let visibility: { minVisibleSeconds: number; stretches: number; shortStretches: number; evaluatedLayers: number; skippedLayers: number; skipped: Array<{ node?: string; reason: string }> } | undefined;
  if (canvas && window.end > window.start) {
    const stretches = visibleStretches(state.layers, window);
    const short = shortVisibleStretches(stretches, window, minVisibleSeconds * fps);
    const skipped = state.layers.filter((layer) => layer.skipped);
    // Each flash is its own issue, so its node and range can be fixed one by one.
    for (const stretch of short.slice(0, 50)) {
      const length = `${rel(computed.start + stretch.end - stretch.start)}s (${plural(Math.round(stretch.end - stretch.start), "frame")})`;
      issues.push({
        code: "short-visible-stretch",
        severity: "warning",
        node: stretch.owner?.node,
        message: betweenCutsOfOneRecording(stretches, stretch)
          ? `A ${length} piece of one recording between two cuts in it, under the ${minVisibleSeconds}s minimum; two jumps this close read as a stutter. Keep the pause on one side so the piece joins its neighbour, drop the piece if its words can go, or cover both cuts with one insert.`
          : `On screen for only ${length} between two other shots, under the ${minVisibleSeconds}s minimum; it reads as a flash. Move the neighbouring edge onto the cut or at least ${minVisibleSeconds}s away from it.`,
        ranges: [{ start: rel(stretch.start), end: rel(stretch.end) }],
      });
    }
    visibility = {
      minVisibleSeconds,
      stretches: stretches.filter((stretch) => stretch.owner).length,
      shortStretches: short.length,
      evaluatedLayers: state.layers.filter((layer) => !layer.skipped).length,
      skippedLayers: skipped.length,
      skipped: skipped.slice(0, 20).map((layer) => ({ ...layer.node ? { node: layer.node } : {}, reason: layer.skipped! })),
    };
  }
  issues.push(...state.issues);

  return {
    stats: {
      nodes: state.nodes,
      byKind: state.byKind,
      depth: state.depth,
      duration: rel(computed.start + (window.end - window.start)),
      ...visibility ? { visibility } : {},
    },
    issues,
  };
};
