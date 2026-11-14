/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Markers, in the words of an editor: flags on the scene's ruler. A marker is a
 * `<marker>` child of the scene (see `MarkerProps`) at a time, with a name and
 * a colour of its own. It is not a layer: it takes no row and draws nothing in
 * the frame, and what the scene lasts and exports does not depend on it.
 */

import { Marker as MarkerElement } from '@diffusionstudio/reconciler';
import { ChildOf, Color, Marker, Source, colorToCss, framesToSeconds, getActiveEntity, setPlayhead } from '@diffusionstudio/runtime';

import { getDocumentEditor } from './editor';
import { getCurrentFrame, getFrameRate } from './timeline/view';

import type { Entity, World } from 'koota';

/** What a flag is drawn in when the marker names no colour. */
export const DEFAULT_MARKER_COLOR = '#f59e0b';

/** The frame `marker` marks. */
export const markerFrame = (marker: Entity): number => marker.get(Marker)?.time ?? 0;

/** The markers of `scene`, earliest first (a tie keeps the order of the file). */
export function getMarkers(world: World, scene: Entity): Entity[] {
	return [...world.query(Marker, ChildOf(scene))].sort((a, b) => markerFrame(a) - markerFrame(b));
}

/** The CSS colour `marker`'s flag is drawn in. */
export function markerColor(marker: Entity): string {
	const color = marker.get(Color);
	return color ? colorToCss(color.value, 1) : DEFAULT_MARKER_COLOR;
}

/**
 * Puts a marker on `frame` (the playhead when left out) and returns it. There
 * is one marker to a frame: where one already is, that one is returned and
 * nothing is added. Null when there is no scene to put it on.
 */
export function addMarker(world: World, frame?: number): Entity | null {
	const scene = getActiveEntity(world);
	if (scene === null || !scene.get(Source)?.value) return null;

	const at = Math.max(0, Math.round(frame ?? getCurrentFrame(world, scene)));
	const existing = getMarkers(world, scene).find((marker) => markerFrame(marker) === at);
	if (existing) return existing;

	const [marker] = getDocumentEditor(world).insertElement(scene, () => MarkerElement({ time: framesToSeconds(at, getFrameRate(world)) }));
	return marker ?? null;
}

/** Takes every marker of the scene away, as one step; returns the ones taken. */
export function clearMarkers(world: World): Entity[] {
	const scene = getActiveEntity(world);
	const markers = scene === null ? [] : getMarkers(world, scene);
	return markers.length ? getDocumentEditor(world).remove(markers) : [];
}

/** Takes away the marker on the playhead's frame, if there is one. */
export function clearMarkerAtPlayhead(world: World): Entity[] {
	const scene = getActiveEntity(world);
	if (scene === null) return [];

	const now = getCurrentFrame(world, scene);
	const here = getMarkers(world, scene).filter((marker) => markerFrame(marker) === now);
	return here.length ? getDocumentEditor(world).remove(here) : [];
}

/**
 * Moves the playhead to the next marker after it, or the last one before it;
 * false when there is none that way. Like a keyframe jump, it moves the
 * playhead and says nothing of it to the file.
 */
export function seekMarker(world: World, direction: 'next' | 'previous'): boolean {
	const scene = getActiveEntity(world);
	if (scene === null) return false;

	const now = getCurrentFrame(world, scene);
	const frames = getMarkers(world, scene).map(markerFrame);
	const target = direction === 'next'
		? frames.find((frame) => frame > now)
		: frames.filter((frame) => frame < now).at(-1);

	if (target === undefined) return false;

	setPlayhead(world, scene, target);
	return true;
}
