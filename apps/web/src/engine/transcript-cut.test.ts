import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { World } from 'koota';
import type { CapturedNode, EntityEdit } from './editor';

const mocks = vi.hoisted(() => ({ editor: vi.fn(), flush: vi.fn(), render: vi.fn(), focus: vi.fn() }));
vi.mock('./editor', () => ({ getDocumentEditor: mocks.editor, isPendingSource: (source: string) => source.startsWith('pending#') }));
vi.mock('@/projects/edits', () => ({ flushProjectEdits: mocks.flush }));
vi.mock('@diffusionstudio/reconciler', () => ({
	renderAuthored: mocks.render,
	authoredElement: (entity: { tag: string; props: object }) => ({ tag: entity.tag, props: entity.props }),
}));
vi.mock('@diffusionstudio/runtime', () => ({
	Root: 'root', Source: 'source', Library: 'library', FrameRate: 'fps', focusRect: mocks.focus,
	getCameraMatrix: () => [1, 0, 0, 1, 0, 0], getNextName: () => 'Transcript cut 1',
	getEntityChildren: (_world: unknown, entity: { children: FakeEntity[] }) => entity.children.filter((child) => child.alive),
}));

import { createTranscriptCut } from './transcript-cut';
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
}

const passage = { assetId: 'video', fingerprint: 'content-hash', sourceIn: 10, sourceOut: 12, words: [{ text: 'Hello.', start: 10.1, end: 11.8 }] };

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
			isAlive: () => entity.alive,
		};
		all.push(entity);
		parent?.children.push(entity);
		for (const child of tree.children) create(child, entity);
		return entity;
	};
	const root = create({ tag: 'stage', props: {}, children: [] }, undefined, 'project.tsx:1');
	const original = create({ tag: 'scene', props: { name: 'Original', x: 0, y: 0, width: 1920, height: 1080 }, children: [] }, root, 'project.tsx:2');
	const asset = { id: 'video', path: 'Interview.mp4', source: '/media/Interview.mp4', type: 'VIDEO', duration: 30, width: 1920, height: 1080 };
	const library = {
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
	return { world, root, original, asset, library, editor, all, create, live: () => all.filter((entity) => entity.alive), emit };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.render.mockImplementation((tree) => tree);
});

