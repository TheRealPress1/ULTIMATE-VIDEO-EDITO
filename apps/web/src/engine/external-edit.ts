/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Bringing a mounted project up to date when its file was edited by someone
 * else (an agent, a text editor, a checkout), without mounting it again.
 *
 * A mount from scratch throws away every entity: playback stops, the media
 * decoders start over, the selection and the undo history are gone. Most
 * edits to a file are small — a clip trimmed, a volume changed, a title
 * retyped, a clip added or dropped — so the new file is rendered into a
 * record of what it says, compared with what is on the stage element by
 * element (an element is named by its source stamp; where one stamp names
 * several, because a template rendered them from data, by its place among
 * them), and only the difference is made to the stage, through the same editor
 * commands any change of the user's goes through. The history keeps it as one
 * step, so an undo takes the edit back — except in a project built from
 * templates, where the history could not name what to put back — and the
 * writer is not told, because the file already says it.
 *
 * Nothing here is trusted until it is checked: once the difference is made,
 * the stage is read again and has to say exactly what the new file says, and
 * the tests hold the result against a fresh mount of the file, trait by trait.
 * Whatever this cannot do in place — a project that reacts to signals, a loop,
 * HTML content, a scene added — it declines, and the caller mounts afresh.
 */

import { isPropValue } from '@diffusionstudio/jsx';
import { authoredElement, recordProject, renderAuthored } from '@diffusionstudio/reconciler';
import { Background, bubbleTimeRangeUp, colorToHex, DEFAULT_BACKGROUND, getEntityChildren, getParentEntity, Loop, parseColor, recomputeEntityTimeRange, Root, Source } from '@diffusionstudio/runtime';

import { getDocumentEditor, isPendingSource } from './editor';
import { getEditHistory, VIEW_PROPS } from './history';

import type { PropValue } from '@diffusionstudio/jsx';
import type { Mount, RecordedNode } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';
import type { DocumentEditor } from './editor';

/**
 * An element as the comparison sees it: what a project authored — its tag,
 * its props, what a `<text>` says — under the stamp that names it, with its
 * children in order.
 */
interface Tree {
	source: string;
	tag: string;
	props: Record<string, PropValue>;
	text?: string;
	children: Tree[];
	/** The entity it was read from; only on what was read off the stage. */
	entity?: Entity;
}

/** The whole composition: the stage's background and the scenes on it. */
interface Composition {
	background: string;
	scenes: Tree[];
}

/**
 * What became of a file edit: made on the stage (`undoable` says whether the
 * history took it as a step), or left to a mount from scratch, with why.
 */
export type ExternalEdit = { applied: true; changes: number; undoable: boolean } | { applied: false; reason: string };

/** Raised for a change this does not make in place; carries why. */
class Refusal extends Error {}

function refuse(reason: string): never {
	throw new Refusal(reason);
}

/**
 * Elements whose content lives outside their props — a DOM subtree, a canvas
 * — so that comparing props would call two different ones the same.
 */
const OPAQUE: ReadonlySet<string> = new Set(['html', 'htmlPaint', 'surface', 'surfacePaint']);

/**
 * The elements a prop may be taken off in place, and the props that may be.
 * Setting a prop again is what a render does when a value changes, so any
 * prop can be changed or added; taking one off is only as good as the
 * handler's way of forgetting it. Of the props an element takes, all but a
 * few go back to being what they were never set to. The rest keep what they
 * had: a size stays the old size instead of going back to the element's own,
 * a rotation, a per-axis scale or an offset stays at zero instead of being
 * absent. The table is what the tests found equal to a fresh mount (see the
 * matrix there), so a prop that is not in it is left to a mount from scratch.
 * Captions are not in it: one without a length takes the length of what holds
 * it as that stood when it was last measured, so what taking a prop off one
 * comes to depends on what happened before, which a fresh mount cannot repeat.
 */
const REMOVABLE_TAGS: ReadonlySet<string> = new Set([
	'video', 'image', 'audio', 'rect', 'ellipse', 'text', 'group', 'scene', 'sequence', 'animation', 'effect',
]);
const REMOVABLE_PROPS: ReadonlySet<string> = new Set([
	'name', 'x', 'y', 'hidden', 'opacity', 'blendMode', 'scale', 'cornerRadius', 'cornerRadiusTopLeft', 'keepAspectRatio',
	'pivotX', 'pivotY', 'constrainX', 'constrainY', 'start', 'end', 'sourceIn', 'sourceOut', 'playbackRate', 'volume', 'muted',
	'objectFit', 'transition', 'fill', 'color', 'colors', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing',
	'textCase', 'textAlign', 'textBaseline', 'leading', 'preset', 'verticalAlign', 'phase', 'duration', 'delay',
]);

