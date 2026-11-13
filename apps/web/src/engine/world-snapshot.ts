import * as runtime from '@diffusionstudio/runtime';
import { getEntityChildren, Root, Source } from '@diffusionstudio/runtime';

import type { Entity, World } from 'koota';

// What the tests of in-place updates compare: every entity of a world, trait by
// trait, in tree order — so that a project patched where it stands can be held
// against a fresh mount of the same file. Not for the app; nothing imports it.

const names = new Map<unknown, string>();
for (const [name, value] of Object.entries(runtime)) names.set(value, name);

/**
 * What each entity is called when its id is not to be compared: the stamp of
 * an element, a position under its parent for what the runtime derived from
 * one. Ids differ between worlds (the world is part of the number).
 */
const labels = (world: World): Map<number, string> => {
  const found = new Map<number, string>();
  const visit = (entity: Entity, label: string): void => {
    found.set(entity as unknown as number, label);
    let derived = 0;
    for (const child of getEntityChildren(world, entity)) visit(child, child.get(Source)?.value ?? `${label}~${derived++}`);
  };
  visit(world.get(Root)!, 'stage');
  return found;
};

const plain = (value: unknown, entities?: Map<number, string>): unknown => {
  if (typeof value === 'number') return entities?.get(value) ?? value;
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (typeof value === 'function') return '[function]';
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map((inner) => plain(inner, entities));
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner, entities)]));
};

const traitsOf = (world: World, entity: Entity, entities: Map<number, string>): Record<string, unknown> => {
  const traits: Record<string, unknown> = {};
  for (const trait of world.traits) {
    const name = names.get(trait) ?? `trait#${trait.id}`;
    // The host is a node, not a trait of the entity; the constraint cache is seeded by the frame loop the first time a resize looks at the entity.
    if (name === 'Host' || name === 'ConstraintCache' || !entity.has(trait)) continue;
    // The traits that name other entities: the cache of what is under an entity, and what a keyframe track animates.
    traits[name] = plain(entity.get(trait), name === 'Cache' || name === 'KeyframeTrack' ? entities : undefined);
  }
  return traits;
};

/** Every entity's traits in tree order; what the runtime derived (no source) is compared as a set, since nothing orders it. */
export const snapshot = (world: World, entity: Entity = world.get(Root)!, entities: Map<number, string> = labels(world), rank?: number): unknown => {
  const children = getEntityChildren(world, entity);
  const traits = traitsOf(world, entity, entities);
  // The index is only what siblings are sorted by, and a removal leaves a gap in it.
  if (rank !== undefined && traits.ItemIndex) traits.ItemIndex = { value: rank };
  return {
    traits,
    elements: children.filter((child) => child.has(Source)).map((child, position) => snapshot(world, child, entities, position)),
    derived: children.filter((child) => !child.has(Source)).map((child) => snapshot(world, child, entities)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
};


/** Where two plain values first differ, as a path; undefined when they are the same. */
export const firstDiff = (a: unknown, b: unknown, path = ''): string | undefined => {
  if (Object.is(a, b)) return undefined;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const inner = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}/${key}`);
    if (inner) return inner;
  }
  return undefined;
};


/** Every place two plain values differ, as paths into them with the trait that differs (several, for a report). */
export const allDiffs = (a: unknown, b: unknown, limit = 8): string[] => {
  const found = new Set<string>();
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (found.size >= limit || Object.is(x, y)) return;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) {
      // Which trait, not which entity: the path from the trait down.
      found.add(`${path.replace(/^.*\/traits/, '')}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
      return;
    }
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${path}/${key}`);
  };
  walk(a, b, '');
  return [...found];
};
