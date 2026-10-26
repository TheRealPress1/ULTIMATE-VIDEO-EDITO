/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import { getDocumentEditor } from '@/engine/editor';
import { toast } from 'somoto';
import { createSignal } from 'solid-js';

import { writeProject } from './host';

import type { EntityEdit, InsertEdit, MoveEdit, RemoveEdit, UnrollEdit, VariableEdit } from '@/engine/editor';
import type { SourceEdit, WriteResult } from './host';
import type { World } from 'koota';

/**
 * How long edits pile up before they are written. Long enough that a drag is
 * one write, short enough that letting go of a slider and looking at the file
 * shows the value that is on the canvas.
 */
const DEBOUNCE = 120;

export type ProjectSaveState = {
	status: 'saved' | 'saving' | 'error';
	error?: string;
	savedAt?: number;
};

export interface ProjectSaveParticipant {
	state(): ProjectSaveState;
	flush(): Promise<void>;
	retry(): Promise<void>;
}

const writers = new Map<string, Set<EditWriter>>();
const participants = new Map<string, Set<ProjectSaveParticipant>>();
const editRevisions = new Map<string, number>();
const recoveryFailures = new Map<string, Error>();
const [revision, setRevision] = createSignal(0);
const changed = (): void => { setRevision((value) => value + 1); };

/** Detects gestures arriving while a project compile was in flight. */
export const projectEditRevision = (dir: string): number => editRevisions.get(dir) ?? 0;

/** Asset manifests and export settings join the same close/export barrier. */
export function registerProjectSaveParticipant(dir: string, participant: ProjectSaveParticipant): () => void {
	const entries = participants.get(dir) ?? new Set();
	entries.add(participant);
	participants.set(dir, entries);
	changed();
	return () => {
		entries.delete(participant);
		if (!entries.size) participants.delete(dir);
		changed();
	};
}

const selectedParticipants = (dir?: string): ProjectSaveParticipant[] => dir === undefined
	? [...participants.values()].flatMap((entries) => [...entries])
	: [...(participants.get(dir) ?? [])];

/** Reactive save status. An error remains visible until an explicit retry succeeds. */
export function projectSaveState(dir?: string): ProjectSaveState {
	revision();
	const recoveryError = dir === undefined ? recoveryFailures.values().next().value : recoveryFailures.get(dir);
	if (recoveryError) return { status: 'error', error: recoveryError.message };
	const states = [...selectedWriters(dir), ...selectedParticipants(dir)].map((writer) => writer.state());
	const failure = states.find((state) => state.status === 'error');
	if (failure) return failure;
	if (states.some((state) => state.status === 'saving')) return { status: 'saving' };
	const savedAt = Math.max(0, ...states.map((state) => state.savedAt ?? 0));
	return { status: 'saved', ...(savedAt ? { savedAt } : {}) };
}

const selectedWriters = (dir?: string): EditWriter[] => dir === undefined
	? [...writers.values()].flatMap((entries) => [...entries])
	: [...(writers.get(dir) ?? [])];

/** Waits for every edit, including edits made while a previous write was pending. */
export async function flushProjectEdits(dir?: string): Promise<void> {
	const recoveryError = dir === undefined ? recoveryFailures.values().next().value : recoveryFailures.get(dir);
	if (recoveryError) throw recoveryError;
	await Promise.all([...selectedWriters(dir), ...selectedParticipants(dir)].map((writer) => writer.flush()));
}

/** Retries the exact failed operation before writing any newer edits. */
export async function retryProjectEdits(dir?: string): Promise<void> {
	for (const failedDir of [...recoveryFailures.keys()]) {
		if (dir === undefined || failedDir === dir) await recoverProjectEdits(failedDir);
	}
	await Promise.all([...selectedWriters(dir), ...selectedParticipants(dir)].map((writer) => writer.retry()));
}

type WriteBatch = { operationId: string; edits: SourceEdit[] };

