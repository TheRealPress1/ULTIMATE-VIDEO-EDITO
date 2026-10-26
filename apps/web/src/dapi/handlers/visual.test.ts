import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../handler';
import type { EditorSession } from '../session';
const mocks = vi.hoisted(() => ({ get: vi.fn(), load: vi.fn(), index: vi.fn(), search: vi.fn(), snapshot: vi.fn(), descriptionIndex: vi.fn(), descriptionSearch: vi.fn() }));
vi.mock('@/engine/visual-footage', () => ({ getVisualService: mocks.get }));
import { visualIndex, visualSearch, visualStatus } from './visual';
let session: EditorSession;
let active: EditorSession;
const ctx = (signal = new AbortController().signal): ToolContext => ({ signal, session: () => active, requireSession: () => active, app: { openProject: vi.fn() } });
const match = { id: 'hit', assetId: 'source', path: 'ride.mp4', fingerprint: 'a'.repeat(64), time: 5, sourceIn: 3, sourceOut: 8, score: 0.8,
  evidence: { time: 5, labels: [{ text: 'bicycle', confidence: 0.8 }], text: [], people: 1 }, matchedTerms: ['bike'] };
beforeEach(() => {
  vi.resetAllMocks(); session = { world: {}, project: { dir: () => '/project' } } as EditorSession; active = session;
  mocks.get.mockReturnValue({ load: mocks.load, indexPaths: mocks.index, search: mocks.search, snapshot: mocks.snapshot,
    descriptions: { index: mocks.descriptionIndex, search: mocks.descriptionSearch } });
  mocks.load.mockResolvedValue(undefined); mocks.index.mockResolvedValue(undefined);
  mocks.search.mockReturnValue([match, { ...match, path: 'other.mp4' }]);
  mocks.snapshot.mockReturnValue({ indexing: false, loading: false, items: [{ assetId: 'source', path: 'ride.mp4', status: 'ready' }, { assetId: 'changed', path: 'changed.mp4', status: 'stale' }] });
});
describe('visual MCP handlers', () => {
  it('uses optional local description indexing and distinguishes cosine scores from detector confidence', async () => {
    const context = ctx(); await visualIndex({ descriptions: true, paths: ['ride.mp4'] }, context);
    expect(mocks.descriptionIndex).toHaveBeenCalledWith(['ride.mp4'], context.signal);
    mocks.descriptionSearch.mockResolvedValue({ matches: [{ ...match, score: -0.1 }], unindexed: ['other.mp4'] });
    expect(await visualSearch({ mode: 'description', query: 'A cyclist on a city street', limit: 1 }, context)).toMatchObject({
      method: 'local-clip-cosine', matches: [{ score: -0.1 }], descriptionUnindexed: ['other.mp4'], total: 1,
    });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it('shares the project indexer and returns lightweight statuses', async () => {
    const context = ctx(); const result = await visualIndex({ descriptions: false, paths: ['ride.mp4'] }, context);
    expect(mocks.index).toHaveBeenCalledWith(['ride.mp4'], context.signal);
    expect(result.items[0]).toEqual({ assetId: 'source', path: 'ride.mp4', status: 'ready' });
  });
  it('refreshes sources before filtering and reports omitted stale files', async () => {
    expect(await visualSearch({ mode: 'keywords', query: 'bike', path: 'ride.mp4', limit: 1 }, ctx())).toEqual({ matches: [match], total: 1, unavailable: [], method: 'sampled-labels-ocr' });
    expect(mocks.load).toHaveBeenCalledOnce();
    expect((await visualSearch({ mode: 'keywords', query: '', limit: 50 }, ctx())).unavailable[0]?.status).toBe('stale');
  });
  it('rejects partial results while indexing and after navigation during refresh', async () => {
    mocks.snapshot.mockReturnValueOnce({ indexing: true });
    await expect(visualSearch({ mode: 'keywords', query: '', limit: 50 }, ctx())).rejects.toMatchObject({ code: 'busy' });
    mocks.load.mockImplementationOnce(async () => { active = { ...session }; });
    await expect(visualSearch({ mode: 'keywords', query: '', limit: 50 }, ctx())).rejects.toMatchObject({ code: 'no-project' });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it('reports cached status without initiating a scan and honors cancellation', async () => {
    expect((await visualStatus({}, ctx())).indexing).toBe(false);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.index).not.toHaveBeenCalled();
    await expect(visualIndex({ descriptions: false }, ctx(AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
