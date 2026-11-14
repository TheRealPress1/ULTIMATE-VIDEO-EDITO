/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Zooming the timeline from a key rather than the wheel: to take in the whole
 * scene, or a step in or out around the playhead. What it changes is view
 * state, written the way the wheel's zoom is: to the store, and to the file as
 * `<scene timeline>` so the scene reopens looking at the same stretch.
 */

import { Computed, getTimelineView, store } from '@diffusionstudio/runtime';

import { getDocumentEditor } from '@/engine/editor';
import { clamp } from '@/utils';
import { DEFAULT_TIMELINE_RESOLUTION, TIMELINE_PADDING_LEFT, TIMELINE_RESOLUTION_RANGE } from './config';
import { TimelineSurface } from './surface';
import {
	ensureTimelineView,
	getCurrentFrame,
	getResolution,
	getScrollX,
	getTimelineScene,
	setResolution,
	setScrollX,
	updateTimelineTransform,
} from './view';

import type { Entity, World } from 'koota';

/** How much a step of the keys zooms by. */
export const ZOOM_KEY_STEP = 1.5;

/** The resolution, in pixels a frame, kept inside what the wheel may reach. */
const withinRange = (resolution: number): number =>
	clamp(resolution, 1 / TIMELINE_RESOLUTION_RANGE[1], 1 / TIMELINE_RESOLUTION_RANGE[0]);

/**
 * The resolution that shows `frames` frames across `width` pixels, with the
 * timeline's padding either side. A scene with no length, or a view with no
 * width yet, leaves the default.
 */
export function resolutionToFit(frames: number, width: number): number {
	if (!(frames > 0) || !(width > 2 * TIMELINE_PADDING_LEFT)) return DEFAULT_TIMELINE_RESOLUTION;
	return withinRange((width - 2 * TIMELINE_PADDING_LEFT) / frames);
}

/** Tells the file where the timeline is looking, with no step in the history. */
function reportView(world: World, scene: Entity): void {
	const view = getTimelineView(world, scene);
	if (view) getDocumentEditor(world).reportEdit(scene, 'timeline', view);
}

/** Shows the whole scene, from its first frame to its last, across the timeline. */
export function zoomTimelineToFit(world: World): void {
	const scene = getTimelineScene(world);
	if (scene === null) return;
	// Before anything is written to it: adding the view to a scene sets it to the defaults.
	ensureTimelineView(world, scene);

	const width = world.get(TimelineSurface)?.layout.width ?? 0;
	const resolution = resolutionToFit(store(world, Computed).duration[scene.id()] ?? 0, width);

	setResolution(world, scene, resolution);
	setScrollX(world, scene, -TIMELINE_PADDING_LEFT / resolution);
	updateTimelineTransform(world, scene);
	reportView(world, scene);
}

/**
 * Zooms by `factor`, keeping the playhead where it is on screen when it is in
 * view, and the middle of the view when it is not.
 */
export function zoomTimelineBy(world: World, factor: number): void {
	const scene = getTimelineScene(world);
	if (scene === null) return;
	ensureTimelineView(world, scene);

	const width = world.get(TimelineSurface)?.layout.width ?? 0;
	const resolution = getResolution(world, scene);
	const scrollX = getScrollX(world, scene);

	const playhead = getCurrentFrame(world, scene);
	const inView = playhead >= scrollX && playhead <= scrollX + width / resolution;
	// The pixel the zoom is about, in the view, and the frame that is under it.
	const anchor = inView ? (playhead - scrollX) * resolution : width / 2;
	const frame = scrollX + anchor / resolution;

	const next = withinRange(resolution * factor);
	setResolution(world, scene, next);
	setScrollX(world, scene, frame - anchor / next);
	updateTimelineTransform(world, scene);
	reportView(world, scene);
}

export const zoomTimelineIn = (world: World): void => zoomTimelineBy(world, ZOOM_KEY_STEP);
export const zoomTimelineOut = (world: World): void => zoomTimelineBy(world, 1 / ZOOM_KEY_STEP);
