/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The open project, for everything that acts on it. A project is three names
// at once and they come apart: the id is what it *is* (the URL, the key the
// world is under), the folder is where it lives, and the display name is what
// the user calls it. Resolving the URL to a project happens once, in
// ProjectPage; this is that answer, kept current as the project is renamed
// underneath the editor, and as a draft is saved or a project is moved and its
// folder goes with it.

import { createContext, createMemo, createSignal, onCleanup, onMount, useContext, type Accessor, type JSX } from 'solid-js';
import { toast } from 'somoto';
import { useBeforeLeave } from '@solidjs/router';

import { moveProject, pickSaveLocation, refreshProject, renameProject, saveProject } from '@/projects';
import { flushProjectEdits, projectSaveState, retryProjectEdits } from '@/projects/edits';

import type { ProjectInfo } from '@/projects';

export type ProjectContextValue = {
	/** package.json `projectId`: what the project is, whatever it is called. */
	id: Accessor<string>;
	/** Absolute project folder; empty while a draft's folder is being moved. */
	dir: Accessor<string>;
	/** Whether the project is a draft: in the app's drafts folder until it is saved. */
	draft: Accessor<boolean>;
	/** package.json `displayName`: what the user calls it. */
	name: Accessor<string>;
	/** Renames the project — the record; the folder keeps its name. */
	rename: (displayName: string) => Promise<void>;
	/** Re-reads the record, for when something else wrote it. */
	refresh: () => Promise<void>;
	/**
	 * Saves a draft: asks where, and moves its folder there. False when there
	 * was nothing to save (not a draft, a save already running) or the user
	 * cancelled.
	 */
	save: () => Promise<boolean>;
	/**
	 * Moves a saved project: asks where, and moves its folder there. False
	 * when there was nothing to move (a draft, a move already running) or the
	 * user cancelled.
	 */
	move: () => Promise<boolean>;
};

const ProjectContext = createContext<ProjectContextValue>();

export function ProjectProvider(props: { project: ProjectInfo; children: JSX.Element }) {
	// Seeded once: the subtree is keyed on the project, so a different one
	// arrives as a new provider rather than as a new value here.
	const [info, setInfo] = createSignal(props.project);

	// While a draft's folder moves nothing may hold it: the editor keys
	// everything that does — the watcher, the library, the writer, which
	// flushes what it still owes as it goes — on `dir`, so an empty one lets
	// go of the folder, and the new one attaches it all again where it went.
	const [moving, setMoving] = createSignal(false);
	// One save or move at a time: both move the folder.
	let saving = false;

	// Memos, not plain reads: a refresh that found nothing new must not look
	// like a change.
	const id = createMemo(() => info().id);
	const dir = createMemo(() => (moving() ? '' : info().dir));
	const name = createMemo(() => info().displayName);
	const draft = createMemo(() => !!info().draft);

	// Navigation must finish before Solid disposes the current editor. An
	// unresolved failure leaves the project open, with its retryable journal.
	let leaving = false;
	useBeforeLeave((event) => {
		if (projectSaveState(info().dir).status === 'saved') return;
		event.preventDefault();
		if (leaving) return;
		leaving = true;
		void flushProjectEdits(info().dir).then(() => event.retry(true)).catch((error) => {
			toast.error('Save your changes before leaving this project', { description: (error as Error).message });
		}).finally(() => { leaving = false; });
	});

	const rename = async (displayName: string): Promise<void> => {
		setInfo(await renameProject(dir(), displayName));
	};

	const refresh = async (): Promise<void> => {
		const next = await refreshProject(dir());
		if (next) setInfo(next);
	};

	const save = async (): Promise<boolean> => {
		if (saving) return false;
		if (!draft()) {
			await retryProjectEdits(info().dir);
			return false;
		}
		saving = true;
		try {
			const from = info().dir;
			// Asked before anything lets go: the user can still cancel, and the
			// editor keeps working behind the picker meanwhile.
			const target = await pickSaveLocation(from, info().displayName);
			if (!target) return false;

			await retryProjectEdits(from);
			setMoving(true);
			try {
				setInfo(await saveProject(from, target));
			} finally {
				setMoving(false);
			}
			return true;
		} finally {
			saving = false;
		}
	};

	const move = async (): Promise<boolean> => {
		if (draft() || saving) return false;
		saving = true;
		try {
			const from = info().dir;
			const target = await pickSaveLocation(from, info().name, 'move');
			if (!target) return false;

			await flushProjectEdits(from);
			setMoving(true);
			try {
				setInfo(await moveProject(from, target));
			} finally {
				setMoving(false);
			}
			return true;
		} finally {
			saving = false;
		}
	};

	/** ⌘S saves a draft, or explicitly retries/flushes a saved project's edits. */
	const handleShortcut = async (event: KeyboardEvent) => {
		if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
		if (event.key.toLowerCase() !== 's') return;

		event.preventDefault();

		try {
			await save();
		} catch (error: unknown) {
			toast.error('Failed to save project', { description: (error as Error).message });
		}
	};

	onMount(() => window.addEventListener('keydown', handleShortcut));
	onCleanup(() => window.removeEventListener('keydown', handleShortcut));

	return (
		<ProjectContext.Provider value={{ id, dir, draft, name, rename, refresh, save, move }}>
			{props.children}
		</ProjectContext.Provider>
	);
}

export function useProject(): ProjectContextValue {
	const project = useContext(ProjectContext);
	if (!project) throw new Error('useProject must be used within a ProjectProvider');
	return project;
}
