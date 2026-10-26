/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { openDB } from 'idb';
import type * as idb from 'idb';

import type { ProjectInfo } from '@desktop/main-channels';

/**
 * A project the app knows: one it created, or one it was asked to open — from
 * the folder picker, or `diffusion open <path>`. The dashboard lists these and nothing else.
 * Keyed by folder, which is how main addresses a project.
 */
export interface ProjectRecord extends ProjectInfo {
  recordedAt: string; // When the app first put it on record.
  lastOpenedAt: string;
  cover: Blob | null;
  collectionId?: string; // The collection it is filed in; none files it at the top level.
}

/**
 * A collection of projects: a folder in the dashboard, not on disk. Projects
 * name the one they are in (`ProjectRecord.collectionId`), so a collection
 * can be empty, and renaming one is one write.
 */
export interface CollectionRecord {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * The bundle a project last mounted successfully, keyed by its id. Two jobs:
 * the copy an export re-renders (see `@/engine/capture`), and the head start
 * the next open of the project mounts while its first compile still runs.
 * Written only after a mount lands, so what is here is always something the
 * canvas has shown.
 */
export interface ProjectBundle {
  projectId: string;
  code: string;
  updatedAt: string;
}

export interface GlobalDBSchema extends idb.DBSchema {
  projects: {
    value: ProjectRecord;
    key: string;
    indexes: {
      'by-id': string;
      'by-last-opened': string;
    };
  };
  bundles: {
    value: ProjectBundle;
    key: string;
  };
  collections: {
    value: CollectionRecord;
    key: string;
  };
}

type UpgradeTransaction = Parameters<NonNullable<idb.OpenDBCallbacks<GlobalDBSchema>['upgrade']>>[3];

const DB_NAME = 'cutroom-idb';
const DB_VERSION = 4;

const dbPromise = openDB<GlobalDBSchema>(DB_NAME, DB_VERSION, {
  async upgrade(db, _oldVersion, _newVersion, tx) {
    if (!db.objectStoreNames.contains('bundles')) {
      db.createObjectStore('bundles', { keyPath: 'projectId' });
    }
    if (!db.objectStoreNames.contains('projects')) {
      const store = db.createObjectStore('projects', { keyPath: 'dir' });
      store.createIndex('by-id', 'id');
      store.createIndex('by-last-opened', 'lastOpenedAt');
    }
    if (!db.objectStoreNames.contains('collections')) {
      db.createObjectStore('collections', { keyPath: 'id' });
    }
    if (db.objectStoreNames.contains('roots' as never)) await retireRoots(db, tx);
  },
});

/** Last segment of a path, whichever separator it uses. */
const folderLabel = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * A record for a project the app has not looked at yet: the folder name
 * stands in for the display name, and the record's own dates for the
 * folder's. What a legacy root is upgraded to; the first open replaces it
 * with what the folder actually says.
 */
function placeholderRecord(dir: string, recordedAt: string, lastOpenedAt: string): ProjectRecord {
  const name = folderLabel(dir);
  return { dir, id: '', name, displayName: name, entry: '', modifiedAt: lastOpenedAt, createdAt: recordedAt, draft: false, recordedAt, lastOpenedAt, cover: null };
}

/**
 * Versions 1 and 2 kept a `roots` store: folders the dashboard scanned for
 * projects (`kind: 'multi'`), and single project folders registered on their
 * own (`kind: 'single'`). Version 3 does away with it. The single ones become
 * project records; the multi ones are dropped.
 */
async function retireRoots(db: idb.IDBPDatabase<GlobalDBSchema>, tx: UpgradeTransaction): Promise<void> {
  type LegacyRoot = { path: string; kind?: 'multi' | 'single'; createdAt: string; lastUsedAt: string };
  const projects = tx.objectStore('projects');

  // The store is not in the schema any more, so it is addressed by name.
  const roots = (tx as unknown as idb.IDBPTransaction<unknown, string[], 'versionchange'>).objectStore('roots');
  for (const root of (await roots.getAll()) as LegacyRoot[]) {
    if (root.kind !== 'single') continue;
    await projects.put(placeholderRecord(root.path, root.createdAt, root.lastUsedAt));
  }

  db.deleteObjectStore('roots' as never);
}

// ---------------------------------------------------------------------------
// Project records

/**
 * Puts `project` on record as just opened — what its folder says now,
 * replacing the copy the record held — or on record for the first time, filed
 * in `collectionId` when one is given.
 */
export async function rememberProject(project: ProjectInfo, collectionId?: string): Promise<ProjectRecord> {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const existing = await db.get('projects', project.dir);

  const record: ProjectRecord = existing
    ? { ...existing, ...project, lastOpenedAt: now }
    : { ...project, recordedAt: now, lastOpenedAt: now, cover: null, collectionId };

  await db.put('projects', record);
  return record;
}

/**
 * Brings the record for `project` up to date with what its folder says,
 * without marking it opened — for a project that changed while it was open,
 * and for one that is closing. Nothing to do when it is not on record.
 */
export async function updateProjectRecord(project: ProjectInfo): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('projects', 'readwrite');
  const existing = await tx.store.get(project.dir);
  if (existing) await tx.store.put({ ...existing, ...project });
  await tx.done;
}

