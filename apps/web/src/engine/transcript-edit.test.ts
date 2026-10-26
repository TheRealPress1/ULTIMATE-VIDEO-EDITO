import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { World } from 'koota';
import type { CapturedNode, EntityEdit } from './editor';

const mocks = vi.hoisted(() => ({ editor: vi.fn(), flush: vi.fn(), render: vi.fn(), focus: vi.fn(), analyze: vi.fn(), transcript: vi.fn(), audio: vi.fn(), silence: vi.fn(), ipc: vi.fn() }));
vi.mock('@/lib/local-transcription', () => ({ transcribeLocally: mocks.transcript }));
vi.mock('@/lib/ipc', () => ({ mainBridge: { call: mocks.ipc } }));
vi.mock('./scene-audio', () => ({ encodeSceneAudio: mocks.audio }));
vi.mock('./transcript-edit-silence', () => ({ detectTranscriptEditSilences: mocks.silence }));
vi.mock('./timing', () => ({ editPlayhead: vi.fn() }));
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
	Root: 'root', Source: 'source', Library: 'library', FrameRate: 'fps', Computed: 'computed', stopPlayback: vi.fn(), resolveTranscript: mocks.transcript, focusRect: mocks.focus,
	getCameraMatrix: () => [1, 0, 0, 1, 0, 0], getNextName: () => 'Transcript cut 1',
	getEntityChildren: (_world: unknown, entity: { children: FakeEntity[] }) => entity.children.filter((child) => child.alive),
}));

import { prepareTranscriptEdit, applyTranscriptEdit } from './transcript-edit';
import { getEditHistory } from './history';

interface FakeEntity {
	source: string;
	tag: string;
	props: Record<string, unknown>;
	alive: boolean;
	parent?: FakeEntity;
	children: FakeEntity[];
	get(trait: string): { value: string } | { start: number; end: number; origin: number; playbackRate: number; duration: number } | undefined;
	isAlive(): boolean;
}

const ranges = [{ start: 0, end: 2 }, { start: 3, end: 10 }];

