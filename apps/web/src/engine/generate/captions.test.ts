import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  available: vi.fn(), transcribe: vi.fn(), sections: vi.fn(), audio: vi.fn(), hasAudio: vi.fn(), children: vi.fn(),
  tree: vi.fn(), element: vi.fn(), editor: vi.fn(), shimmer: vi.fn(), release: vi.fn(),
  toast: Object.assign(vi.fn(), { loading: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/local-transcription", () => ({
  assertLocalTranscriptionAvailable: mocks.available, transcribeLocally: mocks.transcribe,
  MAX_TRANSCRIPTION_SECONDS: 7200, isTranscriptionCanceled: (e: Error) => e.name === "AbortError",
}));
vi.mock("../scene-audio", () => ({ encodeSceneAudio: mocks.audio, hasAudio: mocks.hasAudio }));
vi.mock("../scene-speech", () => ({ transcribeSceneSections: mocks.sections }));
vi.mock("../editor", () => ({ getDocumentEditor: mocks.editor }));
vi.mock("./shimmer", () => ({ shimmer: mocks.shimmer }));
vi.mock("somoto", () => ({ toast: mocks.toast }));
vi.mock("@diffusionstudio/assets", () => ({ assetName: () => "Captions 1.json" }));
vi.mock("@diffusionstudio/reconciler", () => ({ authoredElement: mocks.element, authoredTree: mocks.tree, Captions: vi.fn() }));
vi.mock("@diffusionstudio/runtime", () => ({
  Caption: "caption", Computed: "computed", FrameRate: "rate", getEntityChildren: mocks.children, getEntityTree: mocks.children,
  Library: "library", Shimmering: "shimmering",
}));

import { generateCaptions } from "./captions";
import type { Entity, World } from "koota";

