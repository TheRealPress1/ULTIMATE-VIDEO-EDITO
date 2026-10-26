import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../handler";
import type { EditorSession } from "../session";

const mocks = vi.hoisted(() => ({
  getService: vi.fn(), load: vi.fn(), indexPaths: vi.fn(), search: vi.fn(), snapshot: vi.fn(), resolvePassages: vi.fn(), createCut: vi.fn(),
}));
vi.mock("@/engine/footage", () => ({ getFootageService: mocks.getService }));
import { footageCut, footageIndex, footageSearch } from "./footage";

const reference = { assetId: "source", fingerprint: "a".repeat(64), sourceIn: 1, sourceOut: 3 };
const match = { ...reference, id: "match-1", path: "interview.mov", text: "Good point", words: [{ text: "Good", start: 1, end: 2 }, { text: "point", start: 2, end: 3 }] };
const secondMatch = { ...match, id: "match-2", sourceIn: 5, sourceOut: 7 };
let session: EditorSession;
let active: EditorSession;
const context = (signal = new AbortController().signal): ToolContext => ({
  signal, session: () => active, requireSession: () => active, app: { openProject: vi.fn() },
});
beforeEach(() => {
  vi.resetAllMocks();
  session = { world: {}, project: { dir: () => "/project" } } as EditorSession;
  active = session;
  mocks.getService.mockReturnValue({
    load: mocks.load, indexPaths: mocks.indexPaths, search: mocks.search, snapshot: mocks.snapshot,
    resolvePassages: mocks.resolvePassages, createCut: mocks.createCut,
  });
  mocks.load.mockResolvedValue(undefined);
  mocks.indexPaths.mockResolvedValue(undefined);
  mocks.resolvePassages.mockResolvedValue([match]);
  mocks.createCut.mockResolvedValue({ sceneId: "new-scene", duration: 2, clipCount: 1 });
  mocks.search.mockReturnValue([match, secondMatch, { ...match, assetId: "other", path: "other.mov" }]);
  mocks.snapshot.mockReturnValue({ items: [
    { assetId: "source", path: "interview.mov", status: "ready", segments: [{ text: "private large transcript" }] },
    { assetId: "changed", path: "changed.mov", status: "stale" },
    { assetId: "broken", path: "broken.mov", status: "error", error: "Missing media" },
    { assetId: "silent", path: "silent.mov", status: "no-speech" },
  ] });
});

describe("footage agent handlers", () => {
  it("shares project indexing and returns lightweight per-asset failure statuses", async () => {
    const ctx = context();
    const result = await footageIndex({ paths: ["interview.mov"] }, ctx);
    expect(mocks.getService).toHaveBeenCalledWith(session.world, "/project");
    expect(mocks.indexPaths).toHaveBeenCalledWith(["interview.mov"], ctx.signal);
    expect(result.items[0]).toEqual({ assetId: "source", path: "interview.mov", status: "ready" });
    expect(result.items[2]).toMatchObject({ status: "error", error: "Missing media" });
    expect(result.items[0]).not.toHaveProperty("segments");
  });

  it("refreshes before search, filters before limiting, and exposes omitted source problems", async () => {
    const result = await footageSearch({ query: "good point", path: "interview.mov", limit: 1 }, context());
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.search).toHaveBeenCalledWith("good point");
    expect(result).toEqual({ matches: [match], total: 2, unavailable: [] });
    const all = await footageSearch({ query: "", limit: 100 }, context());
    expect(all.unavailable.map((item) => item.assetId)).toEqual(["changed", "broken"]);
  });

  it("resolves trusted indexed words before creating a new cut", async () => {
    const ctx = context();
    await expect(footageCut({ passages: [reference], name: "Selected story", width: 1080, height: 1920 }, ctx)).resolves.toEqual({ sceneId: "new-scene", duration: 2, clipCount: 1 });
    expect(mocks.resolvePassages).toHaveBeenCalledWith([reference], ctx.signal);
    expect(mocks.createCut).toHaveBeenCalledWith([match], { name: "Selected story", width: 1080, height: 1920 }, ctx.signal);
  });

  it("does not search a cached partial snapshot while indexing is active", async () => {
    mocks.snapshot.mockReturnValue({ items: [], indexing: true });
    await expect(footageSearch({ query: "good point", limit: 100 }, context())).rejects.toMatchObject({ code: "busy" });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rechecks indexing state after loading before returning search results", async () => {
    mocks.load.mockImplementationOnce(async () => { mocks.snapshot.mockReturnValue({ items: [], indexing: true }); });
    await expect(footageSearch({ query: "good point", limit: 100 }, context())).rejects.toMatchObject({ code: "busy" });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("does not create scenes from stale references or after switching projects", async () => {
    mocks.resolvePassages.mockRejectedValueOnce(new Error("This recording changed"));
    await expect(footageCut({ passages: [reference] }, context())).rejects.toThrow("changed");
    expect(mocks.createCut).not.toHaveBeenCalled();
    mocks.resolvePassages.mockImplementationOnce(async () => { active = { ...session }; return [match]; });
    await expect(footageCut({ passages: [reference] }, context())).rejects.toMatchObject({ code: "no-project" });
    expect(mocks.createCut).not.toHaveBeenCalled();
  });

  it("honors cancellation before indexing and before a cut commit", async () => {
    await expect(footageIndex({}, context(AbortSignal.abort()))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.indexPaths).not.toHaveBeenCalled();
    const controller = new AbortController();
    mocks.resolvePassages.mockImplementationOnce(async () => { controller.abort(); return [match]; });
    await expect(footageCut({ passages: [reference] }, context(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.createCut).not.toHaveBeenCalled();
  });

  it("makes a committed cut explicit if cancellation arrives just before the reply", async () => {
    const controller = new AbortController();
    mocks.createCut.mockImplementationOnce(async () => { controller.abort(); return { sceneId: 'saved', duration: 2, clipCount: 1 }; });
    await expect(footageCut({ passages: [reference] }, context(controller.signal))).rejects.toThrow('created and saved');
  });
});
