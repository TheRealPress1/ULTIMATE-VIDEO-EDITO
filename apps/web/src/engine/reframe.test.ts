import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { World } from 'koota';
import type { CapturedNode, EntityEdit } from './editor';

const mocks = vi.hoisted(() => ({ editor: vi.fn(), flush: vi.fn(), render: vi.fn(), focus: vi.fn(), analyze: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { async getPrimaryVideoTrack() { return { getFirstTimestamp: async () => 0 }; } dispose() {} } }));
vi.mock('@/lib/local-reframe', () => ({ analyzeReframeLocally: mocks.analyze }));
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
	Root: 'root', Source: 'source', Library: 'library', FrameRate: 'fps', Computed: 'computed', focusRect: mocks.focus,
	getCameraMatrix: () => [1, 0, 0, 1, 0, 0], getNextName: () => 'Transcript cut 1',
	getEntityChildren: (_world: unknown, entity: { children: FakeEntity[] }) => entity.children.filter((child) => child.alive),
}));

import { createReframeVariants } from './reframe';
import { getEditHistory } from './history';

interface FakeEntity {
	source: string;
	tag: string;
	props: Record<string, unknown>;
	alive: boolean;
	parent?: FakeEntity;
	children: FakeEntity[];
	get(trait: string): { value: string } | { start: number; end: number; origin: number; playbackRate: number } | undefined;
	isAlive(): boolean;
}

const options = { formats: ['vertical', 'square'] as const, mode: 'follow' as const };

