/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trait } from 'koota';

import type { World } from 'koota';

/**
 * What a press on a clip in the timeline does. The Selection tool (V) selects
 * a clip and drags it; the Razor (C) cuts it where the pointer is. A tool of
 * the timeline and not the stage's `Tool`, which is about drawing.
 */
export type TimelineToolType = 'select' | 'razor';

export const TimelineTool = trait({ value: 'select' as TimelineToolType });

export const getTimelineTool = (world: World): TimelineToolType => world.get(TimelineTool)?.value ?? 'select';

export function setTimelineTool(world: World, value: TimelineToolType): void {
	if (world.has(TimelineTool)) world.set(TimelineTool, { value });
	else world.add(TimelineTool({ value }));
}
