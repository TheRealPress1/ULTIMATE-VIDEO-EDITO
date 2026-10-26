import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { World } from 'koota';
import type { CapturedNode, EntityEdit } from './editor';

const mocks = vi.hoisted(() => ({ editor: vi.fn(), flush: vi.fn(), render: vi.fn(), focus: vi.fn(), native: vi.fn(), wav: vi.fn(), decode: vi.fn() }));
vi.mock('@/lib/local-audio-finishing', () => ({ runLocalAudioFinishing: mocks.native }));
vi.mock('./audio-pcm', () => ({ sceneAudioWav: mocks.wav, decodeFinishingAudio: mocks.decode }));
vi.mock('./editor', () => ({ getDocumentEditor: mocks.editor, isPendingSource: (source: string) => source.startsWith('pending#') }));
vi.mock('@/projects/edits', () => ({ flushProjectEdits: mocks.flush }));
vi.mock('@diffusionstudio/reconciler', () => ({
	renderAuthored: mocks.render,
	authoredElement: (entity: { tag: string; props: object }) => ({ tag: entity.tag, props: entity.props }),
	authoredTree: (_world: unknown, entity: FakeEntity) => {
		const capture = (node: FakeEntity): AuthoredTree => ({ tag: node.tag, props: { ...node.props }, children: node.children.filter((child) => child.alive).map(capture) });
		return capture(entity);
	},
}));
vi.mock('@diffusionstudio/runtime', () => ({
	Computed: 'computed', getLibrary: (world: World) => world.get('library' as never), store: () => ({ end: new Proxy([], { get: () => 900 }) }), Root: 'root', Source: 'source', Library: 'library', FrameRate: 'fps', focusRect: mocks.focus,
	getCameraMatrix: () => [1, 0, 0, 1, 0, 0], getNextName: () => 'Transcript cut 1',
	getEntityChildren: (_world: unknown, entity: { children: FakeEntity[] }) => entity.children.filter((child) => child.alive),
}));

import { audioFinishingMusicTracks, finishSceneAudio } from './audio-finishing';
import { getEditHistory } from './history';

interface FakeEntity {
	source: string;
	tag: string;
	props: Record<string, unknown>;
	alive: boolean;
	parent?: FakeEntity;
	children: FakeEntity[];
	get(trait: string): { value: string } | undefined;
	isAlive(): boolean;
	id(): number;
}



