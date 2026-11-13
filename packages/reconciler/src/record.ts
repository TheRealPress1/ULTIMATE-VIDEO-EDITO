/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What a project says, without a world to say it in. `recordProject` renders a
 * compiled bundle into a document that only writes down what it is told — the
 * elements, their props, their order — instead of building the entities a
 * mount builds. Whoever wants to know what a file comes to, to compare it with
 * what is on the stage, gets it for a small part of the cost of a mount: no
 * entities, no observers, nothing to tear down.
 *
 * The record keeps what `authoredElement` reads off an entity, so the two can
 * be compared: the tag a project used, the props it gave (the source stamp and
 * loop mark apart, as in the runtime document), and the text a `<text>` holds.
 */

import { LOOP_ATTR, SOURCE_ATTR } from '@diffusionstudio/jsx';
import { createSignal } from 'solid-js';

import { evaluate } from './evaluate';
import { collectInspect } from './inspect';
import { renderRooted } from './mount';

import type { ProjectDocument, ProjectTick } from './host';
import type { InspectEntry } from './inspect';

export interface RecordedNode {
	/** The camelCase tag of a composition element, the DOM tag of content under `<html>`, `#text` for a text node. */
	tag: string;
	/** A composition element; anything else is DOM content or text. */
	native: boolean;
	/** The source stamp (`SOURCE_ATTR`), when the element has one. */
	source?: string;
	/** The loop mark (`LOOP_ATTR`), when a loop rendered the element. */
	loop?: string;
	props: Record<string, unknown>;
	parent: RecordedNode | null;
	children: RecordedNode[];
	/** What a text node says. */
	data?: string;
}

export interface Recording {
	/** The root: its children are the scenes. */
	stage: RecordedNode;
	/** What `<stage background>` said, undefined when nothing. */
	background: unknown;
	/** The `@inspect` variables the bundle declared. */
	inspect: InspectEntry[];
	/** Whether anything the project rendered depends on a signal (see `Mount.reactive`). */
	reactive: boolean;
}

const STILL: ProjectTick = { time: 0, frame: 0, delta: 0, playing: false };

const node = (tag: string, native: boolean, rest: Partial<RecordedNode> = {}): RecordedNode =>
	({ tag, native, props: {}, parent: null, children: [], ...rest });

/** Takes `child` out of the children of whatever holds it. */
function detach(child: RecordedNode): void {
	const holder = child.parent;
	if (holder === null) return;
	const at = holder.children.indexOf(child);
	if (at !== -1) holder.children.splice(at, 1);
	child.parent = null;
}

class RecordingDocument implements ProjectDocument<RecordedNode> {
	public readonly stage = node('', true);
	public background: unknown;

	// A project that follows the timeline reads these, and has to be seen to
	// depend on them: a signal each, never moved.
	private readonly clock = createSignal(STILL)[0];
	private readonly density = createSignal(1)[0];

	public createElement(tag: string): RecordedNode {
		// camelCase tags are DOM content; the composition's are PascalCase.
		if (tag.charAt(0) === tag.charAt(0).toLowerCase()) return node(tag, false);

		const name = tag.charAt(0).toLowerCase() + tag.slice(1);
		return name === 'stage' ? this.stage : node(name, true);
	}

	public createTextNode(text: string): RecordedNode {
		return node('#text', false, { data: text });
	}

	public replaceText(target: RecordedNode, text: string): void {
		if (target.tag === '#text') target.data = text;
	}

	public isTextNode(target: RecordedNode): boolean {
		return target.tag === '#text';
	}

	public setProperty(target: RecordedNode, name: string, value: unknown): void {
		if (name === SOURCE_ATTR) {
			target.source = typeof value === 'string' && value ? value : undefined;
		} else if (name === LOOP_ATTR) {
			target.loop = typeof value === 'string' && value ? value : undefined;
		} else if (target === this.stage) {
			// The stage keeps no props of its own (see the runtime document), only its background.
			if (name === 'background') this.background = value;
		} else if (name !== 'children' && name !== 'ref') {
			if (value === undefined) delete target.props[name];
			else target.props[name] = value;
		}
	}

	public insertNode(parent: RecordedNode, child: RecordedNode, anchor?: RecordedNode): void {
		// The renderer puts the project's root, which is the stage, into the stage.
		if (parent === child) return;
		detach(child);
		const at = anchor === undefined ? -1 : parent.children.indexOf(anchor);
		if (at === -1) parent.children.push(child);
		else parent.children.splice(at, 0, child);
		child.parent = parent;
	}

	public removeNode(_parent: RecordedNode, child: RecordedNode): void {
		detach(child);
	}

	public getParentNode(target: RecordedNode): RecordedNode | undefined {
		return target.parent ?? undefined;
	}

	public getFirstChild(target: RecordedNode): RecordedNode | undefined {
		return target.children[0];
	}

	public getNextSibling(target: RecordedNode): RecordedNode | undefined {
		const holder = target.parent;
		if (holder === null) return undefined;
		return holder.children[holder.children.indexOf(target) + 1];
	}

	public tick(): ProjectTick {
		return this.clock();
	}

	public resolution(): number {
		return this.density();
	}

	public hold(): void {}
}

/**
 * Renders the compiled bundle `code` into a record of what it says. Throws
 * when the bundle does not evaluate or does not render, like a mount; and
 * lets through what a mount would refuse (an unknown tag, say), since nothing
 * here knows the elements. What it recorded is a plain tree, and outlives the
 * render: the reactive graph is gone when this returns.
 */
export function recordProject(code: string): Recording {
	const { result: component, entries } = collectInspect(() => evaluate(code));
	const document = new RecordingDocument();
	const rendered = renderRooted(component, document);

	try {
		return { stage: document.stage, background: document.background, inspect: entries, reactive: rendered.reactive() };
	} finally {
		rendered.dispose();
	}
}
