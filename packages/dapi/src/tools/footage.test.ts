import { describe, expect, it } from "vitest";
import { footageCut, footageIndex, footageSearch } from "./footage";

const passage = { assetId: "source", fingerprint: "a".repeat(64), sourceIn: 1, sourceOut: 3 };
describe("footage agent contracts", () => {
  it("allows browsing and complete indexing while bounding list sizes", () => {
    expect(footageSearch.input.parse({})).toEqual({ query: "", limit: 100 });
    expect(footageIndex.input.parse({})).toEqual({});
    expect(footageIndex.input.safeParse({ paths: [] }).success).toBe(false);
    expect(footageSearch.input.safeParse({ limit: 201 }).success).toBe(false);
    expect(footageSearch.input.safeParse({ query: "x".repeat(1001) }).success).toBe(false);
    expect(footageCut.input.safeParse({ passages: Array.from({ length: 101 }, () => passage) }).success).toBe(false);
  });

  it("requires bounded, fingerprinted source intervals instead of accepting arbitrary captions", () => {
    expect(footageCut.input.parse({ passages: [{ ...passage, words: [{ text: "untrusted" }] }] })).toEqual({ passages: [passage] });
    for (const invalid of [
      { ...passage, fingerprint: "short-hash" }, { ...passage, sourceIn: -1 },
      { ...passage, sourceOut: 1 }, { ...passage, sourceOut: Infinity }, { ...passage, sourceOut: 7201 },
    ]) expect(footageCut.input.safeParse({ passages: [invalid] }).success).toBe(false);
    expect(footageCut.input.safeParse({ passages: [] }).success).toBe(false);
    expect(footageCut.input.safeParse({ passages: [{ ...passage, sourceIn: 0, sourceOut: 7200 }] }).success).toBe(true);
  });

  it("reports unavailable sources alongside search results", () => {
    expect(footageSearch.output.parse({ matches: [], total: 0, unavailable: [{ assetId: "source", path: "clip.mov", status: "stale" }] }).unavailable[0].status).toBe("stale");
    expect(footageCut.annotations?.destructiveHint).toBe(false);
    expect(footageSearch.annotations?.readOnlyHint).toBe(true);
    expect(footageIndex.output.parse({ items: [{ assetId: 'source', path: 'interview.mp4', status: 'partial', partial: { completed: 3, total: 18 } }] }).items[0]).toMatchObject({ status: 'partial', partial: { completed: 3, total: 18 } });
  });
});