function fixture() {
	let id = 0;
	const all: FakeEntity[] = [];
	const listeners = new Set<(edit: EntityEdit) => void>();
	const renames = new Set<(ids: Record<string, string>) => void>();
	const emit = (edit: EntityEdit) => listeners.forEach((listener) => listener(edit));
	const create = (tree: AuthoredTree, parent?: FakeEntity, source = `pending#${++id}`): FakeEntity => {
		const entity: FakeEntity = {
			source, tag: tree.tag, props: { ...tree.props }, parent, alive: true, children: [],
			get: (trait) => trait === 'source' ? { value: entity.source } : undefined,
			isAlive: () => entity.alive, id: () => all.indexOf(entity),
		};
		all.push(entity);
		parent?.children.push(entity);
		for (const child of tree.children) create(child, entity);
		return entity;
	};
	const root = create({ tag: 'stage', props: {}, children: [] }, undefined, 'project.tsx:1');
	const original = create({ tag: 'scene', props: { name: 'Original', x: 0, y: 0, width: 1920, height: 1080 }, children: [] }, root, 'project.tsx:2');
	const asset = { id: 'video', path: 'Interview.mp4', source: '/media/Interview.mp4', type: 'VIDEO', duration: 30, width: 1920, height: 1080 };
	const stat = { size: 100, mtime: 123 };
	const clip = create({ tag: 'video', props: { src: asset.path, width: 1920, height: 1080, start: 0, end: 30 }, children: [] }, original, 'project.tsx:clip');
	const library = {
		resolve: vi.fn(async () => asset),
		fs: { stat: vi.fn(async () => ({ ...stat })) },
		get: vi.fn((key: string) => key === asset.id ? asset : undefined),
		store: vi.fn().mockResolvedValue({ path: 'Finished-dialogue.wav' }), flush: vi.fn().mockResolvedValue(undefined),
	};
	const world = {
		get: vi.fn((trait: string) => ({ root, library, fps: { value: 30 } }[trait])),
		query: () => all.filter((entity) => entity.alive),
	} as unknown as World;
	const capture = (entity: FakeEntity): CapturedNode => ({ source: entity.source, tag: entity.tag, props: { ...entity.props }, children: entity.children.filter((child) => child.alive).map(capture) });
	const destroy = (entity: FakeEntity) => { entity.alive = false; entity.children.forEach(destroy); };
	const editor = {
		onEdit: (listener: (edit: EntityEdit) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		onRename: (listener: (ids: Record<string, string>) => void) => { renames.add(listener); return () => renames.delete(listener); },
		insertElement: vi.fn((parent: FakeEntity, render: () => unknown) => {
			const previous = all.length;
			const entity = create(render() as AuthoredTree, parent);
			for (const next of all.slice(previous)) {
				emit({ kind: 'insert', source: next.source, parent: next.parent!.source, tag: next.tag, props: next.props as never });
			}
			return [entity];
		}),
		remove: vi.fn((entity: FakeEntity) => {
			const node = capture(entity);
			destroy(entity);
			emit({ kind: 'remove', source: entity.source, parent: entity.parent?.source, node });
			return [entity];
		}),
		discardPending: vi.fn((source: string) => { const entity = all.find((item) => item.source === source); if (entity) destroy(entity); }),
		activate: vi.fn(), select: vi.fn(), reportEdit: vi.fn(),
	};
	mocks.editor.mockReturnValue(editor);
	mocks.flush.mockImplementation(async () => {
		const map: Record<string, string> = {};
		for (const entity of all) {
			if (entity.alive && entity.source.startsWith('pending#')) {
				const source = `project.tsx:${100 + all.indexOf(entity)}`;
				map[entity.source] = source;
				entity.source = source;
			}
		}
		renames.forEach((listener) => listener(map));
	});
	return { world, root, original, asset, stat, clip, library, editor, all, create, live: () => all.filter((entity) => entity.alive), emit };
}

const measured = { duration: 30, frames: 240000, sampleRate: 8000, channels: 1, samplePeakDb: -8, rmsDb: -18, fullScaleSamples: 0, silenceSpans: [], integratedLufs: -16, truePeakDb: -7.9, loudnessRangeLu: 2, thresholdLufs: -26 };
beforeEach(() => {
  vi.clearAllMocks(); mocks.render.mockImplementation((tree) => tree);
  mocks.wav.mockResolvedValue(new Uint8Array([1]));
  mocks.decode.mockResolvedValue({ sampleRate: 8000, channels: 1, frames: 240000, peak: 0.1, rms: 0.05, fullScaleSamples: 0, blocks: [{ frame: 0, channels: [Float32Array.from({ length: 240000 }, (_, index) => index > 8000 && index < 40000 ? 0.1 : 0)] }] });
  mocks.native.mockResolvedValue({ input: measured, output: measured, wav: new Uint8Array([1]), warnings: [] });
});

describe('audio finishing scene transaction', () => {
  it('keeps original music automation, inserts one undoable finished scene, and reports its measured mix', async () => {
    const f = fixture();
    const music = f.create({ tag: 'audio', props: { name: 'Music', src: 'Music.wav', start: 2, sourceIn: 4, volume: -10 }, children: [{ tag: 'animation', props: { type: 'gain', duration: 1 }, children: [] }] }, f.original, 'project.tsx:music');
    const original = JSON.stringify([f.original.props, f.clip.props, music.props]);
    expect(audioFinishingMusicTracks(f.world, f.original as never)).toMatchObject([{ id: 'project.tsx:music', index: 1 }]);
    const history = getEditHistory(f.world);
    const result = await finishSceneAudio(f.world, f.original as never, '/project', { musicIds: ['project.tsx:music'] });
    expect(result.mix).toEqual(measured); expect(result.musicKeyframeCount).toBeGreaterThan(2);
    expect(mocks.wav.mock.calls[0][3].excludeSources).toEqual(['project.tsx:music']);
    const created = f.live().find((node) => node.tag === 'scene' && node !== f.original)!;
    expect(created.children.find((node) => node.tag === 'video')!.props.muted).toBe(true);
    const group = created.children.find((node) => node.tag === 'group')!;
    expect(group.children[0].props).toMatchObject({ start: 2, sourceIn: 4, volume: -10 });
    expect(group.children[0].children[0].props).toMatchObject({ type: 'gain' });
    expect(created.children.find((node) => node.tag === 'audio')!.props.src).toBe('Finished-dialogue.wav');
    expect(JSON.stringify([f.original.props, f.clip.props, music.props])).toBe(original);
    history.undo(); expect(f.live().filter((node) => node.tag === 'scene')).toEqual([f.original]); expect(history.canUndo()).toBe(false);
    history.redo(); expect(f.live().filter((node) => node.tag === 'scene')).toHaveLength(2);
  });
  it('rejects stale scene or source files before storing or editing', async () => {
    const f = fixture();
    mocks.native.mockImplementation(async () => { f.clip.props.end = 15; return { input: measured, output: measured, wav: new Uint8Array([1]), warnings: [] }; });
    await expect(finishSceneAudio(f.world, f.original as never, '/project')).rejects.toThrow('scene changed');
    expect(f.library.store).not.toHaveBeenCalled(); expect(f.editor.insertElement).not.toHaveBeenCalled();
    const next = fixture();
    mocks.native.mockImplementation(async () => { next.stat.mtime++; return { input: measured, output: measured, wav: new Uint8Array([1]), warnings: [] }; });
    await expect(finishSceneAudio(next.world, next.original as never, '/project')).rejects.toThrow('changed while preparing');
    expect(next.library.store).not.toHaveBeenCalled();
  });
  it('cancels before insertion, but reports an already committed scene if final measurement is canceled', async () => {
    const f = fixture(); const cancel = new AbortController();
    mocks.wav.mockImplementationOnce(async () => { cancel.abort(); return new Uint8Array([1]); });
    await expect(finishSceneAudio(f.world, f.original as never, '/project', { signal: cancel.signal })).rejects.toThrow();
    expect(f.editor.insertElement).not.toHaveBeenCalled();
    const next = fixture();
    mocks.wav.mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(new Error('canceled during final mix'));
    const result = await finishSceneAudio(next.world, next.original as never, '/project');
    expect(result.sceneId).toBeTruthy(); expect(result.warnings.join(' ')).toContain('scene is saved');
    expect(next.live().filter((node) => node.tag === 'scene')).toHaveLength(2);
  });
  it('reports unsaved completion and cleans incomplete insertion', async () => {
    const f = fixture();
    mocks.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));
    await expect(finishSceneAudio(f.world, f.original as never, '/project')).rejects.toThrow('created but could not be saved');
    const next = fixture();
    next.editor.insertElement.mockImplementationOnce((parent, render) => { next.create(render() as AuthoredTree, parent); throw new Error('Render failed'); });
    await expect(finishSceneAudio(next.world, next.original as never, '/project')).rejects.toThrow('Render failed');
    expect(next.live().filter((node) => node.tag === 'scene')).toEqual([next.original]);
  });
});

