import { afterAll, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
  vi.stubGlobal('document', { createTextNode: (text: string) => Object.assign(new Text(), { data: text, textContent: text, remove() {} }) });
});
import { authoredTree, mount, renderAuthored } from '@diffusionstudio/reconciler';
import { Computed, Source, createRuntimeWorld, getEntityChildren, syncInteractiveState, recomputeEntityTimeRange } from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
afterAll(() => vi.unstubAllGlobals());

describe('transcript replacement with the actual document editor and history', () => {
  it('restores removed video/captions and 30s timing in one Undo, then reapplies 15s in one Redo', () => {
    const world = createRuntimeWorld('transcript-undo-real-runtime');
    const mounted = mount(`const { Stage, Scene, Video, Captions } = require('@diffusionstudio/jsx');
module.exports.default = () => Stage({ __source: 'index.tsx:stage', get children() { return Scene({ __source: 'index.tsx:scene', width: 1920, height: 1080,
 get children() { return [Video({ __source: 'index.tsx:video', src: 'clip.mp4', width:1920, height:1080, start:0, end:30 }), Captions({ __source: 'index.tsx:captions', src:'Words.json', preset:'whisper', start:0, end:30 })]; }
}); }});`, world);
    try {
      const editor = getDocumentEditor(world), history = getEditHistory(world);
      const scene = world.query(Source).find((entity) => entity.get(Source)?.value === 'index.tsx:scene')!;
      const original = getEntityChildren(world, scene);
      const originalTree = authoredTree(world, scene)!;
      history.beginGesture();
      try {
        editor.insertElement(scene, () => renderAuthored({ tag: 'sequence', props: {}, children: [
          { tag: 'video', props: { src: 'clip.mp4', start: 0, end: 10, sourceIn: 10, width: 1920, height: 1080 }, children: [] },
          { tag: 'video', props: { src: 'clip.mp4', start: 10, end: 15, sourceIn: 0, width: 1920, height: 1080 }, children: [] },
        ] }));
        editor.insertElement(scene, () => renderAuthored({ tag: 'captions', props: { src: 'Edited.json', preset: 'whisper', start: 0, sourceIn: 0, sourceOut: 15 }, children: [] }));
        editor.remove(original);
        editor.editProperty(scene, 'workarea', false);
      } finally { history.endGesture(); }
      syncInteractiveState(world); recomputeEntityTimeRange(world, scene);
      expect(scene.get(Computed)?.end).toBe(450); expect(history.canUndo()).toBe(true);
      // The save writer assigns stable sources after the transaction. History
      // must retain its inverses through the same restamping as the real app.
      editor.restamp(Object.fromEntries(world.query(Source).filter((entity) => entity.get(Source)!.value.startsWith('pending#')).map((entity, i) => [entity.get(Source)!.value, `index.tsx:new-${i}`])));
      history.undo(); syncInteractiveState(world); recomputeEntityTimeRange(world, scene);
      expect(scene.get(Computed)?.end).toBe(900);
      expect(authoredTree(world, scene)?.children).toEqual(originalTree.children);
      expect(history.canUndo()).toBe(false); expect(history.canRedo()).toBe(true);
      history.redo(); syncInteractiveState(world); recomputeEntityTimeRange(world, scene);
      expect(scene.get(Computed)?.end).toBe(450);
      expect(authoredTree(world, scene)?.children.map((child) => child.tag)).toEqual(['sequence', 'captions']);
    } finally { mounted.dispose(); world.destroy(); }
  });
});
