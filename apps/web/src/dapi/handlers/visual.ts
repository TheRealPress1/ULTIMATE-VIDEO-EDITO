import { DapiError } from '@diffusionstudio/dapi';
import { getVisualService, type VisualItem } from '@/engine/visual-footage';
import type { ToolContext, ToolHandler } from '../handler';

function currentVisual(ctx: ToolContext) {
  ctx.signal.throwIfAborted();
  const session = ctx.requireSession();
  const dir = session.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (ctx.session() !== session || session.project.dir() !== dir) throw new DapiError('no-project', 'The open project changed while processing visual footage.');
  };
  return { service: getVisualService(session.world, dir), assertCurrent };
}
const status = (item: VisualItem) => ({ assetId: item.assetId, path: item.path, status: item.status,
  ...(item.error ? { error: item.error } : {}), ...(item.analysis ? { samples: item.analysis.samples.length, sampleInterval: item.analysis.sampleInterval } : {}) });

export const visualIndex: ToolHandler<'visual_index'> = async ({ paths, descriptions }, ctx) => {
  const { service, assertCurrent } = currentVisual(ctx);
  await service.indexPaths(paths, ctx.signal);
  assertCurrent();
  if (descriptions) { await service.descriptions.index(paths, ctx.signal); assertCurrent(); }
  return { items: service.snapshot().items.map(status) };
};
export const visualSearch: ToolHandler<'visual_search'> = async ({ query, path, limit, mode }, ctx) => {
  const { service, assertCurrent } = currentVisual(ctx);
  const idle = () => { if (service.snapshot().indexing) throw new DapiError('busy', 'Visual indexing is still running. Wait or cancel it before searching.'); };
  idle(); await service.load(); assertCurrent(); idle();
  if (mode === 'description') {
    const result = await service.descriptions.search(query, path, ctx.signal); assertCurrent();
    return { matches: result.matches.slice(0, limit), total: result.matches.length, method: 'local-clip-cosine', descriptionUnindexed: result.unindexed,
      unavailable: service.snapshot().items.filter((item) => (!path || item.path === path) && item.status !== 'ready').map(status) };
  }
  const matches = service.search(query).filter((match) => !path || match.path === path);
  return { matches: matches.slice(0, limit), total: matches.length, method: 'sampled-labels-ocr',
    unavailable: service.snapshot().items.filter((item) => (!path || item.path === path) && item.status !== 'ready').map(status) };
};
export const visualStatus: ToolHandler<'visual_status'> = async (_args, ctx) => {
  const { service, assertCurrent } = currentVisual(ctx);
  assertCurrent();
  const state = service.snapshot();
  return { indexing: state.indexing, loading: state.loading, items: state.items.map(status), ...(state.progress ? { progress: state.progress } : {}) };
};
