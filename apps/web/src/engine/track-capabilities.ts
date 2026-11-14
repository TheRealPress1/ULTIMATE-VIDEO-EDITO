/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AdjustmentLayer, Audio, Caption, Geometry, Paint, PaintType, getEntityTree } from '@diffusionstudio/runtime';

import type { Entity, World } from 'koota';

/** What a row of the timeline has to switch on and off: a picture, a sound, or both. */
export interface TrackCapabilities {
	visual: boolean;
	audio: boolean;
}

/**
 * Which controls a track header has to offer. A row gets the eye when something
 * on it is seen and the mute and solo when something on it is heard: a
 * sequence of video clips has both, music only the sound, captions only the
 * picture. A row with nothing on it yet is treated as a picture, so it still
 * has an eye.
 */
export function trackCapabilities(world: World, entity: Entity): TrackCapabilities {
	let visual = false;
	let audio = false;

	for (const member of getEntityTree(world, entity)) {
		const sounds = member.has(Audio);
		if (sounds || member.get(Paint)?.value === PaintType.VIDEO) audio = true;
		if (!sounds && (member.has(Geometry) || member.has(Caption) || member.has(AdjustmentLayer))) visual = true;
	}

	return { visual: visual || !audio, audio };
}