interface EditJournal {
	version: 1;
	dir: string;
	batch?: WriteBatch;
	unrolls: [string, UnrollEdit][];
	inserts: [string, InsertEdit][];
	moves: [string, MoveEdit][];
	props: [string, InsertEdit['props']][];
	texts: [string, string][];
	removes: string[];
	variables: [string, VariableEdit][];
	inflight: string[];
	sent: UnrollEdit[];
}

const journalKey = (dir: string): string => `cutroom:pending-edits:v1:${dir}`;

/**
 * Replays the local journal before compiling/mounting the scene. A receipt
 * from main resolves an interrupted in-flight request without inserting twice.
 * Buffered edits then follow with the real source identities from that receipt.
 */
export async function recoverProjectEdits(dir: string): Promise<void> {
	if (selectedWriters(dir).length) return flushProjectEdits(dir);
	let writer: EditWriter;
	try {
		const stored = localStorage.getItem(journalKey(dir));
		if (!stored) {
			recoveryFailures.delete(dir);
			changed();
			return;
		}
		const journal = JSON.parse(stored) as EditJournal;
		if (journal.version !== 1 || journal.dir !== dir ||
			![journal.unrolls, journal.inserts, journal.moves, journal.props, journal.texts, journal.removes, journal.variables, journal.inflight, journal.sent].every(Array.isArray) ||
			(journal.batch && (typeof journal.batch.operationId !== 'string' || !Array.isArray(journal.batch.edits)))) throw new Error('Invalid journal');
		// Rebuilding the pending maps is part of reading the journal. A broken
		// entry must leave a visible, retryable recovery error as well.
		writer = new EditWriter(dir, undefined, journal);
	} catch {
		const error = new Error('The saved edit recovery record could not be read. It has been kept for recovery; the project has not been overwritten.');
		recoveryFailures.set(dir, error);
		changed();
		throw error;
	}
	recoveryFailures.delete(dir);
	writer.detach();
	await writer.flush();
}

class EditWriter {
	private readonly dir: string;
	private readonly world: World | undefined;

