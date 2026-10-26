/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Align and distribute the selection: the nodes are moved in device space
 * against the upright box of them all (`WorldBounds`, which the transform
 * system writes), and each move becomes the `x`/`y` a drag would write, in
 * the node's own parent's space. Only nodes directly inside a scene (or
 * top-level ones) take part, as before: a nested node aligns to siblings in
 * its group, which has no box of its own to align against here.
 */

import {
  Geometry,
  Group,
  Position,
  Selected,
  WorldBounds,
  entityWorldMat,
  getParentEntity,
  getParentNode,
  getViewMatrix,
  invert2D,
  isScene,
  store,
  transformPoint,
} from "@diffusionstudio/runtime";
import { Or } from "koota";
import { getDocumentEditor } from "./editor";
import { syncKeyframe } from "./keyframes";

import type { Entity, World } from "koota";

export type AlignAction =
  | "align-left"
  | "align-center-horizontal"
  | "align-right"
  | "align-top"
  | "align-center-vertical"
  | "align-bottom";

export type Axis = "x" | "y";

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** The selected nodes alignment moves: top-level ones and direct children of scenes. */
export function getAlignableSelection(world: World): Entity[] {
  return [...world.query(Selected, Or(Geometry, Group))].filter((entity) => {
    const parent = getParentNode(entity);
    return parent === null || isScene(parent);
  });
}

function boundsOf(world: World, entity: Entity): Box {
  const bounds = store(world, WorldBounds);
  const eid = entity.id();
  return {
    minX: bounds.minX[eid] ?? 0,
    minY: bounds.minY[eid] ?? 0,
    maxX: bounds.maxX[eid] ?? 0,
    maxY: bounds.maxY[eid] ?? 0,
  };
}

function union(boxes: Box[]): Box {
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    maxY: Math.max(...boxes.map((box) => box.maxY)),
  };
}

/**
 * Moves `entity` by a device-space delta: the delta in its parent's space
 * (the stage's is the view) added to its `x`/`y`, rounded like a drag's, and
 * kept in step with any position track.
 */
function moveByWorldDelta(world: World, entity: Entity, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const position = entity.get(Position);
  if (!position) return;

  const inverse = invert2D(entityWorldMat(world, getParentEntity(entity)));
  const origin = transformPoint(inverse, 0, 0);
  const delta = transformPoint(inverse, dx, dy);
  const editor = getDocumentEditor(world);

  if (dx !== 0) {
    const x = Math.round(position.x + delta.x - origin.x);
    editor.editProperty(entity, "x", x);
    syncKeyframe(world, editor, entity, "x", x);
  }
  if (dy !== 0) {
    const y = Math.round(position.y + delta.y - origin.y);
    editor.editProperty(entity, "y", y);
    syncKeyframe(world, editor, entity, "y", y);
  }
}

/**
 * Aligns every selected node to the edge or center of the selection's box.
 * One node is a no-op: the box is the node.
 */
export function alignSelection(world: World, action: AlignAction): void {
  const entities = getAlignableSelection(world);
  if (entities.length < 2) return;

  const boxes = entities.map((entity) => boundsOf(world, entity));
  const mask = union(boxes);
  const centerX = (mask.minX + mask.maxX) / 2;
  const centerY = (mask.minY + mask.maxY) / 2;

  entities.forEach((entity, index) => {
    const box = boxes[index]!;
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;

    let targetMinX = box.minX;
    let targetMinY = box.minY;

    switch (action) {
      case "align-left": targetMinX = mask.minX; break;
      case "align-center-horizontal": targetMinX = centerX - width / 2; break;
      case "align-right": targetMinX = mask.maxX - width; break;
      case "align-top": targetMinY = mask.minY; break;
      case "align-center-vertical": targetMinY = centerY - height / 2; break;
      case "align-bottom": targetMinY = mask.maxY - height; break;
    }

    moveByWorldDelta(world, entity, targetMinX - box.minX, targetMinY - box.minY);
  });
}

/**
 * Spaces the selected nodes evenly along `axis` between the two outermost,
 * in their current order. Needs three: two have nothing between them.
 */
