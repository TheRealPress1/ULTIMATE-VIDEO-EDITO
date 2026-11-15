import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text', 'Path2D', 'OffscreenCanvas', 'ResizeObserver']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { fonts: { addEventListener() {} }, createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
  // The cut wraps its halves with JSX, which the app compiles for Solid and esbuild, here, for React: a component is
  // called with its props, which is what Solid's compile makes of it as well.
  vi.stubGlobal('React', { createElement: (component: (props: object) => unknown, props: object) => component(props) });
});
import { applyEdits } from '@desktop/edit';
import { mount } from '@diffusionstudio/reconciler';
import { Source, createRuntimeWorld } from '@diffusionstudio/runtime';
import { getDocumentEditor } from '@/engine/editor';
import { getEditHistory } from '@/engine/history';
import { bundle, el } from '@/engine/project-fixture';
import { razorAt } from '@/engine/split';
import { createEditWriter, flushProjectEdits, projectSaveState, recoverProjectEdits } from './edits';

import type { Mount } from '@diffusionstudio/reconciler';
import type { Entity, World } from 'koota';

const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('./host', () => ({ writeProject: mocks.write }));
vi.mock('somoto', () => ({ toast: { error: vi.fn() } }));

afterAll(() => vi.unstubAllGlobals());

// A cut and its undo, from the editor to the file: the editor reports what the
// history replays, the writer batches it, and the desktop's patcher (in strict
// mode, as the app runs it, so one edit it cannot write voids the whole write)
// applies it to the project's source. The file has to end up saying what the
// canvas shows, or the next load shows something nobody did.

/** What the project says before anything is cut: the music is a clip of the scene itself, not of a sequence. */
const SOURCE = `export default () => (
  <stage id="stage">
    <scene id="scene" width={1920} height={1080} active>
      <audio id="mus" name="Music bed" src="music.mp3" start={0} end={21.9} />
      <sequence id="v1">
        <video id="a" src="a.mp4" start={0} end={5} />
        <video id="b" src="b.mp4" start={5} end={12} />
      </sequence>
    </scene>
  </stage>
);
`;

const project = () => el('Stage', 'stage', {}, [
  el('Scene', 'scene', { width: 1920, height: 1080, active: true }, [
    el('Audio', 'mus', { name: 'Music bed', src: 'music.mp3', start: 0, end: 21.9 }),
    el('Sequence', 'v1', {}, [
      el('Video', 'a', { src: 'a.mp4', start: 0, end: 5 }),
      el('Video', 'b', { src: 'b.mp4', start: 5, end: 12 }),
    ]),
  ]),
]);

const FPS = 30;

let dir: string;
let world: World;
let mounted: Mount;
let writer: ReturnType<typeof createEditWriter>;

