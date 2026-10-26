import { afterAll, describe, expect, it, vi } from 'vitest';
// Only DOM instanceof guards are needed: this exercises authoring lifecycle,
// not rendering, decoding, canvas operations, or browser interaction.
vi.hoisted(() => {
	vi.stubGlobal('DOMMatrix', class {});
	vi.stubGlobal('HTMLImageElement', class {});
	vi.stubGlobal('HTMLCanvasElement', class {});
	vi.stubGlobal('HTMLElement', class {});
	vi.stubGlobal('Element', class {});
	vi.stubGlobal('Text', class {});
});
import { Caption, createRuntimeWorld, Selected, Source } from '@diffusionstudio/runtime';
import { mount } from '@diffusionstudio/reconciler';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';

afterAll(() => vi.unstubAllGlobals());

// A compiled counterpart of the selected-caption source observed in the user
// report. This fixture never reads or writes a project on disk.
const code = `
const { Stage, Scene, Video, Captions } = require('@diffusionstudio/jsx');
module.exports.default = () => Stage({ __source: 'index.tsx:ycsnp3', camera: [0.14,0,0,0.14,25,100],
  get children() { return Scene({ __source: 'index.tsx:rheesa', name: 'Original', width: 1920, height: 1080, active: true,
    get children() { return [
      Video({ __source: 'index.tsx:footage', src: 'assets/rheesa.mp4', width: 1920, height: 1080, start: 0, end: 30 }),
      Captions({ __source: 'index.tsx:l46k4w', src: 'Captions 3.json', preset: 'whisper', selected: true }),
    ]; }
  }); }
});`;

describe('selected caption mount lifecycle', () => {
	it('does not emit source edits while mounting, disposing, and remounting selected captions', () => {
		const world = createRuntimeWorld('isolated-caption-lifecycle');
		const edits: unknown[] = [];
		const unlisten = getDocumentEditor(world).onEdit((edit) => edits.push(edit));
		let mounted = mount(code, world);
		expect(world.query(Caption, Selected)).toHaveLength(1);
		expect(world.query(Caption)[0]!.get(Source)?.value).toBe('index.tsx:l46k4w');
		getEditHistory(world).reset();
		mounted.dispose();
		mounted = mount(code, world);
		expect(world.query(Caption, Selected)).toHaveLength(1);
		mounted.dispose();
		expect(edits).toEqual([]);
		unlisten();
		world.destroy();
	});
});
