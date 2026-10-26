import { describe, expect, it, vi } from "vitest";
import type { Asset, AssetLibrary, Transcript } from "@diffusionstudio/assets";
import { captionDraft, captionTranscript, saveCaptionDraft } from "./caption-transcript";

const TRANSCRIPT: Transcript = [
  { text: "Hello world.", words: [
    { text: "Hello", start: 0.12345, end: 0.6 },
    { text: "world.", start: 0.6, end: 1.2 },
  ] },
  { text: "Next sentence.", words: [
    { text: "Next", start: 1.4, end: 1.8 },
    { text: "sentence.", start: 1.8, end: 2.4 },
  ] },
];

function storage() {
  const store = vi.fn(async (_blob: Blob, _options: { name: string }) => ({ path: "Captions edited.json" } as Asset));
  const flush = vi.fn(async () => {});
  return { store, flush } satisfies Pick<AssetLibrary, "store" | "flush">;
}

describe("caption transcript editing", () => {
  it("round trips exact second values without changing the source or word order", () => {
    const draft = captionDraft(TRANSCRIPT);
    expect(captionTranscript(draft)).toEqual(TRANSCRIPT);
    draft[0]!.words[0]!.text = " Hey ";
    draft[0]!.words[0]!.start = "0.2";
    const result = captionTranscript(draft);
    expect(result[0]).toEqual({ text: "Hey world.", words: [
      { text: "Hey", start: 0.2, end: 0.6 },
      { text: "world.", start: 0.6, end: 1.2 },
    ] });
    expect(TRANSCRIPT[0]!.words[0]).toEqual({ text: "Hello", start: 0.12345, end: 0.6 });
    expect(result[1]).toEqual(TRANSCRIPT[1]);
  });

  it.each(["", "-1", "NaN", "Infinity", "0.8"])("rejects invalid start %j instead of silently clamping", (start) => {
    const draft = captionDraft(TRANSCRIPT);
    draft[0]!.words[0]!.start = start;
    expect(() => captionTranscript(draft)).toThrow(/Segment 1, word 1/);
  });

  it.each(["", "0.12345", "0.1", "Infinity"])("rejects invalid end %j", (end) => {
    const draft = captionDraft(TRANSCRIPT);
    draft[0]!.words[0]!.end = end;
    expect(() => captionTranscript(draft)).toThrow(/end after the start/);
  });

  it("rejects overlaps both within and between segments", () => {
    const draft = captionDraft(TRANSCRIPT);
    draft[0]!.words[1]!.start = "0.5";
    expect(() => captionTranscript(draft)).toThrow(/Segment 1, word 2.*previous word/);
    draft[0]!.words[1]!.start = "0.6";
    draft[1]!.words[0]!.start = "1.1";
    expect(() => captionTranscript(draft)).toThrow(/Segment 2, word 1.*previous word/);
  });

  it("rebuilds segment text after removals, drops empty segments, and refuses an empty transcript", () => {
    const draft = captionDraft(TRANSCRIPT);
    draft[0]!.words.splice(0, 1);
    draft[1]!.words = [];
    expect(captionTranscript(draft)).toEqual([{ text: "world.", words: [{ text: "world.", start: 0.6, end: 1.2 }] }]);
    draft[0]!.words = [];
    expect(() => captionTranscript(draft)).toThrow("Keep at least one caption word");
  });

  it("requires explicit word removal instead of allowing blank display text", () => {
    const draft = captionDraft(TRANSCRIPT);
    draft[0]!.words[0]!.text = " \n ";
    expect(() => captionTranscript(draft)).toThrow(/enter caption text or remove/);
  });

  it("persists new transcript bytes and flushes before one source edit", async () => {
    const library = storage();
    const sequence: string[] = [];
    library.flush.mockImplementation(async () => { sequence.push("flush"); });
    const commit = vi.fn(() => { sequence.push("commit"); });
    await saveCaptionDraft(captionDraft(TRANSCRIPT), library, { isCurrent: () => true, commit });
    expect(library.store).toHaveBeenCalledOnce();
    const [blob, options] = library.store.mock.calls[0]!;
    expect(JSON.parse(await blob.text())).toEqual(TRANSCRIPT);
    expect(blob.type).toBe("application/json");
    expect(options).toEqual({ name: "Captions edited.json" });
    expect(sequence).toEqual(["flush", "commit"]);
    expect(commit).toHaveBeenCalledExactlyOnceWith("Captions edited.json");
  });

  it("never stores invalid drafts or overwrites a caption whose source changed", async () => {
    const library = storage();
    const commit = vi.fn();
    const draft = captionDraft(TRANSCRIPT);
    await expect(saveCaptionDraft(draft, library, { isCurrent: () => false, commit })).rejects.toThrow(/source changed/);
    expect(library.store).not.toHaveBeenCalled();
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(saveCaptionDraft(draft, library, { isCurrent, commit })).rejects.toThrow(/source changed/);
    expect(library.store).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    draft[0]!.words[0]!.start = "";
    library.store.mockClear();
    await expect(saveCaptionDraft(draft, library, { isCurrent: () => true, commit })).rejects.toThrow(/Segment 1/);
    expect(library.store).not.toHaveBeenCalled();
  });

  it("keeps the original caption source when disk persistence fails", async () => {
    const library = storage();
    const commit = vi.fn();
    library.flush.mockRejectedValue(new Error("Disk full"));
    await expect(saveCaptionDraft(captionDraft(TRANSCRIPT), library, { isCurrent: () => true, commit })).rejects.toThrow("Disk full");
    expect(commit).not.toHaveBeenCalled();
  });
});
