/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Tickers } from '@diffusionstudio/runtime';
import { getOwner } from 'solid-js';

import { createRuntimeDocument } from './document';
import { evaluate } from './evaluate';
import { collectInspect } from './inspect';
import { renderProject } from './renderer';

import type { World } from 'koota';
import type { ProjectDocument } from './host';
import type { InspectEntry } from './inspect';

export interface Mount {
	/** Tears down the reactive graph and every entity the project rendered. */
	dispose(): void;
	/**
	 * The `@inspect` variables the bundle declared, in declaration order, each
	 * holding the live signal the composition reads. Die with the mount: a
	 * remount evaluates the module again and declares them afresh.
	 */
	inspect: InspectEntry[];
	/**
	 * Whether anything the project rendered still depends on a signal, so that
	 * it can write to the document again by itself (a ticker, an `@inspect`
	 * variable, a signal of its own). A mount with none is finished once it
	 * has rendered: what is in the document is all it will ever say, and an
	 * editor may change that without the project overwriting it. True for a
	 * graph this cannot read, since it cannot vouch for it. Read it when it
	 * matters; a signal can be created after the first render.
	 */
	reactive(): boolean;
}

/** What a computation reads: a signal proper, or another computation (a memo) that has sources of its own. */
interface SourceNode {
	/** Present on a computation, absent on a signal. */
	fn?: unknown;
	sources?: SourceNode[] | null;
}

/** The part of Solid's owner graph a dependency check reads. */
interface GraphNode {
	/** What a computation reads; absent on an owner that is no computation. */
	sources?: SourceNode[] | null;
	owned?: GraphNode[] | null;
}

/**
 * Whether `node` or anything it owns reads a signal. Solid does not export its
 * graph, so what is read here is its documented shape (`getOwner`) plus the
 * fields every 1.x computation carries; an owner without the first is one this
 * does not know how to walk.
 *
 * Reading a memo is not reading a signal: Solid makes a memo of every
 * conditional in JSX (`a ? <x /> : <y />`), and the effect that places its
 * result reads it, though nothing outside can ever move it. A memo moves only
 * when something it reads does, so what a computation reads is followed down
 * to a signal proper, which is what has no function.
 */
function dependsOnSignals(node: GraphNode | null): boolean {
	if (node === null || !('owned' in node)) return true;

	const moves = (source: SourceNode): boolean =>
		typeof source.fn !== 'function' || (source.sources?.some(moves) ?? false);
	const walk = (current: GraphNode): boolean =>
		(current.sources?.some(moves) ?? false) || (current.owned?.some(walk) ?? false);
	return walk(node);
}

/**
 * Renders `component` into `document`, noting the owner its computations hang
 * from: the owner in effect as the project starts rendering, which is what
 * `reactive` walks. Returns how to drop the reactive graph again.
 */
export function renderRooted<N>(
	component: () => unknown,
	document: ProjectDocument<N>,
): { dispose: () => void; reactive: () => boolean } {
	let owner: GraphNode | null = null;
	const project = (): unknown => {
		owner = getOwner() as GraphNode | null;
		return component();
	};

	return { dispose: renderProject(project, document), reactive: () => dependsOnSignals(owner) };
}

/**
 * Renders a compiled project bundle into `world`. Throws if the bundle does
 * not evaluate, if its root is not a <stage>, or if `world` still has a
 * mounted project (dispose that one first — the stage is a singleton, so
 * two mounts would render into each other); nothing is left behind in the
 * world when it throws.
 *
 * The mount stays live: it puts the document's ticker advance into the
 * world's `Tickers`, and the playback system fires it once per tick, which
 * is what `useTicker` subscribes to.
 */
export function mount(code: string, world: World): Mount {
	const { result: component, entries } = collectInspect(() => evaluate(code));
	const document = createRuntimeDocument(world);

	let rendered: ReturnType<typeof renderRooted>;
	try {
		rendered = renderRooted(component, document);
	} catch (error) {
		document.dispose();
		throw error;
	}

	const advance = () => document.advanceTicker();
	world.get(Tickers)?.add(advance);

	return {
		inspect: entries,
		reactive: rendered.reactive,
		dispose() {
			world.get(Tickers)?.delete(advance);
			// Solid's universal render disposer only drops the reactive graph;
			// the document owns the entities.
			rendered.dispose();
			document.dispose();
		},
	};
}
