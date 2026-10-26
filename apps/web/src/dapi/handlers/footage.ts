import { DapiError } from "@diffusionstudio/dapi";
import { getFootageService, type FootageItem } from "@/engine/footage";
import type { ToolContext, ToolHandler } from "../handler";

function currentFootage(ctx: ToolContext) {
  ctx.signal.throwIfAborted();
  const session = ctx.requireSession();
  const dir = session.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (ctx.session() !== session || session.project.dir() !== dir) {
      throw new DapiError("no-project", "The open project changed while processing footage. Open the intended project and try again.");
    }
  };
  assertCurrent();
  return { service: getFootageService(session.world, dir), assertCurrent };
}

const status = ({ assetId, path, status, error, partial }: FootageItem) => ({ assetId, path, status, ...(error ? { error } : {}), ...(partial ? { partial } : {}) });

export const footageIndex: ToolHandler<"footage_index"> = async ({ paths }, ctx) => {
  const { service, assertCurrent } = currentFootage(ctx);
  await service.indexPaths(paths, ctx.signal);
  assertCurrent();
  return { items: service.snapshot().items.map(status) };
};

export const footageSearch: ToolHandler<"footage_search"> = async ({ query, path, limit }, ctx) => {
  const { service, assertCurrent } = currentFootage(ctx);
  const requireIdle = () => {
    if (service.snapshot().indexing) throw new DapiError("busy", "Footage indexing is still running. Wait for it to finish or cancel it before searching.");
  };
  requireIdle();
  await service.load();
  assertCurrent();
  requireIdle();
  const matches = service.search(query).filter((match) => !path || match.path === path);
  const unavailable = service.snapshot().items
    .filter((item) => (!path || item.path === path) && item.status !== "ready" && item.status !== "no-speech")
    .map(status);
  return { matches: matches.slice(0, limit), total: matches.length, unavailable };
};

export const footageCut: ToolHandler<"footage_cut"> = async ({ passages, name, width, height }, ctx) => {
  const { service, assertCurrent } = currentFootage(ctx);
  const matches = await service.resolvePassages(passages, ctx.signal);
  assertCurrent();
  const result = await service.createCut(matches, { name, width, height }, ctx.signal);
  try { assertCurrent(); }
  catch (cause) { throw new Error(`The cut ${result.sceneId} was created and saved, but the request stopped afterward. Open the project and review it before creating another cut.`, { cause }); }
  return result;
};