	// Unrolls first: everything else addressed to what a loop rendered is
	// addressed to the copies the unroll makes. Then inserts, in the order
	// they were made (a child's parent may be one of them), then the moves,
	// then per element, per prop: the last value for a prop is the only one
	// worth writing, an element written twice is written once, and only where
	// an element ended up is worth moving it to. Removes last: nothing else
	// addressed to a removed element is worth writing, and once cut, an
	// unnamed element's neighbours are elsewhere.
	private unrolls = new Map<string, UnrollEdit>();
	private inserts = new Map<string, InsertEdit>();
	private moves = new Map<string, MoveEdit>();
	private pending = new Map<string, InsertEdit['props']>();
	// What a `<text>` says, by element. Its own map rather than a prop: the
	// file spells it between the tags, and the last value is the only one
	// worth writing, same as a prop's.
	private texts = new Map<string, string>();
	private removes = new Set<string>();
	// `@inspect` variables, by file and name. Independent of the elements:
	// nothing else addresses one, and none of them is ever pending.
	private variables = new Map<string, VariableEdit>();
	// Pending sources a write is out for: edits to them wait for the answer.
	private inflight = new Set<string>();
	// The unrolls a write is out for. One the write declines is taken back
	// (its entities go back to the loop) rather than discarded like a failed
	// insert: the loop still renders them, it just cannot be written to.
	private sent: UnrollEdit[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private running: Promise<void> | undefined;
	private batch: WriteBatch | undefined;
	private failure: Error | undefined;
	private savedAt: number | undefined;

	public constructor(dir: string, world: World | undefined, journal?: EditJournal) {
		this.dir = dir;
		this.world = world;
		if (journal) {
			this.batch = journal.batch;
			this.unrolls = new Map(journal.unrolls);
			this.inserts = new Map(journal.inserts);
			this.moves = new Map(journal.moves);
			this.pending = new Map(journal.props);
			this.texts = new Map(journal.texts);
			this.removes = new Set(journal.removes);
			this.variables = new Map(journal.variables);
			this.inflight = new Set(journal.inflight);
			this.sent = journal.sent;
		}
		const entries = writers.get(dir) ?? new Set();
		entries.add(this);
		writers.set(dir, entries);
		changed();
	}

	public state(): ProjectSaveState {
		if (this.failure) return { status: 'error', error: this.failure.message };
		if (this.running || this.batch || this.hasPending()) return { status: 'saving' };
		return { status: 'saved', savedAt: this.savedAt };
	}

	private hasPending(): boolean {
		return !!(this.unrolls.size || this.inserts.size || this.moves.size || this.pending.size || this.texts.size || this.removes.size || this.variables.size);
	}

	/** Records an edit; the write follows once edits stop arriving. */
	public push(edit: EntityEdit): void {
		if (this.disposed) return;
		editRevisions.set(this.dir, projectEditRevision(this.dir) + 1);

		if (edit.kind === 'unroll') {
			this.unrolls.set(edit.source, edit);
		} else if (edit.kind === 'insert') {
			this.inserts.set(edit.source, edit);
		} else if (edit.kind === 'remove') {
			this.remove(edit);
		} else if (edit.kind === 'move') {
			// Where an element still waiting to be inserted goes is part of how
			// it is inserted, not a move of it.
			const insert = this.inserts.get(edit.source);

			if (insert) {
				const moved: InsertEdit = { ...insert, parent: edit.parent };
				if (edit.before === undefined) delete moved.before;
				else moved.before = edit.before;
				this.inserts.set(edit.source, moved);
			} else {
				this.moves.set(edit.source, edit);
			}
		} else if (edit.kind === 'variable') {
			// The last value is the only one worth writing, like a prop's.
			this.variables.set(`${edit.file}\n${edit.name}`, edit);
		} else if (edit.kind === 'text') {
			// What an element still waiting to be inserted says is part of how
			// it is inserted, the way a prop of it is.
			const insert = this.inserts.get(edit.source);
			if (insert) insert.text = edit.value;
			else this.texts.set(edit.source, edit.value);
		} else {
			// A prop of an element still waiting to be inserted is part of how
			// it is inserted.
			const insert = this.inserts.get(edit.source);
			if (insert) insert.props = { ...insert.props, [edit.name]: edit.value };
			else this.pending.set(edit.source, { ...this.pending.get(edit.source), [edit.name]: edit.value });
		}

		try { this.persist(); }
		catch (error) { this.fail(error); }
		this.schedule();
		changed();
	}

	/** Writes what is pending and stops. */
	public dispose(): void {
		clearTimeout(this.timer);
		// The last edits still belong in the file, even though the entities
		// they came from are on their way out.
		this.disposed = true;
		void this.flush().catch(() => { /* The retained writer keeps its failure visible and retryable. */ });
		this.releaseIfSaved();
	}

	/** Recovery has no mounted canvas to notify. */
	public detach(): void {
		this.disposed = true;
		this.releaseIfSaved();
	}

	private persist(): void {
		if (!this.batch && !this.hasPending()) {
			localStorage.removeItem(journalKey(this.dir));
			return;
		}
		const journal: EditJournal = {
			version: 1, dir: this.dir, batch: this.batch,
			unrolls: [...this.unrolls], inserts: [...this.inserts], moves: [...this.moves],
			props: [...this.pending], texts: [...this.texts], removes: [...this.removes],
			variables: [...this.variables], inflight: [...this.inflight], sent: this.sent,
		};
		try { localStorage.setItem(journalKey(this.dir), JSON.stringify(journal)); }
		catch (error) { throw new Error(`Could not keep an edit recovery record: ${error instanceof Error ? error.message : String(error)}. Keep this project open and retry saving.`); }
	}

	private fail(error: unknown): Error {
		this.failure = error instanceof Error ? error : new Error(String(error));
		changed();
		toast.error('Changes have not been saved', { description: this.failure.message });
		return this.failure;
	}

	private releaseIfSaved(): void {
		if (!this.disposed || this.running || this.batch || this.hasPending() || this.failure) return;
		const entries = writers.get(this.dir);
		entries?.delete(this);
		if (!entries?.size) writers.delete(this.dir);
		changed();
	}

	/**
	 * Forgets everything owed to an element that is going, and to whatever
	 * was to be inserted under it: the entities went with it, so those inserts
	 * have no element to become. An element the file never had (an insert
	 * still waiting here) is simply not inserted; one it has, or that a write
	 * out right now is naming, is removed by name.
	 */
	private remove(edit: RemoveEdit): void {
		const doomed = new Set([edit.source]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const insert of this.inserts.values()) {
				if (doomed.has(insert.parent) && !doomed.has(insert.source)) {
					doomed.add(insert.source);
					grew = true;
				}
			}
		}

		// An insert still waiting here never reached the file: dropping it is
		// the whole removal. Anything else the file has, or a write out right
		// now is naming, and it goes from there by name.
		if (!this.inserts.has(edit.source)) this.removes.add(edit.source);
		for (const source of doomed) {
			this.inserts.delete(source);
			this.pending.delete(source);
			this.texts.delete(source);
			this.moves.delete(source);
		}

		// Placement in front of an element that is gone means "last" now, the
		// same answer the write gives to an anchor it cannot find.
		for (const [source, insert] of this.inserts) {
			if (insert.before !== undefined && doomed.has(insert.before)) {
				const { before: _, ...rest } = insert;
				this.inserts.set(source, rest);
			}
		}
		for (const [source, move] of [...this.moves]) {
			if (doomed.has(move.parent)) this.moves.delete(source);
			else if (move.before !== undefined && doomed.has(move.before)) {
				const { before: _, ...rest } = move;
				this.moves.set(source, rest);
			}
		}
	}

