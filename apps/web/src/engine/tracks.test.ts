import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { authoredTree, mount } from '@diffusionstudio/reconciler';
import { Name, Selected, Source, createRuntimeWorld } from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { bundle, el } from './project-fixture';
import { addTrack, nextTrackName, removeSelectedTracks } from './tracks';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

afterAll(() => vi.unstubAllGlobals());

// Two picture tracks, one of sound, a Voiceover that is not a V, and a clip loose in the scene.
const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Sequence', 'v1', { name: 'V1 A-roll' }, [el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }), el('Video', 'b', { src: 'b.mp4', start: 5, end: 9 })]),
    el('Sequence', 'v2', { name: 'V2 B-roll' }, [el('Video', 'c', { src: 'c.mp4', start: 2, end: 6 })]),
    el('Sequence', 'a1', { name: 'A1 Music' }, [el('Audio', 'm', { src: 'm.mp3', start: 0, end: 9 })]),
    el('Sequence', 'vo', { name: 'Voiceover' }, []),
    el('Rect', 'card', { width: 10, height: 10, start: 0, end: 3 }),
  ]),
]);

let world: World;
let mounted: Mount;

const find = (id: string): Entity => [...world.query(Source)].find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const scene = () => find('scene');
/** The names of the scene's rows, bottom to top: the order of the file. */
const rows = () => (authoredTree(world, scene())?.children ?? []).map((child) => String(child.props.name ?? child.tag));

beforeEach(() => {
  world = createRuntimeWorld('tracks');
  mounted = mount(bundle(project()), world);
  getEditHistory(world).reset();
});

afterEach(() => {
  mounted.dispose();
  world.destroy();
});

describe('the name of the next track', () => {
  it('is one past the highest number the kind has: V3 for picture, A2 for sound', () => {
    expect(nextTrackName(world, scene(), 'video')).toBe('V3');
    expect(nextTrackName(world, scene(), 'audio')).toBe('A2');
  });

  it('is the first when there is none of the kind, and counts a name past the number', () => {
    find('v1').set(Name, { value: 'Main' });
    find('v2').set(Name, { value: 'V10 Titles' });
    find('a1').set(Name, { value: 'Music' });

    expect(nextTrackName(world, scene(), 'video')).toBe('V11');
    expect(nextTrackName(world, scene(), 'audio')).toBe('A1');
  });

  it('does not take a name that only starts with the letter: Voiceover is not a V', () => {
    find('v1').set(Name, { value: 'Main' });
    find('v2').set(Name, { value: 'Main 2' });

    expect(nextTrackName(world, scene(), 'video')).toBe('V1');
  });
});

describe('adding a track', () => {
  it('puts an empty one on top, named for the next number, and selects it', async () => {
    const track = addTrack(world, 'video')!;
    await Promise.resolve();

    expect(track).not.toBeNull();
    expect(rows()).toEqual(['V1 A-roll', 'V2 B-roll', 'A1 Music', 'Voiceover', 'rect', 'V3']);
    expect(track.has(Selected)).toBe(true);
    expect(authoredTree(world, track)!.children).toEqual([]);
  });

  it('is one step: an undo takes it away again', async () => {
    addTrack(world, 'audio');
    await Promise.resolve();
    expect(rows()).toContain('A2');

    getEditHistory(world).undo();

    expect(rows()).not.toContain('A2');
  });

  it('goes above the track it is asked to go above, and below the one it is asked to go below', async () => {
    addTrack(world, 'video', 'above', find('v1'));
    await Promise.resolve();
    expect(rows().slice(0, 3)).toEqual(['V1 A-roll', 'V3', 'V2 B-roll']);

    addTrack(world, 'audio', 'below', find('v2'));
    await Promise.resolve();
    expect(rows().slice(0, 4)).toEqual(['V1 A-roll', 'V3', 'A2', 'V2 B-roll']);
  });

  it('is placed by the track a clip is on when it is a clip that is asked about', async () => {
    addTrack(world, 'video', 'above', find('a'));
    await Promise.resolve();

    expect(rows().slice(0, 2)).toEqual(['V1 A-roll', 'V3']);
  });

  it('is not made when there is no scene', () => {
    mounted.dispose();
    world.destroy();
    world = createRuntimeWorld('tracks-empty');

    expect(addTrack(world, 'video')).toBeNull();
  });
});

describe('deleting tracks', () => {
  it('takes away the tracks that are selected, and the clips on them, in one step', async () => {
    getDocumentEditor(world).select(find('v1'));
    await Promise.resolve();

    removeSelectedTracks(world);
    await Promise.resolve();
    expect(rows()).toEqual(['V2 B-roll', 'A1 Music', 'Voiceover', 'rect']);
    expect(find('a')).toBeUndefined();

    getEditHistory(world).undo();
    expect(rows()).toEqual(['V1 A-roll', 'V2 B-roll', 'A1 Music', 'Voiceover', 'rect']);
    expect((authoredTree(world, scene())!.children[0]!.children).length).toBe(2);
  });

  it('takes away a track with nothing on it, and an undo brings it back', async () => {
    const track = addTrack(world, 'audio')!;
    await Promise.resolve();
    getEditHistory(world).reset();
    expect(rows().at(-1)).toBe('A2');

    removeSelectedTracks(world);
    await Promise.resolve();
    expect(rows()).not.toContain('A2');

    getEditHistory(world).undo();
    expect(rows().at(-1)).toBe('A2');
    expect(track.isAlive()).toBe(false);
  });

  it('leaves what is not a track alone: a clip, even on a track', async () => {
    getDocumentEditor(world).select(find('a'));
    await Promise.resolve();

    expect(removeSelectedTracks(world)).toEqual([]);
    expect(rows()).toHaveLength(5);
    expect(find('a')).toBeDefined();
  });
});
