/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What fills the picture, moment to moment, read from the resolved timeline
 * without rendering. A frame belongs to the topmost layer that covers nearly
 * all of the canvas and is nearly opaque: a talking head, a full-frame B-roll
 * shot, a still, a color card. Captions, text and smaller graphics sit on top
 * of that layer without taking the frame from it. Runs of frames with the same
 * owner are the stretches a viewer sees as one shot; an interior stretch much
 * shorter than half a second reads as a flash.
 *
 * Only what can be judged statically is judged. A layer that is masked,
 * keyframed, animated, blended, rotated or letterboxed inside its box (or sits
 * under an ancestor that is) cannot own frames here and is reported as not
 * evaluated, so a caller can say what the check did not look at.
 *
 * The sweep visits the layers' own edges only, never every frame, so a
 * two-hour scene costs no more than its clip count.
 */

import {
	AssetId, BlendMode, BlendModeType, Cache, Caption, Color, Geometry, GeometryType, Opacity, Paint, PaintType,
	ScaleMode, ScaleModeType, WorldBounds, WorldTransform, isText, store,
} from '@diffusionstudio/runtime';

import type { Entity, World } from 'koota';

/** The share of the canvas a layer must cover to own a frame. */
export const MIN_COVERAGE = 0.9;
/** The opacity a layer (with its ancestors) must have to own a frame. */
export const MIN_OPACITY = 0.95;

