/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { createMemo } from 'solid-js';

import { AssetSelection } from '../traits';
import { useLibrary } from '../library';

import type { Asset } from '@diffusionstudio/assets';

/**
 * Reactive read and write of the AssetSelection trait: the assets and folders
 * the assets panel has picked, and the one asset the inspector describes.
 * Shared between the two sidebars, so it lives on the world rather than in
 * either panel.
 */
export function useAssetSelection() {
	const world = useWorld();
	const library = useLibrary();
	const selection = useTrait(world, AssetSelection);

	const ids = () => selection()?.ids ?? [];
	const folders = () => selection()?.folders ?? [];

	// The asset the inspector describes: the selection, when it is one asset
	// alone. `list()` is the library's signal, so a removed or relinked asset
	// drops out here without the panel having to watch for it.
	const asset = createMemo(() => {
		const lib = library();
		const current = ids();
		if (!lib || current.length !== 1 || folders().length) return undefined;
		return lib.list().find((entry) => entry.id === current[0]);
	});

	/** Selects one asset alone, or nothing. */
	const select = (next: Asset | string | null) => {
		const id = typeof next === 'string' ? next : next?.id;
		world.set(AssetSelection, { ids: id ? [id] : [], folders: [] });
	};

	/** Replaces the selection with these assets and folders. */
	const set = (next: { ids: string[]; folders: string[] }) => {
		world.set(AssetSelection, next);
	};

	return { ids, folders, asset, select, set };
}