const find = (id: string): Entity => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${id}`)!;
const history = () => getEditHistory(world);
const source = (): Promise<string> => readFile(join(dir, 'index.tsx'), 'utf8');
const journalKey = (): string => `cutroom:pending-edits:v1:${dir}`;
/** The file with the names the writer drew at random made alike and the selection left out (the history keeps neither), so that two cuts of one clip read the same. */
const named = (text: string): string => text.replace(/id="[a-z0-9]{6}"/g, 'id="~"').replace(/ selected(?= \/>)/g, '');

/** The cut a pointer or the playhead makes (they share `cutUnits`), then the burst of edits it was closed. Returns the tails. */
const cut = async (clip: Entity, seconds: number, everything = false): Promise<Entity[]> => {
  const tails = razorAt(world, clip, Math.round(seconds * FPS), everything);
  await Promise.resolve();
  return tails;
};

beforeEach(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => { storage.set(name, value); },
    removeItem: (name: string) => { storage.delete(name); },
  });
  dir = await mkdtemp(join(tmpdir(), 'split-undo-save-'));
  await writeFile(join(dir, 'index.tsx'), SOURCE);
  mocks.write.mockReset().mockImplementation((folder: string, edits) => applyEdits({ dir: folder, strict: true }, edits));

  world = createRuntimeWorld('split-undo-save');
  mounted = mount(bundle(project()), world);
  history().reset();
  writer = createEditWriter(dir, world);
  getDocumentEditor(world).onWrite((edit) => writer.push(edit));
});

afterEach(async () => {
  // Nothing is left to write by now, or a test said why it is not.
  await writer.flush().catch(() => {});
  writer.dispose();
  mounted.dispose();
  world.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('undoing the cut of a clip that sits directly under a scene', () => {
  it('writes the undo once the cut is in the file, and the file is as it was', async () => {
    await cut(find('mus'), 5);
    await flushProjectEdits(dir);
    // The halves are wrapped in a sequence of their own, in the file as on the canvas.
    expect(await source()).toMatch(/<sequence id="[a-z0-9]{6}" name="Sequence 1">\s*<audio id="mus"[^>]* end=\{5\} \/>\s*<audio /);

    history().undo();
    await flushProjectEdits(dir);

    expect(projectSaveState(dir).status).toBe('saved');
    expect(await source()).toBe(SOURCE);
  });

  it('writes the cut, the undo and the redo in turn, each saved, and the file follows every one', async () => {
    await cut(find('mus'), 5);
    await flushProjectEdits(dir);
    const cutText = named(await source());
    expect(cutText).not.toBe(named(SOURCE));

    history().undo();
    await flushProjectEdits(dir);
    expect(await source()).toBe(SOURCE);

    history().redo();
    await flushProjectEdits(dir);
    expect(named(await source())).toBe(cutText);

    history().undo();
    await flushProjectEdits(dir);
    expect(await source()).toBe(SOURCE);
    expect(projectSaveState(dir).status).toBe('saved');
  });

  it('writes an undo asked for while the cut is still being written', async () => {
    await cut(find('mus'), 5);
    const writing = writer.flush();
    history().undo();
    await writing;
    await flushProjectEdits(dir);

    expect(projectSaveState(dir).status).toBe('saved');
    expect(await source()).toBe(SOURCE);
  });

  it('writes an undo that comes before the cut has been written', async () => {
    await cut(find('mus'), 5);
    history().undo();
    await flushProjectEdits(dir);

    expect(projectSaveState(dir).status).toBe('saved');
    expect(await source()).toBe(SOURCE);
  });

  it('writes the undo of a tail that was cut again, one step at a time', async () => {
    const [tail] = await cut(find('mus'), 5);
    await flushProjectEdits(dir);
    await cut(tail!, 10);
    await flushProjectEdits(dir);

    history().undo();
    await flushProjectEdits(dir);
    expect(await source()).not.toBe(SOURCE);

    history().undo();
    await flushProjectEdits(dir);
    expect(projectSaveState(dir).status).toBe('saved');
    expect(await source()).toBe(SOURCE);
  });

  it('writes the undo of a cut across a clip of the scene and one of a sequence at once', async () => {
    await cut(find('mus'), 2.5, true);
    await flushProjectEdits(dir);
    // Both were cut: the music is wrapped, the video is cut where it stands.
    expect(await source()).toMatch(/<audio id="mus"[^>]* end=\{2\.5\} \/>/);
    expect(await source()).toMatch(/<video id="a"[^>]* end=\{2\.5\} \/>/);

    history().undo();
    await flushProjectEdits(dir);

    expect(projectSaveState(dir).status).toBe('saved');
    expect(await source()).toBe(SOURCE);
  });
});

describe('undoing the cut of a clip that sits in a sequence', () => {
  it('writes the undo, and the file is as it was', async () => {
    await cut(find('a'), 2);
    await flushProjectEdits(dir);
    expect(await source()).toMatch(/<video id="a"[^>]* end=\{2\} \/>\s*<video id="[a-z0-9]{6}"[^>]* start=\{2\}/);

    history().undo();
    await flushProjectEdits(dir);

    expect(projectSaveState(dir).status).toBe('saved');
    expect(await source()).toBe(SOURCE);
  });
});

describe('a project whose undo of a cut could not be written', () => {
  it('is written when the journal that kept the undo is replayed, and the journal goes', async () => {
    // What was kept when the write failed: the cut is in the file, the undo of it is the batch that is owed.
    await writeFile(join(dir, 'index.tsx'), SOURCE.replace(
      '      <audio id="mus" name="Music bed" src="music.mp3" start={0} end={21.9} />\n',
      `      <sequence id="u599ap" name="Sequence 1">
        <audio id="mus" name="Music bed" src="music.mp3" start={0} end={2.6} />
        <audio id="8sm2u9" name="Music bed" src="music.mp3" start={2.6} end={21.9} sourceIn={2.6} selected />
      </sequence>\n`,
    ));
    localStorage.setItem(journalKey(), JSON.stringify({
      version: 1, dir, unrolls: [], inserts: [], moves: [], props: [], texts: [], removes: [], variables: [], inflight: [], sent: [],
      batch: {
        operationId: 'operation-undo-of-a-cut',
        edits: [
          { kind: 'move', source: 'index.tsx:mus', parent: 'index.tsx:scene', before: 'index.tsx:v1' },
          { kind: 'set', source: 'index.tsx:mus', props: { end: 21.9 } },
          { kind: 'remove', source: 'index.tsx:u599ap' },
          { kind: 'remove', source: 'index.tsx:8sm2u9' },
        ],
      },
    }));
    writer.dispose();

    await recoverProjectEdits(dir);

    expect(await source()).toBe(SOURCE);
    expect(localStorage.getItem(journalKey())).toBeNull();
    expect(projectSaveState(dir).status).toBe('saved');
  });
});
