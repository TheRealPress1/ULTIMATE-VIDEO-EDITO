import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), flush: vi.fn(), scene: vi.fn() }));
vi.mock("@/engine/generate/captions", () => ({ generateCaptions: mocks.generate }));
vi.mock("@/projects/edits", () => ({ flushProjectEdits: mocks.flush }));
vi.mock("../lib/scene", () => ({ requireScene: mocks.scene }));
import { captions } from "./captions";
import type { ToolContext } from "../handler";

function fixture() {
  const session = { world: {}, project: { dir: () => "/project" }, engine: {} };
  const ctx = { requireSession: () => session, session: vi.fn(() => session), signal: new AbortController().signal } as unknown as ToolContext;
  return { ctx, session };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.flush.mockResolvedValue(undefined);
  mocks.scene.mockReturnValue({});
  mocks.generate.mockResolvedValue({ path: "Captions 1.json", segments: 1, words: 3, replacedExisting: false });
});
describe("scene caption tool", () => {
  it("flushes existing edits before generation and persists the result before returning", async () => {
    const { ctx } = fixture();
    await expect(captions({ id: "scene" }, ctx)).resolves.toMatchObject({ id: "scene", words: 3 });
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.generate.mock.invocationCallOrder[0]!);
    expect(mocks.flush.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.generate.mock.invocationCallOrder[0]!);
    expect(mocks.generate.mock.calls[0]![3]).toMatchObject({ signal: ctx.signal, throwErrors: true });
  });
  it("does not transcribe when an earlier save fails", async () => {
    mocks.flush.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(captions({ id: "scene" }, fixture().ctx)).rejects.toThrow("Disk unavailable");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not report success when captions cannot be saved", async () => {
    mocks.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Save failed"));
    await expect(captions({ id: "scene" }, fixture().ctx)).rejects.toThrow("Save failed");
  });
  it("rejects navigation during the initial save without captioning another project", async () => {
    const { ctx } = fixture();
    mocks.flush.mockImplementationOnce(async () => { vi.mocked(ctx.session).mockReturnValue(null); });
    await expect(captions({ id: "scene" }, ctx)).rejects.toMatchObject({ code: "no-project" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
