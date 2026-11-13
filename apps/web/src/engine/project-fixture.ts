import { SOURCE_ATTR } from '@diffusionstudio/jsx';

import { VIEW_PROPS } from './history';

import type { AuthoredTree } from '@diffusionstudio/reconciler';

// Projects as data, for the tests that mount one: a spec is what a compiled
// bundle would build, one element per entry, and `bundle` is the CommonJS the
// mount evaluates. Not for the app; nothing imports it.

/** A project as data: what a compiled bundle would build, one element per entry. */
export interface Spec {
  tag: string;
  id: string;
  props?: Record<string, unknown>;
  text?: string;
  children?: Spec[];
}

export const el = (tag: string, id: string, props: Record<string, unknown> = {}, children: Spec[] = [], text?: string): Spec => ({ tag, id, props, children, ...(text === undefined ? {} : { text }) });

const emit = (spec: Spec): string => {
  const props = JSON.stringify({ [SOURCE_ATTR]: `index.tsx:${spec.id}`, ...(spec.props ?? {}) });
  const content = [...(spec.text === undefined ? [] : [JSON.stringify(spec.text)]), ...(spec.children ?? []).map(emit)];
  return `${spec.tag}(Object.assign(${props}, ${content.length ? `{ get children() { return [${content.join(', ')}]; } }` : '{}'}))`;
};

export const bundle = (root: Spec): string => `const { Stage, Scene, Sequence, Video, Image, Audio, Rect, Ellipse, Text, Group, Captions, Effect, Animation, KeyframeTrack, Keyframe } = require('@diffusionstudio/jsx');
module.exports.default = () => ${emit(root)};`;

/** What a project says, in a form two trees can be compared in: an unset prop is no prop, and the order props were written in is nothing. */
export const canonical = (tree: AuthoredTree | undefined): unknown => tree && {
  tag: tree.tag,
  props: Object.fromEntries(Object.entries(tree.props).filter(([name, value]) => value !== false && !VIEW_PROPS.has(name)).sort(([a], [b]) => a.localeCompare(b))),
  text: tree.text ?? '',
  children: tree.children.map(canonical),
};
