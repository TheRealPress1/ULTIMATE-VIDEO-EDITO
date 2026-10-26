import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../handler';
import type { EditorSession } from '../session';

const mocks = vi.hoisted(() => ({ create: vi.fn(), scene: vi.fn() }));
vi.mock('@/engine/reframe', () => ({ createReframeVariants: mocks.create }));
vi.mock('../lib/scene', () => ({ requireScene: mocks.scene }));
import { reframe } from './reframe';

let session: EditorSession;
let active: EditorSession;
const scene = { name: 'Scene' };
const input = { id: 'index.tsx:scene', formats: ['vertical' as const], mode: 'follow' as const };
const result = { variants: [{ sceneId: 'index.tsx:new', name: 'New', width: 1080, height: 1920, warnings: [] }], warnings: [], faceCoverage: 0.9, videoCount: 1 };
const context = (signal = new AbortController().signal): ToolContext => ({ signal, session: () => active, requireSession: () => active, app: { openProject: vi.fn() } });

beforeEach(() => {
	vi.resetAllMocks();
	session = { world: {}, project: { dir: () => '/project' } } as EditorSession;
	active = session;
	mocks.scene.mockReturnValue(scene);
	mocks.create.mockResolvedValue(result);
});

describe('reframe agent handler', () => {
	it('passes explicit scene-time corrections to the shared engine without inventing speaker evidence', async () => {
		const speakerFraming = { preference: 'right' as const, overrides: [{ start: 10.25, end: 18.5, preference: 'hold' as const }] };
		const corrected = { ...result, speakerSummary: { coverage: 0, switches: 0, analyzedSeconds: 20, fallbackSeconds: 0, manualSeconds: 20, heldSeconds: 8.25, evidenceSeconds: 0, wideSeconds: 0 } };
		mocks.create.mockResolvedValue(corrected);
		await expect(reframe({ ...input, mode: 'speakers', speakerFraming }, context())).resolves.toEqual(corrected);
		expect(mocks.create).toHaveBeenCalledWith(session.world, '/project', scene, expect.objectContaining({ mode: 'speakers', speakerFraming }));
	});
	it('uses the same engine as the editor with a project-session guard', async () => {
		const ctx = context();
		await expect(reframe(input, ctx)).resolves.toEqual(result);
		expect(mocks.scene).toHaveBeenCalledWith(session.world, input.id, 'reframe', expect.any(String));
		expect(mocks.create).toHaveBeenCalledWith(session.world, '/project', scene, expect.objectContaining({ formats: ['vertical'], mode: 'follow', signal: ctx.signal }));
		const options = mocks.create.mock.calls[0]![3] as { assertCurrent: () => void };
		active = { ...session };
		expect(options.assertCurrent).toThrow('project changed');
	});
	it('rejects a non-scene without starting preparation', async () => {
		mocks.scene.mockImplementation(() => { throw new Error('Not a scene'); });
		await expect(reframe(input, context())).rejects.toThrow('Not a scene');
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it('honors cancellation before invoking the engine', async () => {
		await expect(reframe(input, context(AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' });
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it('explicitly reports a committed result if canceled immediately before its reply', async () => {
		const controller = new AbortController();
		mocks.create.mockImplementation(async () => { controller.abort(); return result; });
		await expect(reframe(input, context(controller.signal))).rejects.toThrow('created and saved');
	});
});
