/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { VideoAsset } from '@diffusionstudio/assets';
import type { PlaybackProxyBinding, PlaybackProxyState } from '../traits/media';
import type { RuntimeMode } from '../traits/world';

/** Snapshot identity also catches in-place relinks of the same library object. */
export function playbackAssetIdentity(asset: VideoAsset): string {
	return JSON.stringify([asset.id, asset.source, asset.stat?.size, asset.stat?.mtime,
		asset.duration, asset.width, asset.height, asset.frameRate]);
}

/** This policy is used at decoder resolution, not only when preparing media. */
export function playbackProxyFor(mode: RuntimeMode | undefined, source: VideoAsset, state: PlaybackProxyState | null | undefined): PlaybackProxyBinding | undefined {
	if (mode !== 'realtime' || !state?.enabled) return;
	const binding = state.entries.get(source.id);
	if (binding?.identity === playbackAssetIdentity(source)) return binding;
}
