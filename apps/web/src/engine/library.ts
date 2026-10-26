/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The asset library in the app: attached to the world for the project on
// disk and kept in step with the JSX (a rename in the library is a `src`
// edit in the file).

import { AssetId, Library } from '@diffusionstudio/runtime';
import { AssetLibrary, MANIFEST_FILE, ASSETS_DIR } from '@diffusionstudio/assets';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { authoredElement } from '@diffusionstudio/reconciler';
import type { Accessor } from 'solid-js';

import { createProjectFS } from '@/projects/fs';
import { DurableProjectValue } from '@/projects/save-values';
import { getDocumentEditor } from './editor';

import type { Asset, AssetReload, Manifest } from '@diffusionstudio/assets';
import type { World } from 'koota';

/**
 * Creates the library of the project at `dir`, attaches it to the world and
 * starts loading it. Renames in the library are written through to every
 * element whose `src` named the old path. Returns the library and a
 * disposer that flushes the manifest and detaches it.
 */
export function attachLibrary(world: World, dir: string) {
	const fs = createProjectFS(dir);
	const value = new DurableProjectValue<Manifest>(dir, 'manifest', (manifest) => fs.writeManifest(manifest));
	const library = new AssetLibrary({
		...fs,
		readManifest: async () => {
			await value.flush();
			return fs.readManifest();
		},
		writeManifest: async (manifest) => {
			value.set(manifest);
			await value.flush();
		},
	}, {
		onChange: (manifest) => value.set(manifest),
		onRename: (asset, from) => followRename(world, asset, from),
		onRelink: (asset, from) => followRelink(world, asset, from),
		onReload: (changes) => followReload(world, changes),
	});
	const dispose = library.dispose.bind(library);
	library.dispose = async () => {
		try { await dispose(); }
		finally { value.dispose(); }
	};

	world.set(Library, library);

	return library;
}

/** Whether a changed project file is the library's business rather than the JSX's. */
export function isLibraryFile(path: string): boolean {
	return path === MANIFEST_FILE || path === ASSETS_DIR || path.startsWith(`${ASSETS_DIR}/`);
}

/** Rewrites `src` on every element that named an asset by its old path. */
function followRename(world: World, asset: Asset, from: string): void {
	const editor = getDocumentEditor(world);

	for (const entity of world.query(AssetId)) {
		const src = authoredElement(entity)?.props.src;
		if (src === from) editor.editProperty(entity, 'src', asset.path);
	}
}

/** Rebinds every element bound to a relinked asset's old id to its new one. */
function followRelink(world: World, asset: Asset, from: string): void {
	for (const entity of world.query(AssetId)) {
		if (entity.get(AssetId)?.value === from) entity.set(AssetId, { value: asset.id });
	}
}

/** Refresh live decoders without authoring a JSX edit or remounting history. */
function followReload(world: World, changes: readonly AssetReload[]): void {
	const library = world.get(Library);
	const replacements = new Map(changes.map(({ previous, current }) => [previous.id, current.id]));
	// Read every binding before changing any: content can move A→B and B→A
	// in one external edit, so repeated global relinks would collapse the two.
	const bindings = world.query(AssetId).map((entity) => ({ entity, id: entity.get(AssetId)!.value }));
	for (const { entity, id } of bindings) {
		// Different paths may temporarily contain identical bytes and share an
		// ID. When they diverge, the authored path identifies each layer's file.
		const src = authoredElement(entity)?.props.src;
		const current = typeof src === 'string' ? library?.get(src) ?? library?.bySource(src) : undefined;
		const next = current?.id ?? replacements.get(id);
		if (next && next !== id && entity.isAlive()) entity.set(AssetId, { value: next });
	}
}

/**
 * The world's library, or undefined until a project attaches one. The
 * library's own state is reactive (`assets()`, `folders()`, `childrenOf()`),
 * so readers inside a tracking scope follow it.
 */
export function useLibrary(): Accessor<AssetLibrary | undefined> {
	const world = useWorld();
	const attached = useTrait(world, Library);
	return () => attached() ?? undefined;
}
