import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handle: vi.fn(), call: vi.fn(), flush: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ mainBridge: mocks }));
vi.mock('./edits', () => ({ flushProjectEdits: mocks.flush }));
import { installProjectFlushHandler } from './flush-handler';
import { MAIN_CHANNELS } from '@desktop/main-channels';

beforeEach(() => { vi.clearAllMocks(); mocks.flush.mockResolvedValue(undefined); mocks.call.mockResolvedValue(undefined); });
describe('app-wide quit save barrier', () => {
	it('replies on the dashboard with no project mounted', async () => {
		installProjectFlushHandler();
		expect(mocks.handle).toHaveBeenCalledWith(MAIN_CHANNELS.PROJECTS_FLUSH_REQUEST, expect.any(Function));
		mocks.handle.mock.calls[0]![1]({ id: 'quit-1' });
		await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.PROJECTS_FLUSH_RESULT, { id: 'quit-1' }));
		expect(mocks.flush).toHaveBeenCalledWith();
	});
	it('reports the save error so main can keep the app open', async () => {
		mocks.flush.mockRejectedValue(new Error('Footage drive disconnected'));
		installProjectFlushHandler();
		mocks.handle.mock.calls[0]![1]({ id: 'quit-2' });
		await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledWith(MAIN_CHANNELS.PROJECTS_FLUSH_RESULT, { id: 'quit-2', error: 'Footage drive disconnected' }));
	});
});