const segments = [{ text: "Hello.", words: [{ text: "Hello.", start: 0, end: 1 }] }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const library = { list: () => [], store: vi.fn().mockResolvedValue({ path: "Captions 1.json" }), flush: vi.fn().mockResolvedValue(undefined) };
  const world = { get: vi.fn((trait) => trait === "library" ? library : { value: 30 }) } as unknown as World;
  const scene = { has: () => false, get: () => ({ duration: 300 }), isAlive: vi.fn(() => true) } as unknown as Entity;
  const caption = { has: (trait: string) => trait === "caption" } as unknown as Entity;
  const editor = { deselect: vi.fn(), select: vi.fn(), editProperty: vi.fn(), insertElement: vi.fn(() => [caption]), onEdit: vi.fn((_callback: (edit: unknown) => void) => vi.fn()) };
  mocks.editor.mockReturnValue(editor);
  mocks.children.mockReturnValue([caption]);
  mocks.element.mockReturnValue({ props: { src: "original.json", preset: "whisper", colors: [0xff00ff] } });
  mocks.tree.mockReturnValue({ tag: "scene", props: {}, children: [] });
  return { world, scene, library, caption, editor };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.available.mockResolvedValue(undefined);
  mocks.hasAudio.mockReturnValue(true);
  mocks.audio.mockResolvedValue(new Blob(["audio"]));
  mocks.transcribe.mockResolvedValue(segments);
  mocks.sections.mockResolvedValue(segments);
  mocks.shimmer.mockReturnValue(mocks.release);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("local caption generation", () => {
  it("uses resumable bounded sections for long scenes and commits only the completed transcript", async () => {
    const { world, scene, editor, library } = fixture();
    vi.spyOn(scene, 'get').mockReturnValue({ duration: 5400 * 30 });
    await generateCaptions(world, scene, '/project', { throwErrors: true });
    expect(mocks.sections).toHaveBeenCalledWith(world, scene, '/project', expect.objectContaining({ duration: 5400, snapshot: expect.any(String) }));
    expect(mocks.audio).not.toHaveBeenCalled(); expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(library.flush).toHaveBeenCalledOnce(); expect(editor.editProperty).toHaveBeenCalledOnce();
  });

  it("preserves the caption layer and asset when a later long-scene section fails or saving fails", async () => {
    const { world, scene, editor, library } = fixture();
    vi.spyOn(scene, 'get').mockReturnValue({ duration: 5400 * 30 });
    mocks.sections.mockRejectedValueOnce(new Error('Section interrupted; saved sections remain'));
    await expect(generateCaptions(world, scene, '/project', { throwErrors: true })).rejects.toThrow('Section interrupted');
    expect(library.store).not.toHaveBeenCalled(); expect(editor.editProperty).not.toHaveBeenCalled();
    library.flush.mockRejectedValueOnce(new Error('Disk is full'));
    await expect(generateCaptions(world, scene, '/project', { throwErrors: true })).rejects.toThrow('Disk is full');
    expect(editor.editProperty).not.toHaveBeenCalled(); expect(editor.insertElement).not.toHaveBeenCalled();
  });

  it("inserts one scene caption when none exists", async () => {
    const { world, scene, editor } = fixture();
    mocks.children.mockReturnValue([]);
    await expect(generateCaptions(world, scene, undefined, { throwErrors: true })).resolves.toMatchObject({ replacedExisting: false, words: 1 });
    expect(editor.insertElement).toHaveBeenCalledExactlyOnceWith(scene, expect.any(Function));
    expect(editor.editProperty).not.toHaveBeenCalled();
  });

  it("returns transcript details for API callers and rejects overlapping timed captions", async () => {
    const { world, scene } = fixture();
    await expect(generateCaptions(world, scene, undefined, { throwErrors: true })).resolves.toEqual({ path: "Captions 1.json", segments: 1, words: 1, replacedExisting: true });
    mocks.element.mockReturnValue({ props: { src: "trimmed.json", sourceIn: 10 } });
    await expect(generateCaptions(world, scene, undefined, { throwErrors: true })).rejects.toThrow("avoid duplicates");
    expect(mocks.transcribe).toHaveBeenCalledOnce();
  });

  it("propagates API failures and rejects concurrent generation without starting twice", async () => {
    const { world, scene } = fixture();
    const pending = deferred<typeof segments>();
    mocks.transcribe.mockReturnValue(pending.promise);
    const task = generateCaptions(world, scene, undefined, { throwErrors: true });
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledOnce());
    await expect(generateCaptions(world, scene, undefined, { throwErrors: true })).rejects.toMatchObject({ code: "busy" });
    pending.resolve([]);
    await expect(task).rejects.toThrow("No speech detected");
    mocks.transcribe.mockResolvedValue(segments);
    await expect(generateCaptions(world, scene, undefined, { throwErrors: true })).resolves.toMatchObject({ words: 1 });
  });

  it("honors caller cancellation and navigation guards before attaching captions", async () => {
    const { world, scene, library, editor } = fixture();
    const controller = new AbortController();
    mocks.transcribe.mockImplementation(async () => { controller.abort(); return segments; });
    await expect(generateCaptions(world, scene, undefined, { signal: controller.signal, throwErrors: true })).rejects.toMatchObject({ name: "AbortError" });
    expect(library.store).not.toHaveBeenCalled();
    mocks.transcribe.mockResolvedValue(segments);
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error("Project switched"); };
    library.flush.mockImplementation(async () => { current = false; });
    await expect(generateCaptions(world, scene, undefined, { throwErrors: true, assertCurrent })).rejects.toThrow("Project switched");
    expect(editor.editProperty).not.toHaveBeenCalled();
  });

  it("flushes a completed transcript before replacing a scene caption and preserves its style", async () => {
    const { world, scene, library, editor, caption } = fixture();
    await generateCaptions(world, scene);
    expect(library.flush).toHaveBeenCalledOnce();
    expect(library.flush.mock.invocationCallOrder[0]).toBeLessThan(editor.editProperty.mock.invocationCallOrder[0]!);
    expect(editor.editProperty).toHaveBeenCalledExactlyOnceWith(caption, "src", "Captions 1.json");
    expect(editor.insertElement).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("shows the UI a failure rather than stacking a new scene caption over a trimmed caption", async () => {
    const { world, scene, editor, library } = fixture();
    mocks.element.mockReturnValue({ props: { src: "trimmed.json", sourceIn: 10, start: 5 } });
    await generateCaptions(world, scene);
    expect(editor.editProperty).not.toHaveBeenCalled();
    expect(editor.insertElement).not.toHaveBeenCalled();
    expect(library.store).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith("Caption generation failed", expect.objectContaining({ description: expect.stringContaining("avoid duplicates") }));
  });

  it("clamps the final word to the original scene duration instead of extending it with audio padding", async () => {
    const { world, scene, library } = fixture();
    mocks.transcribe.mockResolvedValue([{ text: "Last word.", words: [
      { text: "Last", start: 9, end: 9.5 },
      { text: "word.", start: 9.5, end: 10.0001875 },
    ] }]);
    await generateCaptions(world, scene);
    const saved = JSON.parse(await (library.store.mock.calls[0]![0] as Blob).text());
    expect(saved).toEqual([{ text: "Last word.", words: [
      { text: "Last", start: 9, end: 9.5 },
      { text: "word.", start: 9.5, end: 10 },
    ] }]);
  });

  it("drops words at or beyond the scene end and rebuilds segment text without empty segments", async () => {
    const { world, scene, library } = fixture();
    mocks.transcribe.mockResolvedValue([
      { text: "Keep padding", words: [
        { text: "Keep", start: 9, end: 9.5 },
        { text: "padding", start: 10, end: 10.02 },
      ] },
      { text: "Beyond", words: [{ text: "Beyond", start: 10.01, end: 10.03 }] },
    ]);
    await generateCaptions(world, scene);
    const saved = JSON.parse(await (library.store.mock.calls[0]![0] as Blob).text());
    expect(saved).toEqual([{ text: "Keep", words: [{ text: "Keep", start: 9, end: 9.5 }] }]);
  });

  it("deselects the initial scene before tracking composition edits", async () => {
    const { world, scene, editor } = fixture();
    editor.deselect.mockImplementation(() => {
      for (const [listener] of editor.onEdit.mock.calls) listener({ kind: "prop", name: "selected" });
      mocks.tree.mockReturnValue({ tag: "scene", props: { selected: false }, children: [] });
    });
    await generateCaptions(world, scene);
    expect(editor.deselect.mock.invocationCallOrder[0]).toBeLessThan(editor.onEdit.mock.invocationCallOrder[0]!);
    expect(editor.editProperty).toHaveBeenCalledOnce();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("allows selection, timeline navigation, and scrubbing while transcription runs", async () => {
    const { world, scene, editor } = fixture();
    mocks.transcribe.mockImplementation(async () => {
      const listener = editor.onEdit.mock.calls[0]![0];
      for (const name of ["selected", "active", "camera", "timeline", "playhead", "clipHeight", "expanded"]) {
        listener({ kind: "prop", name });
      }
      mocks.tree.mockReturnValue({ tag: "scene", props: { selected: true, active: true, timeline: [1, 4, 0], playhead: 6 }, children: [] });
      return segments;
    });
    await generateCaptions(world, scene);
    expect(editor.editProperty).toHaveBeenCalledOnce();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("does not save or attach captions after cancellation even if transcription returns late", async () => {
    const { world, scene, library, editor } = fixture();
    const pending = deferred<typeof segments>();
    mocks.transcribe.mockReturnValue(pending.promise);
    const task = generateCaptions(world, scene);
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledOnce());
    mocks.toast.loading.mock.calls.at(-1)![1].action.onClick();
    pending.resolve(segments);
    await task;
    expect(library.store).not.toHaveBeenCalled();
    expect(editor.editProperty).not.toHaveBeenCalled();
    expect(editor.insertElement).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("rejects a stale scene before writing the transcript", async () => {
    const { world, scene, library, editor } = fixture();
    mocks.transcribe.mockImplementation(async () => {
      editor.onEdit.mock.calls[0]![0]({ kind: "prop" });
      return segments;
    });
    await generateCaptions(world, scene);
    expect(library.store).not.toHaveBeenCalled();
    expect(editor.editProperty).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith("Caption generation failed", expect.objectContaining({ description: expect.stringContaining("edited during transcription") }));
  });

  it("does not attach a transcript if the project changes during the asset flush", async () => {
    const { world, scene, library, editor } = fixture();
    library.flush.mockImplementation(async () => { vi.mocked(world.get).mockReturnValue(undefined); });
    await generateCaptions(world, scene);
    expect(library.store).toHaveBeenCalledOnce();
    expect(editor.editProperty).not.toHaveBeenCalled();
    expect(editor.insertElement).not.toHaveBeenCalled();
  });

  it("does not create an asset when no speech is recognized", async () => {
    const { world, scene, library, editor } = fixture();
    mocks.transcribe.mockResolvedValue([]);
    await generateCaptions(world, scene);
    expect(library.store).not.toHaveBeenCalled();
    expect(editor.editProperty).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith("Caption generation failed", expect.objectContaining({ description: expect.stringContaining("No speech detected") }));
  });
});