function fixture() {
	let id = 0;
	const all: FakeEntity[] = [];
	const listeners = new Set<(edit: EntityEdit) => void>();
	const renames = new Set<(ids: Record<string, string>) => void>();
	const emit = (edit: EntityEdit) => listeners.forEach((listener) => listener(edit));
	const create = (tree: AuthoredTree, parent?: FakeEntity, source = `pending#${++id}`): FakeEntity => {
		const entity: FakeEntity = {
			source, tag: tree.tag, props: { ...tree.props }, parent, alive: true, children: [],
			get: (trait) => trait === 'source' ? { value: entity.source } : trait === 'computed' ? { start: Number(entity.props.start ?? 0) * 30, end: Number(entity.props.end ?? 30) * 30, origin: (Number(entity.props.start ?? 0) - Number(entity.props.sourceIn ?? 0) / Number(entity.props.playbackRate ?? 1)) * 30, playbackRate: Number(entity.props.playbackRate ?? 1) } : undefined,
			isAlive: () => entity.alive,
		};
		all.push(entity);
		parent?.children.push(entity);
		for (const child of tree.children) create(child, entity);
		return entity;
	};
	const root = create({ tag: 'stage', props: {}, children: [] }, undefined, 'project.tsx:1');
	const original = create({ tag: 'scene', props: { name: 'Original', x: 0, y: 0, width: 1920, height: 1080 }, children: [] }, root, 'project.tsx:2');
	const asset = { id: 'video', path: 'Interview.mp4', source: '/media/Interview.mp4', type: 'VIDEO', handle: { getFile: async () => new Blob() }, duration: 30, width: 1920, height: 1080 };
	const stat = { size: 100, mtime: 123 };
	const clip = create({ tag: 'video', props: { src: asset.path, width: 1920, height: 1080, start: 0, end: 30 }, children: [] }, original, 'project.tsx:clip');
	const library = {
		resolve: vi.fn(async () => asset),
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

beforeEach(() => {
	vi.resetAllMocks();
	mocks.render.mockImplementation((tree) => tree);
	mocks.analyze.mockResolvedValue({ duration: 30, width: 1920, height: 1080, sampleInterval: 0.5, samples: [
		{ time: 0, cut: false, faces: [{ x: 0.2, y: 0.3, width: 0.2, height: 0.3, confidence: 1 }] },
		{ time: 1, cut: false, faces: [{ x: 0.3, y: 0.3, width: 0.2, height: 0.3, confidence: 1 }] },
	] });
});

describe('reframe composition transaction', () => {
	it('creates adjacent variants in one undo step and restores them with redo', async () => {
		const f = fixture(); const original = JSON.stringify(f.original.props);
		const history = getEditHistory(f.world);
		const result = await createReframeVariants(f.world, '/project', f.original as never, options);
		expect(result.variants).toHaveLength(2);
		expect(result.faceCoverage).toBe(1);
		expect(mocks.analyze).toHaveBeenCalledOnce();
		const variants = f.live().filter((entity) => entity.tag === 'scene' && entity !== f.original);
		expect(variants[0]!.props).toMatchObject({ x: 2040, width: 1080, height: 1920 });
		expect(variants[1]!.props).toMatchObject({ x: 3240, width: 1080, height: 1080 });
		expect(history.canUndo()).toBe(true);
		history.undo();
		expect(f.live()).toEqual([f.root, f.original, f.clip]);
		expect(history.canUndo()).toBe(false);
		history.redo();
		expect(f.live().filter((entity) => entity.tag === 'scene')).toHaveLength(3);
		expect(JSON.stringify(f.original.props)).toBe(original);
	});
	it('rejects corrections beyond the scene before analysis or insertion', async () => {
		const f = fixture(), analyzeSpeakers = vi.fn();
		await expect(createReframeVariants(f.world, '/project', f.original as never, { ...options, mode: 'speakers', analyzeSpeakers, speakerFraming: { overrides: [{ start: 29, end: 31, preference: 'left' }] } })).rejects.toThrow('within the selected scene');
		expect(analyzeSpeakers).not.toHaveBeenCalled();
		expect(f.editor.insertElement).not.toHaveBeenCalled();
	});
	it('rejects transition-overlap corrections before analysis or insertion', async () => {
		const f = fixture(), analyzeSpeakers = vi.fn(); f.clip.props.transition = { type: 'dissolve', duration: 2 };
		await expect(createReframeVariants(f.world, '/project', f.original as never, { ...options, mode: 'speakers', analyzeSpeakers, speakerFraming: { overrides: [{ start: 2, end: 4, preference: 'left' }] } })).rejects.toThrow('transition overlaps');
		expect(analyzeSpeakers).not.toHaveBeenCalled(); expect(f.editor.insertElement).not.toHaveBeenCalled();
	});
	it('applies a framing correction on a copy, retaining the original and one-step undo', async () => {
		const f = fixture();
		const before = JSON.stringify(f.original.props), beforeClip = JSON.stringify(f.clip.props);
		const analyzeSpeakers = vi.fn(async () => ({ engine: 'fixture', fingerprint: 'a'.repeat(64), width: 1920, height: 1080, start: 0, end: 30, sourceStart: 0, sampleInterval: 0.5, resumedChunks: 0, totalChunks: 1, warnings: [],
			samples: Array.from({ length: 60 }, (_, i) => ({ time: i / 2, cut: false, audioRms: 0.1, activeTrackId: null, reason: 'uncertain' as const, faces: [{ trackId: 'left', x: 0.1, y: 0.2, width: 0.15, height: 0.2, confidence: 1, speakingScore: 0 }] })) }));
		const history = getEditHistory(f.world);
		const result = await createReframeVariants(f.world, '/project', f.original as never, { ...options, mode: 'speakers', analyzeSpeakers, speakerFraming: { overrides: [{ start: 2, end: 4, preference: 'left' }] } });
		expect(result.speakerSummary).toMatchObject({ coverage: 0, evidenceSeconds: 0, manualSeconds: 2 });
		expect(result.warnings.join(' ')).toContain('explicit framing preferences');
		expect(JSON.stringify(f.original.props)).toBe(before); expect(JSON.stringify(f.clip.props)).toBe(beforeClip);
		expect(analyzeSpeakers).toHaveBeenCalledOnce();
		history.undo(); expect(f.live()).toEqual([f.root, f.original, f.clip]);
		expect(history.canUndo()).toBe(false);
	});
	it('center mode creates no detector work', async () => {
		const f = fixture();
		const result = await createReframeVariants(f.world, '/project', f.original as never, { ...options, mode: 'center' });
		expect(result.faceCoverage).toBeNull();
		expect(mocks.analyze).not.toHaveBeenCalled();
	});
	it('accepts native fractional modification time matching the library whole-millisecond timestamp', async () => {
		const f = fixture(); f.stat.mtime = 123.456;
		Object.assign(f.asset, { stat: { size: 100, mtime: 123 } });
		await expect(createReframeVariants(f.world, '/project', f.original as never, { ...options, mode: 'center' })).resolves.toMatchObject({ videoCount: 1 });
	});
	it('fails without edits when the scene changes while analysis is running', async () => {
		const f = fixture();
		const result = await mocks.analyze();
		mocks.analyze.mockImplementation(async () => { f.clip.props.end = 15; return result; });
		await expect(createReframeVariants(f.world, '/project', f.original as never, options)).rejects.toThrow('source scene changed');
		expect(f.editor.insertElement).not.toHaveBeenCalled();
	});
	it('rejects a source file changed after an earlier scan while the next clip is analyzed', async () => {
		const f = fixture();
		f.create({ tag: 'video', props: { src: 'Second.mp4', width: 1920, height: 1080, start: 30, end: 60 }, children: [] }, f.original, 'project.tsx:second');
		const second = { ...f.asset, id: 'second', path: 'Second.mp4', source: '/Second.mp4' };
		f.library.resolve.mockImplementation(async (path?: string) => path === 'Second.mp4' ? second : f.asset);
		const result = await mocks.analyze();
		mocks.analyze.mockResolvedValueOnce(result).mockImplementationOnce(async () => { f.stat.mtime++; return result; });
		await expect(createReframeVariants(f.world, '/project', f.original as never, options)).rejects.toThrow('changed on disk while preparing');
		expect(f.editor.insertElement).not.toHaveBeenCalled();
	});
	it('cancellation before insertion leaves the scene unchanged', async () => {
		const f = fixture(); const controller = new AbortController();
		const result = await mocks.analyze();
		mocks.analyze.mockImplementation(async () => { controller.abort(); return result; });
		await expect(createReframeVariants(f.world, '/project', f.original as never, { ...options, signal: controller.signal })).rejects.toThrow();
		expect(f.editor.insertElement).not.toHaveBeenCalled();
		expect(f.live()).toEqual([f.root, f.original, f.clip]);
	});
	it('removes every new scene when a later scene fails to insert', async () => {
		const f = fixture();
		const insert = f.editor.insertElement.getMockImplementation()!;
		f.editor.insertElement.mockImplementationOnce(insert).mockImplementationOnce((parent, render) => { f.create(render() as AuthoredTree, parent); throw new Error('Render failed'); });
		await expect(createReframeVariants(f.world, '/project', f.original as never, options)).rejects.toThrow('Render failed');
		expect(f.live()).toEqual([f.root, f.original, f.clip]);
	});
	it('explains recovery if a complete result cannot be saved', async () => {
		const f = fixture();
		mocks.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));
		await expect(createReframeVariants(f.world, '/project', f.original as never, options)).rejects.toThrow('versions were created but could not be saved');
		expect(f.live().filter((entity) => entity.tag === 'scene')).toHaveLength(3);
	});
	it('does not suggest retrying creation after cancellation during the final save', async () => {
		const f = fixture(); const controller = new AbortController();
		mocks.flush.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { controller.abort(); });
		await expect(createReframeVariants(f.world, '/project', f.original as never, { ...options, signal: controller.signal })).rejects.toThrow('versions were created and saved');
		expect(f.live().filter((entity) => entity.tag === 'scene')).toHaveLength(3);
	});
	it('does not analyze or edit when the existing project cannot save', async () => {
		const f = fixture();
		mocks.flush.mockRejectedValueOnce(new Error('Save failed'));
		await expect(createReframeVariants(f.world, '/project', f.original as never, options)).rejects.toThrow('Save failed');
		expect(mocks.analyze).not.toHaveBeenCalled();
		expect(f.editor.insertElement).not.toHaveBeenCalled();
	});
});

