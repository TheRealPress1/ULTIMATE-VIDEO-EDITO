/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
	deleteCollectionRecord,
	fileProjectRecords,
	listCollectionRecords,
	putCollectionRecord,
} from '@/lib/db';

import { isDesktop, markProjectsChanged } from './host';

import type { CollectionRecord } from '@/lib/db';

export type { CollectionRecord };

// Collections are the dashboard's folders: they live in the app's own
// records, never on disk, and a project is in at most one. Every change bumps
// `projectsRevision`, which the sidebar and the project grids both follow.

/** Every collection, in the order they were made. */
export async function listCollections(): Promise<CollectionRecord[]> {
	if (!isDesktop()) return [];
	return listCollectionRecords();
}

/** Makes an empty collection called `name`. */
export async function createCollection(name: string): Promise<CollectionRecord> {
	const collection: CollectionRecord = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
	await putCollectionRecord(collection);
	markProjectsChanged();
	return collection;
}

/** Renames `collection` to `name`. */
export async function renameCollection(collection: CollectionRecord, name: string): Promise<void> {
	await putCollectionRecord({ ...collection, name });
	markProjectsChanged();
}

/** Deletes collection `id`. Its projects stay on the list, at the top level. */
export async function deleteCollection(id: string): Promise<void> {
	await deleteCollectionRecord(id);
	markProjectsChanged();
}

/** Files the projects in `dirs` in collection `id`, or at the top level when it is undefined. */
export async function moveProjectsToCollection(dirs: string[], id: string | undefined): Promise<void> {
	await fileProjectRecords(dirs, id);
	markProjectsChanged();
}
