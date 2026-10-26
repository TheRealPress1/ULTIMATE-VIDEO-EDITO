/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { writeFileAtomic } from './atomic';
import type { WriteResult } from './edit-types';

export type ProjectFileWrite = { path: string; before: string; after: string };
type Receipt = { version: 1; id: string; hash: string; complete: boolean; files: ProjectFileWrite[]; result: WriteResult };
const queues = new Map<string, Promise<unknown>>();

/** Shared by saves, compilation, restoration and project collection. */
export async function withProjectLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = await realpath(dir);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

async function journalDirectory(dir: string, create = true): Promise<string> {
  const root = await realpath(dir);
  let folder = root;
  for (const part of ['.cutroom', 'writes']) {
    folder = join(folder, part);
    if (create) await mkdir(folder, { recursive: true });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Project recovery folder must be a real directory.');
  }
  return folder;
}

async function targetPath(dir: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..' || part.startsWith('.')) || !/\.[jt]sx?$/.test(path)) {
    throw new Error(`Unsafe project source path: ${path}`);
  }
  const root = await realpath(dir);
  const target = resolve(root, path);
  const parent = await realpath(dirname(target));
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error(`Source leaves the project: ${path}`);
  if ((await lstat(target)).isSymbolicLink()) throw new Error(`Relink the source file before saving: ${path}`);
  return target;
}

async function readReceipt(path: string): Promise<Receipt | null> {
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024) throw new Error('Unsafe project save recovery record.');
    text = await readFile(path, 'utf8');
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(text) as Receipt;
  if (value.version !== 1 || typeof value.id !== 'string' || typeof value.hash !== 'string' || typeof value.complete !== 'boolean' || !Array.isArray(value.files) || !Array.isArray(value.result?.skipped)
    || value.files.some((file) => typeof file.path !== 'string' || typeof file.before !== 'string' || typeof file.after !== 'string')) {
    throw new Error('Project save recovery record is damaged. Keep the project folder and restore a saved version.');
  }
  return value;
}

async function finishReceipt(dir: string, path: string, receipt: Receipt, onWrite?: (path: string, text: string) => void): Promise<WriteResult> {
  if (receipt.complete) return receipt.result;
  // Check the entire set before any mutation. Never replace an external edit.
  const files = await Promise.all(receipt.files.map(async (file) => {
    const target = await targetPath(dir, file.path);
    const current = await readFile(target, 'utf8');
    if (current !== file.before && current !== file.after) throw new Error(`Save recovery conflicts with a newer change to ${file.path}. Keep this project open and restore a version or resolve the source change.`);
    return { ...file, target };
  }));
  for (const file of files) {
    const current = await readFile(file.target, 'utf8');
    if (current === file.after) continue;
    if (current !== file.before) throw new Error(`The file ${file.path} changed during saving. Your newer file was preserved.`);
    onWrite?.(file.path, file.after);
    await writeFileAtomic(file.target, file.after);
  }
  // Keep the result, including allocated IDs, so an IPC retry cannot insert twice.
  await writeFileAtomic(path, JSON.stringify({ ...receipt, complete: true, files: [] }));
  return receipt.result;
}

/** Called under withProjectLock; preparation never writes project files. */
export async function commitProjectWrite(
  dir: string, id: string, input: unknown,
  prepare: () => Promise<{ files: ProjectFileWrite[]; result: WriteResult }>,
  onWrite?: (path: string, text: string) => void,
): Promise<WriteResult> {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('Invalid project save operation.');
  const folder = await journalDirectory(dir);
  const path = join(folder, `${id}.json`);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = await readReceipt(path);
  if (existing) {
    if (existing.id !== id || existing.hash !== hash) throw new Error('Save operation was reused for different edits.');
    return finishReceipt(dir, path, existing, onWrite);
  }
  await recoverProjectWrites(dir, onWrite);
  const { files, result } = await prepare();
  if (result.error || result.skipped.length) return { skipped: result.skipped, error: result.error ?? `Some edits could not be saved: ${result.skipped.join(', ')}` };
  const receipt: Receipt = { version: 1, id, hash, complete: false, files, result };
  // Validate the plan before persisting it so malformed requests don't poison recovery.
  for (const file of files) await targetPath(dir, file.path);
  await writeFileAtomic(path, JSON.stringify(receipt));
  const saved = await finishReceipt(dir, path, receipt, onWrite);
  // Completed receipts are tiny; retain the latest 1,000, never pending work.
  try {
  const names = await readdir(folder);
  if (names.length > 1000) {
    const completed = (await Promise.all(names.filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(async (name) => {
      const file = join(folder, name);
      const record = await readReceipt(file);
      return record?.complete && file !== path ? { file, time: (await lstat(file)).mtimeMs } : null;
    }))).filter((item) => item !== null).sort((a, b) => a.time - b.time);
    await Promise.all(completed.slice(0, Math.max(0, names.length - 1000)).map(({ file }) => unlink(file)));
  }
  } catch (error) { console.warn('[projects] Could not prune completed save receipts', error); }
  return saved;
}

/** Finish interrupted exact file plans before any compile or new edit. */
export async function recoverProjectWrites(dir: string, onWrite?: (path: string, text: string) => void): Promise<void> {
  let folder: string;
  try { folder = await journalDirectory(dir, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of (await readdir(folder)).sort()) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
    const path = join(folder, name);
    const record = await readReceipt(path);
    if (record && !record.complete) await finishReceipt(dir, path, record, onWrite);
  }
}