/**
 * How far apart two numbers may be and still be the same value: the file keeps
 * two decimals (see the writer), so a value the editor has since changed and
 * the file has rounded is not a change someone else made.
 */
const TOLERANCE = 0.005 + 1e-9;

function sameValue(a: unknown, b: unknown): boolean {
	if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= TOLERANCE;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
	}
	if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		return [...keys].every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
	}
	return a === b;
}

/** What the stage and a record each say of an element, before it is checked and trimmed into a `Tree`. */
interface Raw {
	tag: string;
	source: string | undefined;
	looped: boolean;
	props: Record<string, unknown>;
	text: string | undefined;
	children: Raw[];
	entity?: Entity;
}

/** `entity` and what is under it, or undefined for an entity the runtime derived rather than a project authored. */
function rawOfEntity(world: World, entity: Entity): Raw | undefined {
	const element = authoredElement(entity);
	if (!element) return undefined;

	const children: Raw[] = [];
	for (const child of getEntityChildren(world, entity)) {
		const raw = rawOfEntity(world, child);
		if (raw) children.push(raw);
	}
	return { tag: element.tag, source: entity.get(Source)?.value, looped: entity.has(Loop), props: element.props, text: element.text, children, entity };
}

/** `node` and what is under it, or undefined for DOM content and text, which a record keeps but the stage does not. */
function rawOfRecorded(node: RecordedNode): Raw | undefined {
	if (!node.native) return undefined;

	const children: Raw[] = [];
	let text = '';
	for (const child of node.children) {
		const raw = rawOfRecorded(child);
		if (raw) children.push(raw);
		else if (child.tag === '#text') text += child.data ?? '';
	}
	return { tag: node.tag, source: node.source, looped: node.loop !== undefined, props: node.props, text: text || undefined, children };
}

/** Checks what is said of an element, and keeps of it what a comparison reads. */
function tree(raw: Raw): Tree {
	const { source } = raw;
	if (!source || isPendingSource(source)) refuse(`a <${raw.tag}> has no name in the file yet`);
	// Every iteration of a loop answers to the loop's one element.
	if (raw.looped) refuse('a loop rendered an element');
	if (OPAQUE.has(raw.tag)) refuse(`<${raw.tag}> holds content its props do not describe`);

	const props: Record<string, PropValue> = {};
	for (const [name, value] of Object.entries(raw.props)) {
		// Where the user is looking is the file's business, not the composition's.
		// `false` is how an editor unsets a prop: the same thing as never having set it.
		if (VIEW_PROPS.has(name) || value === false) continue;
		if (!isPropValue(value)) refuse(`${name} of <${raw.tag}> is not plain data`);
		props[name] = structuredClone(value);
	}

	// Only a `<text>` is what it says; a caption's words come from its track.
	const text = raw.tag === 'text' && raw.text ? { text: raw.text } : {};
	return { source, tag: raw.tag, props, ...text, children: raw.children.map(tree), ...(raw.entity === undefined ? {} : { entity: raw.entity }) };
}

/** The composition the stage holds, with the entity each element was read from. */
function readStage(world: World): Composition {
	const root = world.get(Root)!;
	const scenes: Tree[] = [];
	for (const entity of getEntityChildren(world, root)) {
		const raw = rawOfEntity(world, entity);
		if (raw) scenes.push(tree(raw));
	}
	return { background: colorToHex(root.get(Background)?.value ?? DEFAULT_BACKGROUND), scenes };
}

/** The composition the stage holds, as a record of the file would say it. Exported for the tests. */
export function captureComposition(world: World): Composition {
	const bare = (tree: Tree): Tree => ({
		source: tree.source,
		tag: tree.tag,
		props: tree.props,
		...(tree.text === undefined ? {} : { text: tree.text }),
		children: tree.children.map(bare),
	});
	const stage = readStage(world);
	return { background: stage.background, scenes: stage.scenes.map(bare) };
}

/** The composition the project in `code` says, from a record of rendering it. Exported for the tests. */
export function recordComposition(code: string): Composition {
	const recording = recordProject(code);
	if (recording.reactive || recording.inspect.length) refuse('the new file reacts to signals');

	const scenes: Tree[] = [];
	for (const node of recording.stage.children) {
		const raw = rawOfRecorded(node);
		if (raw) scenes.push(tree(raw));
	}
	return { background: colorToHex(parseColor(recording.background) ?? DEFAULT_BACKGROUND), scenes };
}

/** `trees` and everything under them, in document order. */
function everything(trees: Tree[]): Tree[] {
	const found: Tree[] = [];
	const visit = (tree: Tree): void => {
		found.push(tree);
		tree.children.forEach(visit);
	};
	trees.forEach(visit);
	return found;
}