describe('transcript cut creation', () => {
	it('saves captions before fingerprint revalidation, then persists one undoable cut', async () => {
		const f = fixture();
		const history = getEditHistory(f.world);
		const validateSources = vi.fn().mockResolvedValue(undefined);
		const result = await createTranscriptCut(f.world, '/project', [passage, passage], { validateSources });
		expect(result).toEqual({ sceneId: 'project.tsx:102', duration: 4, clipCount: 2 });
		expect(f.library.flush.mock.invocationCallOrder[0]).toBeLessThan(validateSources.mock.invocationCallOrder[0]!);
		expect(validateSources.mock.invocationCallOrder[0]).toBeLessThan(f.editor.insertElement.mock.invocationCallOrder[0]!);
		const transcript = JSON.parse(await (f.library.store.mock.calls[0]![0] as Blob).text());
		expect(transcript[1].words[0].start).toBeCloseTo(2.1);
		const scene = f.live().find((entity) => entity.source === result.sceneId)!;
		expect(scene.props).toMatchObject({ x: 2040, width: 1920, height: 1080 });
		expect(scene.children.at(-1)).toMatchObject({ tag: 'captions', props: { src: 'Transcript cut captions.json', sourceOut: 4 } });
		const snapshot = scene.children.map((entity) => ({ tag: entity.tag, props: entity.props }));
		expect(history.canUndo()).toBe(true);
		history.undo();
		expect(f.live()).toEqual([f.root, f.original]);
		expect(history.canUndo()).toBe(false);
		history.redo();
		const restored = f.live().find((entity) => entity.tag === 'scene' && entity !== f.original)!;
		expect(restored.children.filter((child) => child.alive).map((entity) => ({ tag: entity.tag, props: entity.props }))).toEqual(snapshot);
		expect(f.original.props.name).toBe('Original');
	});

	it('rejects stale source fingerprints without modifying the document', async () => {
		const f = fixture();
		await expect(createTranscriptCut(f.world, '/project', [passage], {
			validateSources: async () => { throw new Error('Source changed'); },
		})).rejects.toThrow('Source changed');
		expect(f.editor.insertElement).not.toHaveBeenCalled();
		expect(f.live()).toEqual([f.root, f.original]);
	});

	it('places a cut beside an existing scene whose x coordinate defaults to zero', async () => {
		const f = fixture();
		delete f.original.props.x;
		const result = await createTranscriptCut(f.world, '/project', [passage]);
		expect(f.live().find((entity) => entity.source === result.sceneId)?.props.x).toBe(2040);
	});

	it('rejects navigation or source rename during asynchronous preparation', async () => {
		const f = fixture();
		f.library.flush.mockImplementation(async () => { f.asset.path = 'Renamed.mp4'; });
		await expect(createTranscriptCut(f.world, '/project', [passage])).rejects.toThrow('moved or was removed');
		expect(f.editor.insertElement).not.toHaveBeenCalled();
		const other = fixture();
		let current = true;
		other.library.flush.mockImplementation(async () => { current = false; });
		await expect(createTranscriptCut(other.world, '/project', [passage], {
			assertCurrent: () => { if (!current) throw new Error('Project switched'); },
		})).rejects.toThrow('Project switched');
		expect(other.editor.insertElement).not.toHaveBeenCalled();
	});

	it('does not touch the document when the existing project or captions cannot save', async () => {
		const f = fixture();
		mocks.flush.mockRejectedValueOnce(new Error('Existing edits failed'));
		await expect(createTranscriptCut(f.world, '/project', [passage])).rejects.toThrow('Existing edits failed');
		expect(f.library.store).not.toHaveBeenCalled();
		f.library.flush.mockRejectedValueOnce(new Error('Manifest failed'));
		await expect(createTranscriptCut(f.world, '/project', [passage])).rejects.toThrow('Manifest failed');
		expect(f.editor.insertElement).not.toHaveBeenCalled();
	});

	it('discards partially rendered, unreported entities without adding an undo step', async () => {
		const f = fixture();
		const history = getEditHistory(f.world);
		f.editor.insertElement.mockImplementationOnce((parent, render) => {
			f.create(render() as AuthoredTree, parent);
			throw new Error('Render failed');
		});
		await expect(createTranscriptCut(f.world, '/project', [passage])).rejects.toThrow('Render failed');
		expect(f.live()).toEqual([f.root, f.original]);
		expect(history.canUndo()).toBe(false);
	});

	it('cleans up reported insertions without leaving a partial scene', async () => {
		const f = fixture();
		const history = getEditHistory(f.world);
		const insert = f.editor.insertElement.getMockImplementation()!;
		f.editor.insertElement.mockImplementationOnce((parent, render) => { insert(parent, render); throw new Error('Insert failed'); });
		await expect(createTranscriptCut(f.world, '/project', [passage])).rejects.toThrow('Insert failed');
		expect(f.live()).toEqual([f.root, f.original]);
		history.undo();
		expect(f.live()).toEqual([f.root, f.original]);
	});

	it('retains a complete cut on final save failure and explains recovery', async () => {
		const f = fixture();
		mocks.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));
		await expect(createTranscriptCut(f.world, '/project', [passage])).rejects.toThrow('Retry saving this project');
		expect(f.live().filter((entity) => entity.tag === 'scene')).toHaveLength(2);
		expect(getEditHistory(f.world).canUndo()).toBe(true);
	});

	it('makes cancellation after committing explicit instead of suggesting no cut was made', async () => {
		const f = fixture();
		const controller = new AbortController();
		mocks.flush.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { controller.abort(); });
		await expect(createTranscriptCut(f.world, '/project', [passage], {
			assertCurrent: () => controller.signal.throwIfAborted(),
		})).rejects.toThrow('cut was created and saved');
		expect(f.live().filter((entity) => entity.tag === 'scene')).toHaveLength(2);
	});
});