function fixture() {
	let id = 0;
	const all: FakeEntity[] = [];
	const listeners = new Set<(edit: EntityEdit) => void>();
	const renames = new Set<(ids: Record<string, string>) => void>();
	const emit = (edit: EntityEdit) => listeners.forEach((listener) => listener(edit));
	const create = (tree: AuthoredTree, parent?: FakeEntity, source = `pending#${++id}`): FakeEntity => {
		const entity: FakeEntity = {
			source, tag: tree.tag, props: { ...tree.props }, parent, alive: true, children: [],
			get: (trait) => trait === 'source' ? { value: entity.source } : trait === 'computed' ? { start: 0, end: 900, origin: 0, playbackRate: 1, duration: 900 } : undefined,
			isAlive: () => entity.alive,
		};
		all.push(entity);
		parent?.children.push(entity);
		for (const child of tree.children) create(child, entity);
		return entity;
	};
	const root = create({ tag: 'stage', props: {}, children: [] }, undefined, 'project.tsx:1');
	const original = create({ tag: 'scene', props: { name: 'Original', x: 0, y: 0, width: 1920, height: 1080, workarea: [1, 20] }, children: [] }, root, 'project.tsx:2');
	const asset = { id: 'video', path: 'Interview.mp4', source: '/media/Interview.mp4', type: 'VIDEO', duration: 30, width: 1920, height: 1080 };
	const stat = { size: 100, mtime: 123 };
	const clip = create({ tag: 'video', props: { src: asset.path, width: 1920, height: 1080, start: 0, end: 30 }, children: [] }, original, 'project.tsx:clip');
	const captions = create({ tag: 'captions', props: { src: 'Words.json', preset: 'whisper' }, children: [] }, original, 'project.tsx:captions');
	const captionAsset = { id: 'caption', path: 'Words.json', source: '/Words.json', type: 'TRANSCRIPT', mimeType: 'application/json' };
	const library = {
		resolve: vi.fn(async (path: string) => path === 'Words.json' ? captionAsset : asset),
		fs: { stat: vi.fn(async () => ({ ...stat })) },
		get: vi.fn((key: string) => key === asset.id ? asset : undefined),
		store: vi.fn().mockResolvedValue({ path: 'Transcript cut captions.json' }), flush: vi.fn().mockResolvedValue(undefined),
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
		insertElement: vi.fn((parent: FakeEntity, render: () => unknown, anchor?: FakeEntity) => {
			const previous = all.length;
			const entity = create(render() as AuthoredTree, parent);
			if (anchor) { parent.children.pop(); parent.children.splice(parent.children.indexOf(anchor), 0, entity); }
			for (const next of all.slice(previous)) {
				emit({ kind: 'insert', source: next.source, parent: next.parent!.source, tag: next.tag, props: next.props as never });
			}
			return [entity];
		}),
		remove: vi.fn((target: FakeEntity | FakeEntity[]) => {
			const nodes = Array.isArray(target) ? target : [target];
			for (const entity of nodes) {
				const node = capture(entity);
				const siblings = entity.parent?.children.filter((child) => child.alive) ?? [];
				const before = siblings[siblings.indexOf(entity) + 1]?.source;
				destroy(entity);
				emit({ kind: 'remove', source: entity.source, parent: entity.parent?.source, before, node });
			}
			return nodes;
		}),
		editProperty: vi.fn((entity: FakeEntity, name: string, value: unknown) => {
			const previous = entity.props[name] ?? false;
			if (value === false) delete entity.props[name]; else entity.props[name] = value;
			emit({ kind: 'prop', source: entity.source, name, value: value as never, previous: previous as never });
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
	return { world, root, original, asset, captionAsset, captions, stat, clip, library, editor, all, create, live: () => all.filter((entity) => entity.alive), emit };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.render.mockImplementation((tree) => tree);
	mocks.audio.mockResolvedValue(new Blob(['audio']));
	mocks.silence.mockResolvedValue([{ start: 4.2, end: 5.8 }]);
	mocks.transcript.mockResolvedValue([{ text: 'Hello um world. Next thought.', words: [
		{ text: 'Hello', start: 1, end: 2 }, { text: 'um', start: 2.3, end: 2.6 }, { text: 'world.', start: 3, end: 4 }, { text: 'Next', start: 6, end: 7 }, { text: 'thought.', start: 8, end: 9 },
	] }]);
	mocks.ipc.mockImplementation(async (channel: string) => channel === 'projects:versions' ? { fingerprint: 'exact-source', versions: [] } : { id: 'before-edit-version' });
});

describe('current timeline transcript transaction', () => {
	it('inspects words and measured pauses without changing the composition', async () => {
		const f = fixture();
		const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		expect(snapshot.words).toHaveLength(5);
		expect(snapshot.suggestions.map((suggestion) => suggestion.kind)).toEqual(['filler', 'silence']);
		expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/);
		expect(f.editor.insertElement).not.toHaveBeenCalled();
		expect(f.library.store).not.toHaveBeenCalled();
		expect(mocks.ipc).not.toHaveBeenCalled();
	});

	it('rewrites the existing scene and synchronized captions as one undoable edit after a checkpoint', async () => {
		const f = fixture(); const history = getEditHistory(f.world);
		const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		const result = await applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges);
		expect(result).toMatchObject({ sceneId: 'project.tsx:2', duration: 9, previousDuration: 30, checkpointId: 'before-edit-version' });
		expect(f.live().filter((node) => node.tag === 'scene')).toEqual([f.original]);
		expect(f.original.props.workarea).toBeUndefined();
		expect(mocks.ipc).toHaveBeenCalledWith('projects:version-create', expect.objectContaining({ expectedFingerprint: 'exact-source' }));
		expect(mocks.ipc.mock.invocationCallOrder[1]).toBeLessThan(f.editor.insertElement.mock.invocationCallOrder[0]!);
		const transcript = JSON.parse(await (f.library.store.mock.calls[0]![0] as Blob).text());
		expect(transcript.flatMap((group: { words: { text: string; start: number }[] }) => group.words).map((word: { text: string; start: number }) => [word.text, word.start])).toEqual([['Hello', 1], ['world.', 2], ['Next', 5], ['thought.', 7]]);
		expect(history.canUndo()).toBe(true); history.undo();
		expect(f.original.props.workarea).toEqual([1, 20]);
		expect(f.original.children.filter((node) => node.alive).map((node) => node.tag)).toEqual(['video', 'captions']);
		expect(f.original.children.find((node) => node.alive && node.tag === 'captions')?.props.src).toBe('Words.json');
		expect(history.canUndo()).toBe(false); history.redo();
		expect(f.original.children.filter((node) => node.alive).map((node) => node.tag)).toEqual(['sequence', 'captions']);
		expect(f.original.props.workarea).toBeUndefined();
	});

	it('rejects a changed scene and an expired revision before creating checkpoints or layers', async () => {
		const f = fixture(); const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		await expect(applyTranscriptEdit(f.world, '/project', f.original as never, 'wrong', ranges)).rejects.toThrow('expired');
		f.clip.props.end = 15;
		await expect(applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges)).rejects.toThrow('scene changed');
		expect(mocks.ipc).not.toHaveBeenCalled(); expect(f.editor.insertElement).not.toHaveBeenCalled();
	});

	it('rejects physical media changes after inspection even when library objects are cached', async () => {
		const f = fixture(); const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		f.stat.mtime++;
		await expect(applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges)).rejects.toThrow('changed while reviewing');
		expect(f.editor.insertElement).not.toHaveBeenCalled();
	});

	it('rechecks media after saving the new transcript before mutating clips', async () => {
		const f = fixture(); const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		f.library.flush.mockImplementationOnce(async () => { f.stat.mtime++; });
		await expect(applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges)).rejects.toThrow('changed while reviewing');
		expect(f.editor.insertElement).not.toHaveBeenCalled();
		expect(f.clip.alive).toBe(true); expect(f.captions.alive).toBe(true);
	});

	it('honors cancellation after the checkpoint without replacing the current timeline', async () => {
		const f = fixture(); const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		const controller = new AbortController();
		mocks.ipc.mockImplementation(async (channel: string) => { if (channel === 'projects:versions') return { fingerprint: 'source' }; controller.abort(); return { id: 'checkpoint' }; });
		await expect(applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges, { signal: controller.signal })).rejects.toThrow();
		expect(f.editor.insertElement).not.toHaveBeenCalled(); expect(f.library.store).not.toHaveBeenCalled();
	});

	it('keeps originals when replacement rendering fails before removal', async () => {
		const f = fixture(); const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		const insert = f.editor.insertElement.getMockImplementation()!;
		f.editor.insertElement.mockImplementationOnce(insert).mockImplementationOnce((parent, render) => { f.create(render() as AuthoredTree, parent); throw new Error('Render failed'); });
		await expect(applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges)).rejects.toThrow('Render failed');
		expect(f.original.children.filter((node) => node.alive)).toEqual([f.clip, f.captions]);
	});

	it('reports an applied edit explicitly when final saving fails', async () => {
		const f = fixture(); const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		mocks.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));
		await expect(applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges)).rejects.toThrow('was applied but could not be saved');
		expect(f.clip.alive).toBe(false); expect(getEditHistory(f.world).canUndo()).toBe(true);
	});

	it('keeps the prepared transcript trusted when callers change the returned words', async () => {
		const f = fixture(); const snapshot = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		snapshot.words[0]!.text = 'Untrusted replacement';
		await applyTranscriptEdit(f.world, '/project', f.original as never, snapshot.revision, ranges);
		const json = await (f.library.store.mock.calls[0]![0] as Blob).text();
		expect(json).toContain('Hello'); expect(json).not.toContain('Untrusted replacement');
	});

	it('reuses the inspected mix only while its scene and file metadata remain unchanged', async () => {
		const f = fixture(); const first = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		const second = await prepareTranscriptEdit(f.world, '/project', f.original as never);
		expect(second.revision).toBe(first.revision); expect(mocks.audio).toHaveBeenCalledOnce();
		await prepareTranscriptEdit(f.world, '/project', f.original as never, { refreshTranscript: true });
		expect(mocks.audio).toHaveBeenCalledTimes(2);
	});
});