/** How many elements each stamp names. More than one means a template rendered it: a `.map` over data. */
function stamps(trees: Tree[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const tree of everything(trees)) counts.set(tree.source, (counts.get(tree.source) ?? 0) + 1);
	return counts;
}

/** Where `now` differs from `want`, as a path to the first difference; undefined when they say the same. */
function difference(now: Tree[], want: Tree[], path: string): string | undefined {
	if (now.length !== want.length) return `${path || 'the stage'} holds ${now.length} elements, not ${want.length}`;

	for (const [position, tree] of now.entries()) {
		const other = want[position]!;
		const at = `${path}/${other.source}`;
		if (tree.source !== other.source) return `${at} is ${tree.source}`;
		if (tree.tag !== other.tag) return `${at} is a <${tree.tag}>`;
		if ((tree.text ?? '') !== (other.text ?? '')) return `${at} says something else`;

		for (const name of new Set([...Object.keys(tree.props), ...Object.keys(other.props)])) {
			if (!sameValue(tree.props[name], other.props[name])) return `${at} has another ${name}`;
		}
		const inside = difference(tree.children, other.children, at);
		if (inside) return inside;
	}
	return undefined;
}

/** The authored elements directly under `parent`, in order. */
function elementsUnder(world: World, parent: Entity): Entity[] {
	return getEntityChildren(world, parent).filter((child) => child.has(Source));
}

/**
 * Which element of what is on the stage each element of the file is, by
 * stamp. A stamp that names one element in both is matched wherever it sits
 * (so a clip that moved still is the clip). A stamp that names several — a
 * template rendered them, one per item of its data — cannot say which is
 * which, so the ones under a parent that was matched are taken in order: the
 * third `<group>` of this parent is the third `<group>` of that one.
 */
function pairing(before: Tree[], after: Tree[]): { pairs: Map<Tree, Tree>; templated: boolean } {
	const was = stamps(before);
	const now = stamps(after);
	const repeated = (source: string): boolean => (was.get(source) ?? 0) > 1 || (now.get(source) ?? 0) > 1;

	const single = new Map<string, Tree>();
	for (const tree of everything(before)) if (!repeated(tree.source)) single.set(tree.source, tree);

	const pairs = new Map<Tree, Tree>();
	const taken = new Set<Tree>();
	const match = (wanted: Tree[], siblings: Tree[]): void => {
		for (const tree of wanted) {
			const earlier = repeated(tree.source)
				? siblings.find((sibling) => sibling.source === tree.source && !taken.has(sibling))
				: single.get(tree.source);
			if (earlier) {
				pairs.set(tree, earlier);
				taken.add(earlier);
			}
			match(tree.children, earlier?.children ?? []);
		}
	};
	match(after, before);

	return { pairs, templated: [...was.values(), ...now.values()].some((count) => count > 1) };
}

/**
 * Makes the difference between `before` (what is on the stage) and `after`
 * (what the file says) on the stage: elements are added, moved and removed
 * first, so every one that is to stay is where it belongs, then props and
 * text are brought across. Returns how many changes it made.
 */