/** Frames, [start, end). */
export type FrameInterval = { start: number; end: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** One drawable layer as the sweep sees it, on absolute frames. */
export interface StretchLayer extends FrameInterval {
	/** Unique per layer: two clips of one source are still two shots. */
	id: number;
	/** Source stamp, for the issue. */
	node?: string;
	/** The media asset it shows, when it shows one: pieces of one recording share it. */
	media?: string;
	/** Paint order; a higher layer draws over a lower one. */
	order: number;
	/** Share of the canvas its box covers, 0-1. */
	coverage: number;
	/** Static opacity, its ancestors' included. */
	opacity: number;
	/** Why it could not be judged; such a layer never owns a frame. */
	skipped?: string;
}

export interface VisibleStretch extends FrameInterval { owner: StretchLayer | null }

/** What an ancestor hands down: the opacity it multiplies in, and a reason nothing under it can be judged. */
export interface InheritedLook { opacity: number; skipped?: string }

/** `look` with `entity` applied, for its own pixels and for everything under it. */
export function inheritLook(entity: Entity, look: InheritedLook): InheritedLook {
	const cache = entity.get(Cache);
	const opacity = look.opacity * (entity.get(Opacity)?.value ?? 1);
	if (look.skipped) return { opacity, skipped: look.skipped };
	const masked = (cache?.masks.length ?? 0) + (cache?.clipPaths.length ?? 0) > 0
		|| (cache?.effects ?? []).some((effect) => (effect.get(Cache)?.masks.length ?? 0) > 0);
	if (masked) return { opacity, skipped: 'masked' };
	if ((cache?.keyframeTracks.length ?? 0) + (cache?.animations.length ?? 0) > 0) return { opacity, skipped: 'animated' };
	const blend = entity.get(BlendMode)?.value;
	if (blend !== undefined && blend !== BlendModeType.SOURCE_OVER) return { opacity, skipped: 'blended' };
	return { opacity };
}

/** A scene's canvas in world coordinates, or null when it has no measurable box. */
export function canvasBounds(world: World, scene: Entity): Bounds | null {
	const bounds = store(world, WorldBounds), id = scene.id();
	const box = { minX: bounds.minX[id]!, minY: bounds.minY[id]!, maxX: bounds.maxX[id]!, maxY: bounds.maxY[id]! };
	if (![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite) || box.maxX <= box.minX || box.maxY <= box.minY) return null;
	return box;
}

const PICTURE_PAINTS = new Set([PaintType.SOLID, PaintType.IMAGE, PaintType.VIDEO]);

/**
 * Whether the entity fills its box with picture: a video or image, or a
 * rectangle with a solid color, video or image fill. `fitted` is true when
 * media is letterboxed or unscaled inside the box, so the box overstates it.
 */
function picture(entity: Entity): { fitted: boolean; media?: string } | null {
	if (entity.has(Caption) || isText(entity) || entity.get(Geometry)?.value !== GeometryType.RECT) return null;
	let found = false, fitted = false, media: string | undefined;
	const own = entity.get(Paint)?.value ?? (entity.has(Color) ? PaintType.SOLID : undefined);
	const paints: Array<[Entity, PaintType | undefined]> = [[entity, own], ...(entity.get(Cache)?.fills ?? []).map((fill): [Entity, PaintType | undefined] => [fill, fill.get(Paint)?.value])];
	for (const [source, type] of paints) {
		if (type === undefined || !PICTURE_PAINTS.has(type) || (type === PaintType.SOLID && !source.has(Color))) continue;
		if (source !== entity && (source.get(Opacity)?.value ?? 1) < MIN_OPACITY) continue;
		found = true;
		const mode = source.get(ScaleMode)?.value;
		if ((type === PaintType.VIDEO || type === PaintType.IMAGE) && (mode === ScaleModeType.FIT || mode === ScaleModeType.NONE)) fitted = true;
		if (type !== PaintType.SOLID) media ||= source.get(AssetId)?.value || undefined;
	}
	return found ? { fitted, ...media ? { media } : {} } : null;
}

/**
 * The entity as a sweep layer, or null when it can never own a frame
 * (text, captions, shapes other than filled rectangles). `window` is when it
 * plays inside its ancestors; `own` is `inheritLook` applied to it.
 */
export function stretchLayer(world: World, entity: Entity, window: FrameInterval, own: InheritedLook, canvas: Bounds, order: number, node?: string): StretchLayer | null {
	const kind = picture(entity);
	if (!kind) return null;
	const layer: StretchLayer = { id: entity.id(), node, ...kind.media ? { media: kind.media } : {}, order, start: window.start, end: window.end, coverage: 0, opacity: own.opacity };
	const matrix = store(world, WorldTransform), bounds = store(world, WorldBounds), id = entity.id();
	if (own.skipped) return { ...layer, skipped: own.skipped };
	if (Math.abs(matrix.b[id] ?? 0) > 1e-6 || Math.abs(matrix.c[id] ?? 0) > 1e-6) return { ...layer, skipped: 'rotated' };
	if (kind.fitted) return { ...layer, skipped: 'fitted' };
	const minX = Math.max(bounds.minX[id]!, canvas.minX), maxX = Math.min(bounds.maxX[id]!, canvas.maxX);
	const minY = Math.max(bounds.minY[id]!, canvas.minY), maxY = Math.min(bounds.maxY[id]!, canvas.maxY);
	if (![minX, maxX, minY, maxY].every(Number.isFinite)) return { ...layer, skipped: 'unmeasured' };
	const area = (canvas.maxX - canvas.minX) * (canvas.maxY - canvas.minY);
	return { ...layer, coverage: Math.max(0, maxX - minX) * Math.max(0, maxY - minY) / area };
}

/** Whether a layer is allowed to own the frames it plays. */
export function ownsFrames(layer: StretchLayer): boolean {
	return !layer.skipped && layer.coverage >= MIN_COVERAGE && layer.opacity >= MIN_OPACITY;
}

/**
 * The window split into stretches by owner, in order. A stretch with no owner
 * is a span no full-frame layer covers (a black gap, or only smaller or
 * unjudged layers); it separates its neighbours but is never short itself.
 */
export function visibleStretches(layers: readonly StretchLayer[], window: FrameInterval): VisibleStretch[] {
	if (!(window.end > window.start)) return [];
	const owners = layers.filter((layer) => ownsFrames(layer) && layer.end > window.start && layer.start < window.end).sort((a, b) => b.order - a.order);
	const edges = [...new Set([window.start, window.end, ...owners.flatMap((layer) => [layer.start, layer.end]).filter((edge) => edge > window.start && edge < window.end)])].sort((a, b) => a - b);
	const stretches: VisibleStretch[] = [];
	for (let i = 0; i + 1 < edges.length; i++) {
		const start = edges[i]!, end = edges[i + 1]!;
		// Every edge is a boundary, so a layer either plays this whole span or none of it.
		const owner = owners.find((layer) => layer.start <= start && layer.end >= end) ?? null;
		const previous = stretches.at(-1);
		if (previous && previous.owner?.id === owner?.id) previous.end = end;
		else stretches.push({ start, end, owner });
	}
	return stretches;
}

/** Owned stretches inside the window shorter than `minFrames`; one that touches the window's start or end is exempt. */
export function shortVisibleStretches(stretches: readonly VisibleStretch[], window: FrameInterval, minFrames: number): VisibleStretch[] {
	if (!(minFrames > 0)) return [];
	return stretches.filter((stretch) => stretch.owner && stretch.start > window.start && stretch.end < window.end && stretch.end - stretch.start < minFrames - 1e-6);
}

/**
 * Whether `stretch` is a piece of one recording with more of the same
 * recording right before and after it: a word or two left between two cuts in
 * a talking head, rather than a sliver an insert's edge leaves.
 */
export function betweenCutsOfOneRecording(stretches: readonly VisibleStretch[], stretch: VisibleStretch): boolean {
	const at = stretches.indexOf(stretch), media = stretch.owner?.media;
	if (at < 1 || !media) return false;
	return stretches[at - 1]?.owner?.media === media && stretches[at + 1]?.owner?.media === media;
}
