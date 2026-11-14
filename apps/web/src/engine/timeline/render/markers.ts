/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Name, Playback } from '@diffusionstudio/runtime';

import { getMarkers, markerColor, markerFrame } from '../../markers';
import { editPlayhead } from '../../timing';
import { RULER_HEIGHT } from '../config';
import { framesToPixels, getResolution, getScrollX, getViewport } from '../view';

import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from '../surface';

const FLAG_WIDTH = 11;
const FLAG_HEIGHT = 12;
/** The room a name may take to the right of its flag, at most. */
const NAME_WIDTH = 160;
/** Less room than this and the name is left off rather than shown as an ellipsis. */
const NAME_MIN_WIDTH = 24;

/**
 * The scene's markers, as flags along the top of the ruler: the point of a flag
 * is on the frame it marks, in the colour the marker names, with its name to
 * the right when there is room before the next flag. Click a flag to put the
 * playhead on it. Drawn after the work area's bar and before the playhead, so a
 * flag is the target of a press on it and the ruler beneath does not scrub.
 */
export function renderMarkers(world: World, scene: Entity, surface: TimelineSurfaceState): void {
	const { ctx, pointer } = surface;
	if (!ctx || !pointer) return;

	const markers = getMarkers(world, scene);
	if (!markers.length) return;

	const scrollX = getScrollX(world, scene);
	const resolution = getResolution(world, scene);
	const [minX, maxX] = getViewport(world, scene, surface.layout.width);

	ctx.save();
	ctx.translate(-(scrollX * resolution), 0);
	ctx.lineWidth = 1;
	ctx.font = '10px Inter';
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'left';

	markers.forEach((marker, index) => {
		const x = framesToPixels(markerFrame(marker), resolution);
		if (x < minX - FLAG_WIDTH || x > maxX + FLAG_WIDTH + NAME_WIDTH) return;

		const color = markerColor(marker);

		const { clicked } = pointer
			.scope('marker')
			.region(x - FLAG_WIDTH / 2, 0, FLAG_WIDTH, FLAG_HEIGHT + 2, String(marker.id()));

		// A press on a flag takes over from playback, as a scrub of the ruler does.
		if (clicked) {
			if (scene.get(Playback)?.playing) scene.set(Playback, { playing: false });
			editPlayhead(world, scene, markerFrame(marker));
		}

		// A thin line from the point of the flag down the ruler, to read the frame by.
		ctx.globalAlpha = 0.35;
		ctx.strokeStyle = color;
		ctx.beginPath();
		ctx.moveTo(x, FLAG_HEIGHT);
		ctx.lineTo(x, RULER_HEIGHT);
		ctx.stroke();
		ctx.globalAlpha = 1;

		// The flag: a tag whose point is on the frame.
		ctx.beginPath();
		ctx.moveTo(x - FLAG_WIDTH / 2, 1);
		ctx.lineTo(x + FLAG_WIDTH / 2, 1);
		ctx.lineTo(x + FLAG_WIDTH / 2, FLAG_HEIGHT - 4);
		ctx.lineTo(x, FLAG_HEIGHT);
		ctx.lineTo(x - FLAG_WIDTH / 2, FLAG_HEIGHT - 4);
		ctx.closePath();
		ctx.fillStyle = color;
		ctx.fill();
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
		ctx.stroke();

		const name = marker.get(Name)?.value;
		if (!name) return;

		const next = markers[index + 1];
		const nextX = next ? framesToPixels(markerFrame(next), resolution) - FLAG_WIDTH / 2 - 4 : Infinity;
		const room = Math.min(NAME_WIDTH, nextX - (x + FLAG_WIDTH / 2 + 4));
		if (room < NAME_MIN_WIDTH) return;

		ctx.fillStyle = surface.colors.ruler.text;
		ctx.fillText(fit(ctx, name, room), x + FLAG_WIDTH / 2 + 4, FLAG_HEIGHT / 2);
	});

	ctx.restore();
}

/** `text` cut to `width` with an ellipsis, as it is when it does not fit. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
	if (ctx.measureText(text).width <= width) return text;

	let end = text.length;
	while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end--;
	return `${text.slice(0, end)}…`;
}