/** The record for the project in `dir`, or undefined when it is not on record. */
export async function getProjectRecord(dir: string): Promise<ProjectRecord | undefined> {
  const db = await dbPromise;
  return db.get('projects', dir);
}

/** Every project on record, most recently opened first. */
export async function listProjectRecords(): Promise<ProjectRecord[]> {
  const db = await dbPromise;
  return (await db.getAllFromIndex('projects', 'by-last-opened')).reverse();
}

/**
 * The records `ref` could name: those whose id it is, then — for links made
 * before ids existed, and folders opened by name — those whose folder it
 * names. Most recently opened first within each, so a project that was just
 * open wins over a copy of it.
 */
export async function findProjectRecords(ref: string): Promise<ProjectRecord[]> {
  const records = await listProjectRecords();
  return [
    ...records.filter((record) => record.id === ref),
    ...records.filter((record) => record.id !== ref && folderLabel(record.dir) === ref),
  ];
}

/**
 * Re-keys the record for `from` to `to`, for a project whose folder moved (a
 * draft that was saved), cover and dates included. Nothing to do when `from`
 * is not on record.
 */
export async function moveProjectRecord(from: string, to: string): Promise<void> {
  if (from === to) return;
  const db = await dbPromise;
  const tx = db.transaction('projects', 'readwrite');
  const existing = await tx.store.get(from);
  if (existing) {
    await tx.store.delete(from);
    await tx.store.put({ ...existing, dir: to });
  }
  await tx.done;
}

/**
 * Records `cover` as the picture of the project in `dir`, replacing the one
 * before it. Nothing to do when the project is not on record: one deleted
 * while its cover was still being taken is not put back.
 */
export async function rememberProjectCover(dir: string, cover: Blob): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('projects', 'readwrite');
  const existing = await tx.store.get(dir);
  if (existing) await tx.store.put({ ...existing, cover });
  await tx.done;
}

/** Takes the project in `dir` off the record. The folder itself is left alone. */
export async function forgetProject(dir: string): Promise<void> {
  const db = await dbPromise;
  await db.delete('projects', dir);
}

// ---------------------------------------------------------------------------
// Collections

/** Every collection, oldest first: the order they were made in. */
export async function listCollectionRecords(): Promise<CollectionRecord[]> {
  const db = await dbPromise;
  const collections = await db.getAll('collections');
  return collections.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Puts `collection` on record, or replaces the one with its id. */
export async function putCollectionRecord(collection: CollectionRecord): Promise<void> {
  const db = await dbPromise;
  await db.put('collections', collection);
}

/**
 * Takes collection `id` off the record. The projects in it are kept, at the
 * top level.
 */
export async function deleteCollectionRecord(id: string): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction(['collections', 'projects'], 'readwrite');
  const projects = tx.objectStore('projects');
  for (const record of await projects.getAll()) {
    if (record.collectionId === id) await projects.put({ ...record, collectionId: undefined });
  }
  await tx.objectStore('collections').delete(id);
  await tx.done;
}

/**
 * Files the projects in `dirs` in collection `id`, or at the top level when
 * it is undefined. Projects not on record are skipped.
 */
export async function fileProjectRecords(dirs: string[], id: string | undefined): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction('projects', 'readwrite');
  for (const dir of dirs) {
    const existing = await tx.store.get(dir);
    if (existing) await tx.store.put({ ...existing, collectionId: id });
  }
  await tx.done;
}

// ---------------------------------------------------------------------------
// Project bundles

/** Records the bundle `projectId` just mounted, replacing the one before it. */
export async function rememberProjectBundle(projectId: string, code: string): Promise<void> {
  try {
    const db = await dbPromise;
    await db.put('bundles', { projectId, code, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Failed to remember project bundle', e);
  }
}

/** The bundle `projectId` last mounted, or null when it has none on record. */
export async function loadProjectBundle(projectId: string): Promise<string | null> {
  if (!projectId) return null;
  try {
    const db = await dbPromise;
    return (await db.get('bundles', projectId))?.code ?? null;
  } catch (e) {
    console.error('Failed to load project bundle', e);
    return null;
  }
}

/** Forgets a project's bundle, for when the project itself is deleted. */
export async function forgetProjectBundle(projectId: string): Promise<void> {
  if (!projectId) return;
  try {
    const db = await dbPromise;
    await db.delete('bundles', projectId);
  } catch (e) {
    console.error('Failed to forget project bundle', e);
  }
}