function reconcile(world: World, editor: DocumentEditor, before: Composition, after: Composition, pairs: Map<Tree, Tree>): number {
	const root = world.get(Root)!;
	const nodes = everything(before.scenes);

	// A scene is the unit of the canvas: its place and the camera that frames it.
	if (before.scenes.map((scene) => scene.source).join('\n') !== after.scenes.map((scene) => scene.source).join('\n')) {
		refuse('scenes were added, removed or reordered');
	}
	// Everything that can be refused is refused before the first change is made.
	for (const [tree, earlier] of pairs) {
		if (earlier.tag !== tree.tag) refuse(`<${earlier.tag}> became <${tree.tag}>`);
		for (const name of Object.keys(earlier.props)) {
			if (tree.props[name] === undefined && !(REMOVABLE_TAGS.has(tree.tag) && REMOVABLE_PROPS.has(name))) {
				refuse(`${name} was taken off a <${tree.tag}>`);
			}
		}
	}
	// What the stage holds has to be what was read off it: nothing it has not listed.
	if ([...world.query(Source)].filter((entity) => entity !== root).length !== nodes.length) {
		refuse('the stage holds an element the composition does not list');
	}

	let changes = 0;
	// The elements whose children changed: how long they run depends on them.
	const touched = new Set<Entity>();
	// What each element of the file is on the stage: the one it was matched to, or the one made for it.
	const stage = new Map<Tree, Entity>();
	for (const [tree, earlier] of pairs) stage.set(tree, earlier.entity!);

	const create = (parent: Entity, wanted: Tree, anchor: Entity | undefined): Entity => {
		// The element alone: what is inside it is placed on its own turn, so an
		// element that already exists moves into it rather than being copied.
		const [entity] = editor.insertElement(parent, () => renderAuthored({
			tag: wanted.tag,
			props: wanted.props,
			...(wanted.text === undefined ? {} : { text: wanted.text }),
			children: [],
		}), anchor);
		const pending = entity?.get(Source)?.value;
		if (!entity || !pending) refuse(`${wanted.source} could not be added`);
		// It is in the file already, under its own name.
		editor.restamp({ [pending]: wanted.source });
		return entity;
	};

	const place = (parent: Tree): void => {
		const holder = stage.get(parent)!;
		let present = elementsUnder(world, holder);

		for (const [position, wanted] of parent.children.entries()) {
			const entity = stage.get(wanted);
			const anchor = present[position];

			if (entity === undefined) {
				stage.set(wanted, create(holder, wanted, anchor));
			} else if (entity === anchor) {
				continue;
			} else {
				const from = getParentEntity(entity);
				if (!editor.reparent(entity, holder, anchor)) refuse(`${wanted.source} could not be moved`);
				if (from) touched.add(from);
			}
			touched.add(holder);
			changes++;
			present = elementsUnder(world, holder);
		}

		for (const child of parent.children) place(child);
	};
	for (const scene of after.scenes) place(scene);

	// Last, so what was moved out of an element that is going has left it.
	const matched = new Set(pairs.values());
	const doomed = nodes.filter((tree) => !matched.has(tree)).map((tree) => tree.entity!);
	if (doomed.length > 0) {
		for (const entity of doomed) {
			const holder = getParentEntity(entity);
			if (holder) touched.add(holder);
		}
		editor.remove(doomed);
		changes += doomed.length;
	}

	for (const [tree, earlier] of pairs) {
		const entity = earlier.entity!;

		for (const name of new Set([...Object.keys(earlier.props), ...Object.keys(tree.props)])) {
			const next = tree.props[name];
			if (next === undefined) {
				editor.unsetProperty(entity, name);
			} else if (earlier.props[name] === undefined || !sameValue(earlier.props[name], next)) {
				editor.editProperty(entity, name, next);
			} else {
				continue;
			}
			changes++;
		}

		if ((earlier.text ?? '') !== (tree.text ?? '')) {
			editor.editText(entity, tree.text ?? '');
			changes++;
		}
	}

	// A container that runs as long as what is in it was last measured with what
	// it had; the world only re-measures it when a time prop of its own changes.
	for (const parent of touched) {
		if (parent === root || !parent.isAlive()) continue;
		recomputeEntityTimeRange(world, parent);
		bubbleTimeRangeUp(world, parent);
	}

	return changes;
}

/**
 * Brings the project mounted in `world` up to date with `code`, a compile of
 * its file that someone else changed, if that can be done in place. `live` is
 * the mount that put the project on the stage. When it says `applied: false`
 * the stage may have been touched on the way: mount the project afresh.
 *
 * The edit is one step in the history, so an undo takes it back — unless the
 * project is built from templates. The history names an element by its stamp,
 * and a stamp that names a dozen elements would put an undo on the first of
 * them; such an edit is made, and left out of the history, which keeps what
 * the user did before it.
 */
export function applyExternalEdit(world: World, live: Mount, code: string): ExternalEdit {
	try {
		// A project that still reacts to a signal would write over what is
		// done here the next time the signal moves.
		if (live.reactive() || live.inspect.length) refuse('the project reacts to signals');

		const before = readStage(world);
		const after = recordComposition(code);
		if (before.background !== after.background) refuse('the stage background changed');

		const editor = getDocumentEditor(world);
		const history = getEditHistory(world);
		const { pairs, templated } = pairing(before.scenes, after.scenes);
		const make = (): number => editor.applyExternal(() => reconcile(world, editor, before, after, pairs));

		let changes: number;
		if (templated) {
			changes = history.untracked(make);
		} else {
			// One step in the history, apart from whatever the user is doing: a drag still held keeps its own.
			const step = history.beginGroup();
			try {
				changes = make();
			} finally {
				history.endGroup(step);
			}
		}

		const mismatch = difference(readStage(world).scenes, after.scenes, '');
		if (mismatch) refuse(`the stage does not match the file: ${mismatch}`);
		return { applied: true, changes, undoable: !templated && changes > 0 };
	} catch (error) {
		if (error instanceof Refusal) return { applied: false, reason: error.message };
		console.warn('[projects] could not update the stage in place:', error);
		return { applied: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