	private schedule(): void {
		clearTimeout(this.timer);
		if (this.failure || this.running) return;
		this.timer = setTimeout(() => { void this.flush().catch(() => { }); }, DEBOUNCE);
	}

	public flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.running) return this.running;
		if (this.failure) return Promise.reject(this.failure);
		if (!this.batch && !this.hasPending()) {
			this.releaseIfSaved();
			return Promise.resolve();
		}
		this.running = this.drain().finally(() => {
			this.running = undefined;
			this.releaseIfSaved();
			changed();
		});
		changed();
		return this.running;
	}

	public retry(): Promise<void> {
		if (this.running) return this.running;
		this.failure = undefined;
		try { this.persist(); }
		catch (error) { return Promise.reject(this.fail(error)); }
		changed();
		return this.flush();
	}

	private async drain(): Promise<void> {
		try {
			while (this.batch || this.hasPending()) {
				this.batch ??= this.takeBatch();
				if (!this.batch) throw new Error('Some edits are waiting for source identities that could not be saved. Keep this project open and retry saving.');
				this.persist();
				// The ID belongs to the exact immutable batch. Desktop receipts make
				// replay safe even when a successful response was lost in transit.
				const result = await writeProject(this.dir, this.batch.edits, this.batch.operationId);
				if (result.error) throw new Error(result.error);
				if (result.skipped.length) throw new Error(`Could not save ${result.skipped.length} edit(s): ${result.skipped.join(', ')}`);
				this.report(result);
				this.batch = undefined;
				this.savedAt = Date.now();
				this.persist();
			}
		} catch (error) {
			throw this.fail(error);
		}
	}

	private takeBatch(): WriteBatch | undefined {
		if (!this.hasPending()) return;

		// Anything addressed through an element whose insert is still out
		// waits for its name: edits to it, and inserts or moves under or
		// beside it.
		const waits = (source: string | undefined): boolean => source !== undefined && this.inflight.has(source);
		// An insert waits for one it is going under, or in front of, that is
		// waiting itself: it has no name to be addressed by yet either. The
		// inserts come in dependency order, so the one being waited for has
		// been seen by the time the one waiting is.
		const ordered = this.orderedInserts();
		const heldInserts = new Map<string, InsertEdit>();
		const unnamed = (source: string | undefined): boolean => source !== undefined && (waits(source) || heldInserts.has(source));
		for (const insert of ordered) {
			if (unnamed(insert.parent) || unnamed(insert.before)) heldInserts.set(insert.source, insert);
		}
		const heldMoves = new Map([...this.moves].filter(([source, move]) => waits(source) || unnamed(move.parent) || unnamed(move.before)));
		const held = new Map([...this.pending].filter(([source]) => waits(source)));
		const heldTexts = new Map([...this.texts].filter(([source]) => waits(source)));
		const heldRemoves = new Set([...this.removes].filter(waits));
		const edits: SourceEdit[] = [
			// First: the copies an unroll makes are what the rest is addressed to.
			...[...this.unrolls.values()].map(({ kind, source, iterations }): SourceEdit => ({ kind, source, iterations })),
			...ordered
				.filter((insert) => !heldInserts.has(insert.source))
				.map(({ kind, source, parent, tag, props, before, text }): SourceEdit => ({
					kind,
					source,
					parent,
					tag,
					props,
					...(before === undefined ? {} : { before }),
					...(text === undefined ? {} : { text }),
				})),
			// After the inserts: a move may be into an element this same write
			// is adding. Before the props, which then land on it where it is.
			...[...this.moves.values()]
				.filter((move) => !heldMoves.has(move.source))
				.map(({ kind, source, parent, before }): SourceEdit => ({
					kind,
					source,
					parent,
					...(before === undefined ? {} : { before }),
				})),
			// One `set` per element, whatever it changed: a prop, its text, or both.
			...[...new Set([...this.pending.keys(), ...this.texts.keys()])]
				.filter((source) => !held.has(source) && !heldTexts.has(source))
				.map((source): SourceEdit => ({
					kind: 'set',
					source,
					props: this.pending.get(source) ?? {},
					...(this.texts.has(source) ? { text: this.texts.get(source)! } : {}),
				})),
			// Last: cutting an unnamed element moves the positions of everything
			// after it, and nothing above is addressed to what is being removed.
			...[...this.removes]
				.filter((source) => !heldRemoves.has(source))
				.map((source): SourceEdit => ({ kind: 'remove', source })),
			// Variables are addressed by name, so nothing above moves them.
			...[...this.variables.values()]
				.map(({ file, name, value }): SourceEdit => ({ kind: 'variable', file, name, value })),
		];
		if (!edits.length) return;

		// The names an unroll handed out are out with it.
		this.sent = [...this.unrolls.values()];
		this.unrolls = new Map();
		this.variables = new Map();
		this.inflight = new Set([
			...[...this.inflight, ...this.inserts.keys()].filter((source) => !heldInserts.has(source)),
			...this.sent.flatMap((unroll) => pendingsOf(unroll)),
		]);
		this.inserts = heldInserts;
		this.moves = heldMoves;
		this.pending = held;
		this.texts = heldTexts;
		this.removes = heldRemoves;

		return { operationId: crypto.randomUUID(), edits: structuredClone(edits) };
	}

	/**
	 * The inserts in an order a write can take them in: an element after the
	 * one it goes under and after the sibling it is placed in front of, since
	 * neither can be addressed until it has a name. The order they were made
	 * in says that already for a tree built downwards, but not for an element
	 * moved into one made after it — a split's copy into the sequence that
	 * wraps the two halves — where the move is folded into an insert that is
	 * still waiting.
	 */
	private orderedInserts(): InsertEdit[] {
		const ordered: InsertEdit[] = [];
		const placed = new Set<string>();
		const waiting = [...this.inserts.values()];
		const owed = (source: string | undefined): boolean => source !== undefined && this.inserts.has(source) && !placed.has(source);

		// A pass that places nothing is the end of it: what is left waits on
		// itself, and goes last rather than being dropped.
		for (let moved = true; moved && waiting.length; ) {
			moved = false;
			for (let index = 0; index < waiting.length; ) {
				const insert = waiting[index]!;
				if (owed(insert.parent) || owed(insert.before)) {
					index++;
					continue;
				}
				ordered.push(insert);
				placed.add(insert.source);
				waiting.splice(index, 1);
				moved = true;
			}
		}

		return [...ordered, ...waiting];
	}

	private report(result: WriteResult): void {
		const ids = result.ids ?? {};
		const editor = this.disposed || !this.world ? undefined : getDocumentEditor(this.world);
		editor?.restamp(ids);

		// An unroll the write declined: the loop's entities go back to being the
		// loop's, and to the source they had (which the writer refuses to write
		// into, so nothing owed to them below reaches the loop body).
		const restored = new Set<string>();
		const unrolled = new Set(result.unrolled ?? []);
		for (const unroll of this.sent) {
			if (unrolled.has(unroll.source)) continue;
			editor?.unsettle(unroll);
			for (const pending of pendingsOf(unroll)) restored.add(pending);
		}
		this.sent = [];

		// What piled up under a pending name while its write was out now
		// belongs to the real one, or to nothing if the file would not have it.
		const rename = (source: string): string | undefined => (this.inflight.has(source) ? ids[source] : source);
		for (const source of [...this.pending.keys()]) {
			const next = rename(source);
			if (next === source) continue;
			const props = this.pending.get(source)!;
			this.pending.delete(source);
			if (next) this.pending.set(next, { ...this.pending.get(next), ...props });
		}
		for (const source of [...this.texts.keys()]) {
			const next = rename(source);
			if (next === source) continue;
			const text = this.texts.get(source)!;
			this.texts.delete(source);
			if (next) this.texts.set(next, text);
		}
		for (const [source, insert] of [...this.inserts]) {
			const parent = rename(insert.parent);
			if (parent === undefined) {
				// Its parent never made it into the file, so neither can it.
				this.inserts.delete(source);
				editor?.discardPending(source);
				continue;
			}
			// An anchor that did not make it just means "last".
			const before = insert.before === undefined ? undefined : rename(insert.before);
			const { before: _, ...rest } = insert;
			this.inserts.set(source, { ...rest, parent, ...(before === undefined ? {} : { before }) });
		}
		for (const [source, move] of [...this.moves]) {
			const next = rename(source);
			const parent = rename(move.parent);
			// Neither the element nor the place it was going made it into the
			// file; the insert's own discard takes the entity with it.
			if (next === undefined || parent === undefined) {
				this.moves.delete(source);
				continue;
			}
			const before = move.before === undefined ? undefined : rename(move.before);
			this.moves.delete(source);
			this.moves.set(next, { ...move, source: next, parent, ...(before === undefined ? {} : { before }) });
		}
		for (const source of [...this.removes]) {
			const next = rename(source);
			if (next === source) continue;
			this.removes.delete(source);
			// An element the file never had needs no removing from it.
			if (next) this.removes.add(next);
		}
		for (const source of this.inflight) {
			if (!ids[source] && !restored.has(source)) editor?.discardPending(source);
		}
		this.inflight = new Set();

		// drain() writes held-back edits with their newly assigned names next.
	}
}

/** The pending sources an unroll stamped on the iterations it wrote out. */
const pendingsOf = (unroll: UnrollEdit): string[] => {
	return unroll.iterations
		.flatMap((iteration) => Object.values(iteration)
			.flatMap(({ pending }) => (pending ? [pending] : [])));
}

/**
 * Collects edits against the project in `dir` and writes them back.
 *
 * `world` is only read after a write returns, to answer the one thing a write
 * can tell the canvas: an element that had no `id` in the source has one now,
 * and the entity it produced has to be re-stamped with it. Without that, the
 * next edit to the same element would still address it by a position the
 * write itself may have invalidated.
 */
export function createEditWriter(dir: string, world: World): EditWriter {
	return new EditWriter(dir, world);
}

export type { EditWriter };
