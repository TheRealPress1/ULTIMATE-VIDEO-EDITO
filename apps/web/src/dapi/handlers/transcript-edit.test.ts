import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../handler';
import type { EditorSession } from '../session';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), apply: vi.fn(), scene: vi.fn() }));
vi.mock('@/engine/transcript-edit', () => ({ prepareTranscriptEdit: mocks.inspect, applyTranscriptEdit: mocks.apply }));
vi.mock('../lib/scene', () => ({ requireScene: mocks.scene }));
import { transcriptEditApply, transcriptEditInspect } from './transcript-edit';

let session: EditorSession, active: EditorSession;
const target = { name: 'scene' };
const revision = 'a'.repeat(64);
const result = { sceneId: 'scene', duration: 5, previousDuration: 10, clipCount: 2, captionPath: 'Edited.json', checkpointId: 'checkpoint' };
const context = (signal = new AbortController().signal): ToolContext => ({ signal, session: () => active, requireSession: () => active, app: { openProject: vi.fn() } });
const input = { id: 'scene', refreshTranscript: false, wordOffset: 0, wordLimit: 1 };
beforeEach(() => {
	vi.resetAllMocks();
	session = { world: {}, project: { dir: () => '/project' } } as EditorSession; active = session;
	mocks.scene.mockReturnValue(target); mocks.apply.mockResolvedValue(result);
	mocks.inspect.mockResolvedValue({ revision, sceneId: 'scene', sceneName: 'Scene', duration: 10, frameRate: 30, transcriptSource: 'captions', warnings: [], words: [
		{ id: 'a', text: 'First', start: 1, end: 2, segment: 0 }, { id: 'b', text: 'Second', start: 6, end: 7, segment: 1 },
	], passages: [{ id: 'one', start: 0, end: 5, text: 'First', wordIds: ['a'] }, { id: 'two', start: 5, end: 10, text: 'Second', wordIds: ['b'] }], suggestions: [{ id: 'pause', kind: 'silence', start: 3, end: 5, text: 'Quiet pause' }] });
});

describe('timeline transcript handlers', () => {
	it('paginates words and relevant passages without dropping a pause between pages', async () => {
		const first = await transcriptEditInspect(input, context());
		expect(first.words.map((word) => word.id)).toEqual(['a']);
		expect(first.passages.map((passage) => passage.id)).toEqual(['one']);
		expect(first.nextWordOffset).toBe(1); expect(first.totalWords).toBe(2);
		expect(first.suggestions[0]!.id).toBe('pause');
		const next = await transcriptEditInspect({ ...input, wordOffset: 1 }, context());
		expect(next.suggestions[0]!.id).toBe('pause'); expect(next.nextWordOffset).toBeNull();
	});
	it('passes trusted revision and ordered retained ranges into the shared engine', async () => {
		const ctx = context(), ranges = [{ start: 5, end: 10 }];
		await expect(transcriptEditApply({ id: 'scene', revision, ranges }, ctx)).resolves.toEqual(result);
		expect(mocks.apply).toHaveBeenCalledWith(session.world, '/project', target, revision, ranges, expect.objectContaining({ signal: ctx.signal, assertCurrent: expect.any(Function) }));
	});
	it('rejects a project switch while inspecting', async () => {
		const inspected = await mocks.inspect();
		mocks.inspect.mockImplementation(async () => { active = { ...session }; return inspected; });
		await expect(transcriptEditInspect(input, context())).rejects.toMatchObject({ code: 'no-project' });
	});
	it('honors cancellation before either operation starts', async () => {
		await expect(transcriptEditInspect(input, context(AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' });
		await expect(transcriptEditApply({ id: 'scene', revision, ranges: [{ start: 0, end: 5 }] }, context(AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' });
		expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
	});
	it('reports a saved edit explicitly if its request is canceled just before the reply', async () => {
		const controller = new AbortController();
		mocks.apply.mockImplementation(async () => { controller.abort(); return result; });
		await expect(transcriptEditApply({ id: 'scene', revision, ranges: [{ start: 0, end: 5 }] }, context(controller.signal))).rejects.toThrow('applied and saved');
	});
});
