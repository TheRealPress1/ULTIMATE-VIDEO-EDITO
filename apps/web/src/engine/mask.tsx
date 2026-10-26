/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Mask as MaskElement } from '@diffusionstudio/reconciler';
import {
	Computed,
	Flip,
	Source,
	Tool,
	ToolType,
	decompose2D,
	entityPivot,
	entityOffset,
	entityWorldMat,
	getEntityChildren,
	getEntityTree,
	getParentEntity,
	getSelection,
	invert2D,
	isMaskContainer,
	isShape,
	isText,
	multiply2D,
	store,
	translate2D,
} from '@diffusionstudio/runtime';
import { createSignal } from 'solid-js';

import { getDocumentEditor } from './editor';
import { editTransform } from './input/interactions';

import type { Entity, World } from 'koota';
import type { TransformWrite } from './input/interactions';

const round2 = (value: number): number => Math.round(value * 100) / 100;

// The node the tool is aimed at, reactive so the bar follows it.
const [maskTarget, setMaskTarget] = createSignal<Entity | null>(null);

/** The node the picked layers will mask, reactive; null while the tool is down. */
export { maskTarget };

export function getMaskTarget(): Entity | null {
	const target = maskTarget();
	return target?.isAlive() ? target : null;
}

/** Picks the tool to add masks to `target`. The selection stays on it until a layer is picked. */
export function beginMaskFor(world: World, target: Entity): void {
	setMaskTarget(target);
	world.set(Tool, { value: ToolType.MASK });
}

/** Forgets the target: the tool is down. */
export function clearMaskTarget(): void {
	setMaskTarget(null);
}

/**
 * Whether `entity` can mask `target`: a shape, media or text (a `<mask>`
 * shows the target where their pixels are; groups and the like are out), not
 * cutting something already, and not the target or something the target sits
 * inside — a node cannot be moved into its own subtree.
 */
export function canMaskWith(world: World, target: Entity, entity: Entity): boolean {
	if (entity === target || !entity.isAlive() || !entity.get(Source)?.value) return false;
	if (!isShape(entity) && !isText(entity)) return false;
	const parent = getParentEntity(entity);
	if (parent && isMaskContainer(parent)) return false;
	return !getEntityTree(world, entity).includes(target);
}

/** The selected layers Confirm would apply to the target, in selection order. */
export function getMaskPicks(world: World): Entity[] {
	const target = getMaskTarget();
	if (!target) return [];
	return getSelection(world).filter((entity) => canMaskWith(world, target, entity));
}

/**
 * Gives the target a new `<mask>` holding the picked layers, one undo step,
 * and puts the tool down with the target selected: the target then shows
 * only where their pixels are together, and within any mask it had before.
 * Each layer keeps its place on the canvas: its matrix is carried from the
 * parent it had into the target's space (the mask's) and written back as
 * `x`, `y` and `rotation`, with whatever scale the move adds (a target drawn
 * at half size, say) folded into its `width` and `height` rather than its
 * own scale.
 */
export function applyMasks(world: World): void {
	const target = getMaskTarget();
	const picks = getMaskPicks(world);
	if (!target || picks.length === 0) return;

	maskWith(world, target, picks);
	leaveMaskTool(world, target);
}

/**
 * The selection as "Use as mask" reads it, the way Figma does: of two
 * selected layers side by side, the one behind is the mask and the one in
 * front is what it masks. Null for any other selection, or when the one
 * behind cannot be a mask (see `canMaskWith`).
 */
export function getSelectionMask(world: World): { mask: Entity; target: Entity } | null {
	const selected = new Set(getSelection(world));
	const first = [...selected][0];
	if (!first || selected.size !== 2) return null;

	const parent = getParentEntity(first);
	if (!parent || isMaskContainer(parent)) return null;

	// Back to front, as the file lists them.
	const [mask, target] = getEntityChildren(world, parent).filter((entity) => selected.has(entity));
	if (!mask || !target || !canMaskWith(world, target, mask)) return null;
	return { mask, target };
}

/**
 * "Use as mask": of two selected layers, the one behind becomes a `<mask>`
 * of the one in front, moved into it where it stands. One undo step; the
 * masked layer ends up selected.
 */
export function applySelectionAsMask(world: World): void {
	const selection = getSelectionMask(world);
	if (!selection) return;

	if (maskWith(world, selection.target, [selection.mask])) {
		getDocumentEditor(world).select(selection.target);
	}
}

/**
 * Gives `target` a new `<mask>` holding `layers`, each moved into it where it
 * stands (see `applyMasks`). Returns the mask, or null when none of them
 * could be moved.
 */
function maskWith(world: World, target: Entity, layers: Entity[]): Entity | null {
	const editor = getDocumentEditor(world);
	const computed = store(world, Computed);
	const flip = store(world, Flip);
	const targetInverse = invert2D(entityWorldMat(world, target));

	const [mask] = editor.insertElement(target, () => <MaskElement />);
	if (!mask) return null;

	let moved = 0;
	for (const layer of layers) {
		const eid = layer.id();
		const width = computed.width[eid] ?? 0;
		const height = computed.height[eid] ?? 0;
		const pivot = entityPivot(world, layer);

		// Where it is drawn now, pivot folded in (see `bakeContainerInto`),
		// taken into the target's space (which the mask shares) before
		// the move changes its parent.
		const placed = decompose2D(multiply2D(
			targetInverse,
			multiply2D(entityWorldMat(world, layer), translate2D(pivot.x, pivot.y)),
		));

		if (!editor.reparent(layer, mask)) continue;
		moved++;

		// The scale the layer carries of its own stays its own; the rest is the move's.
		const ownX = (computed.scaleX[eid] ?? 1) * (flip.x[eid] ?? 1);
		const ownY = (computed.scaleY[eid] ?? 1) * (flip.y[eid] ?? 1);
		const nextWidth = ownX === 0 ? width : Math.round(width * Math.abs(placed.scaleX / ownX));
		const nextHeight = ownY === 0 ? height : Math.round(height * Math.abs(placed.scaleY / ownY));

		const offset = entityOffset(world, layer);
		const nextPivot = entityPivot(world, layer, nextWidth, nextHeight);
		const x = Math.round(placed.x - nextPivot.x - offset.x);
		const y = Math.round(placed.y - nextPivot.y - offset.y);
		const rotation = round2(placed.rotation);

		const writes: TransformWrite[] = [];
		if (x !== Math.round(computed.positionX[eid] ?? 0)) writes.push(['x', x]);
		if (y !== Math.round(computed.positionY[eid] ?? 0)) writes.push(['y', y]);
		if (rotation !== round2(computed.rotation[eid] ?? 0)) writes.push(['rotation', rotation]);
		if (nextWidth !== Math.round(width)) writes.push(['width', nextWidth]);
		if (nextHeight !== Math.round(height)) writes.push(['height', nextHeight]);
		if (writes.length) editTransform(world, editor, layer, writes);
	}

	// An empty mask would show nothing of the target; it is not worth the file.
	if (moved === 0) {
		editor.remove(mask);
		return null;
	}
	return mask;
}

/** Puts the tool down without applying anything; the selection goes back to the target. */
export function cancelMask(world: World): void {
	leaveMaskTool(world, getMaskTarget());
}

function leaveMaskTool(world: World, target: Entity | null): void {
	clearMaskTarget();
	if (target) getDocumentEditor(world).select(target);
	if (world.get(Tool)?.value === ToolType.MASK) world.set(Tool, { value: ToolType.MOVE });
}