export function distributeSelection(world: World, axis: Axis): void {
  const entities = getAlignableSelection(world);
  if (entities.length < 3) return;

  const horizontal = axis === "x";
  const min = (box: Box) => (horizontal ? box.minX : box.minY);
  const size = (box: Box) => (horizontal ? box.maxX - box.minX : box.maxY - box.minY);

  const sorted = entities
    .map((entity) => ({ entity, box: boundsOf(world, entity) }))
    .sort((a, b) => min(a.box) - min(b.box));
  const mask = union(sorted.map((item) => item.box));

  const total = sorted.reduce((sum, item) => sum + size(item.box), 0);
  const gap = (size(mask) - total) / (sorted.length - 1);

  let cursor = min(mask);
  for (const { entity, box } of sorted) {
    const delta = cursor - min(box);
    moveByWorldDelta(world, entity, horizontal ? delta : 0, horizontal ? 0 : delta);
    cursor += size(box) + gap;
  }
}

/** Between nodes and between rows of a cleaned-up selection, in document space. */
const CLEAN_UP_GAP = 40;

type Size = { width: number; height: number };

/** `sizes`, by index, in rows no wider than `maxWidth` (a row always takes one), `gap` apart. */
function flowRows(sizes: Size[], order: number[], maxWidth: number, gap: number): number[][] {
  const rows: number[][] = [];
  let width = 0;
  for (const index of order) {
    const row = rows.at(-1);
    const next = width + gap + sizes[index]!.width;
    if (row && next <= maxWidth) {
      row.push(index);
      width = next;
    } else {
      rows.push([index]);
      width = sizes[index]!.width;
    }
  }
  return rows;
}

/**
 * Where each of `sizes` goes, as offsets from the layout's top-left: like a
 * Finder clean up, largest first, in rows read left to right with `gap`
 * between neighbours and between rows, each node top-aligned in its row.
 * Sorted by size, nodes alike end up side by side, so nodes of one size line
 * up in columns too. Of the row widths that fit a whole number of the
 * largest nodes in the first row, the one that makes the squarest block.
 */
export function cleanUpLayout(sizes: Size[], gap: number): { x: number; y: number }[] {
  const area = (size: Size) => size.width * size.height;
  const order = sizes.map((_, index) => index).sort((a, b) => area(sizes[b]!) - area(sizes[a]!) || a - b);

  let best: { rows: number[][]; score: number } | undefined;
  let firstRow = -gap;
  for (const index of order) {
    firstRow += gap + sizes[index]!.width;
    const rows = flowRows(sizes, order, firstRow, gap);
    const width = Math.max(...rows.map((row) => row.reduce((sum, i) => sum + sizes[i]!.width, 0) + (row.length - 1) * gap));
    const height = rows.reduce((sum, row) => sum + Math.max(...row.map((i) => sizes[i]!.height)), 0) + (rows.length - 1) * gap;
    const score = Math.max(width / height, height / width);
    if (!best || score < best.score) best = { rows, score };
  }

  const offsets = sizes.map(() => ({ x: 0, y: 0 }));
  let y = 0;
  for (const row of best?.rows ?? []) {
    let x = 0;
    for (const index of row) {
      offsets[index] = { x, y };
      x += sizes[index]!.width + gap;
    }
    y += Math.max(...row.map((index) => sizes[index]!.height)) + gap;
  }
  return offsets;
}

/**
 * Lays the selected nodes out from the selection's top-left corner (see
 * `cleanUpLayout`), with a gap that stays the same at any zoom. Needs two.
 */
export function cleanUpSelection(world: World): void {
  const entities = getAlignableSelection(world);
  if (entities.length < 2) return;

  // The boxes are in device space: the gap is scaled by the camera's zoom.
  const view = getViewMatrix(world);
  const gap = CLEAN_UP_GAP * Math.sqrt(Math.abs(view.a * view.d - view.b * view.c));

  const boxes = entities.map((entity) => boundsOf(world, entity));
  const mask = union(boxes);
  const offsets = cleanUpLayout(
    boxes.map((box) => ({ width: box.maxX - box.minX, height: box.maxY - box.minY })),
    gap,
  );

  entities.forEach((entity, index) => {
    const box = boxes[index]!;
    const offset = offsets[index]!;
    moveByWorldDelta(world, entity, mask.minX + offset.x - box.minX, mask.minY + offset.y - box.minY);
  });
}
