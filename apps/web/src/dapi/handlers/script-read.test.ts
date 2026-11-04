/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), transcribe: vi.fn(), library: vi.fn(), service: vi.fn(), footage: vi.fn() }));
vi.mock("../lib/assets", () => ({ resolveAsset: mocks.resolve, requireAssetType: vi.fn() }));
vi.mock("@/lib/source-transcription", () => ({ transcribeSource: mocks.transcribe }));
vi.mock("@/lib/footage-cache", () => ({ requestFootage: mocks.footage }));
vi.mock("@diffusionstudio/runtime", () => ({ getLibrary: mocks.library }));
vi.mock("@/engine/footage", () => ({ getFootageService: mocks.service }));

import { projectScriptPath, scriptReadCompare } from "./script-read";
import type { ToolContext } from "../handler";
import type { ToolArgs } from "@diffusionstudio/dapi";

const BRIEF = `<!-- cutroom:brief v1 -->
## Goal
- format: talking head

## Script
1. [opener · curious] Most people buy a new camera when their videos look flat.
2. [turn · calm] The camera isn't the problem.
3. [close · warm] Put one lamp beside the window tonight.
`;

/** Synthetic words: 0.3 s each, 0.08 s apart; numbers are silences. */
function segments(parts: Array<string | number>) {
  const words: Array<{ text: string; start: number; end: number }> = [];
  let at = 0;
  for (const part of parts) {
    if (typeof part === "number") { at += part; continue; }
    for (const text of part.split(" ")) { words.push({ text, start: Math.round(at * 1000) / 1000, end: Math.round((at + 0.3) * 1000) / 1000 }); at += 0.38; }
  }
  return [{ text: words.map((word) => word.text).join(" "), words }];
}
const READ = segments(["Most people buy a new camera when their videos look flat.", 1, "The camera is not a problem.", 1, "The camera isn't the problem."]);
const FINGERPRINT = "a".repeat(64);

const args = (overrides: Partial<ToolArgs<"script_read_compare">> = {}): ToolArgs<"script_read_compare"> => ({ path: "takes/read.mp4", pauseSeconds: 0.6, minCoverage: 0.5, detail: "full", ...overrides });

function project(files: Record<string, string> = { "brief.md": BRIEF }, options: { real?: (path: string) => string | null; imported?: boolean } = {}) {
  const write = vi.fn().mockResolvedValue(undefined);
  const fs = {
    stat: vi.fn(async (path: string) => (path in files ? { size: files[path]!.length, mtime: 1 } : null)),
    realPath: vi.fn(async (path: string) => (options.real ? options.real(path) : path === "" ? "/projects/lamp" : `/projects/lamp/${path}`)),
    file: vi.fn(async (path: string) => new Blob([files[path] ?? ""])),
    write,
    absolute: (path: string) => `/projects/lamp/${path}`,
  };
  mocks.library.mockReturnValue({ list: () => (options.imported === false ? [] : [{ id: "asset-1" }]), fs });
  const session = { world: {}, project: { dir: () => "/projects/lamp" } };
  const ctx = { signal: new AbortController().signal, session: () => session } as unknown as ToolContext;
  return { ctx, fs, write };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ id: "asset-1", type: "VIDEO", path: "takes/read.mp4", source: "takes/read.mp4", duration: 30 });
  mocks.footage.mockResolvedValue({ fingerprint: FINGERPRINT, transcript: READ, indexedAt: "2026-11-03T10:00:00.000Z", engine: "whisper-base" });
  mocks.transcribe.mockResolvedValue(READ);
});

describe("script_read_compare", () => {
  it("compares the project's brief.md with the footage index and saves the result", async () => {
    const { ctx, write } = project();
    const result = await scriptReadCompare(args(), ctx);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(result.source).toEqual({ path: "takes/read.mp4", assetId: "asset-1", fingerprint: FINGERPRINT, start: 0, end: 30, transcript: "footage-index" });
    expect(result.script).toEqual({ kind: "file", path: "brief.md", format: "brief", lines: 3 });
    expect(result.lines[1]).toMatchObject({ n: 2, takeCount: 2, best: 1 });
    expect(result.lines[1]!.takes[0]!.substituted).toEqual([{ written: "the", spoken: "a" }]);
    expect(result.unspoken).toEqual([3]);
    expect(result.passages.map((passage) => passage.lines)).toEqual([[1], [2]]);
    expect(result.passages[1]).toMatchObject({ assetId: "asset-1", fingerprint: FINGERPRINT, sourceIn: result.lines[1]!.takes[1]!.keep.sourceIn });
    expect(result.savedPath).toBe("/projects/lamp/.cutroom/script-read.json");
    expect(write).toHaveBeenCalledWith(".cutroom/script-read.json", expect.any(Blob));
    const saved = JSON.parse(await (write.mock.calls[0]![1] as Blob).text());
    expect(saved).toMatchObject({ version: 1, unspoken: [3], savedPath: "/projects/lamp/.cutroom/script-read.json" });
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it("transcribes a window of a recording that has no index entry, without indexing it", async () => {
    const { ctx } = project();
    mocks.footage.mockResolvedValue({ fingerprint: FINGERPRINT, transcript: null, indexedAt: null, engine: "whisper-base" });
    const indexPaths = vi.fn();
    mocks.service.mockReturnValue({ indexPaths, snapshot: () => ({ indexing: false, items: [] }) });
    const result = await scriptReadCompare(args({ start: 5, end: 20 }), ctx);
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-1" }), expect.objectContaining({ window: { start: 5, end: 20 } }));
    expect(indexPaths).not.toHaveBeenCalled();
    expect(result.source).toMatchObject({ transcript: "transcribed", fingerprint: null, start: 5, end: 20 });
    expect(result.passages).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("footage_index")]));
    // Words outside the window are not compared.
    expect(result.lines[0]!.takes).toEqual([]);
  });

  it("indexes a whole imported recording that has no index entry, so passages work with footage_cut", async () => {
    const { ctx } = project();
    mocks.footage.mockResolvedValue({ fingerprint: FINGERPRINT, transcript: null, indexedAt: null, engine: "whisper-base" });
    const indexPaths = vi.fn().mockResolvedValue(undefined);
    mocks.service.mockReturnValue({ indexPaths, snapshot: () => ({ indexing: false, items: [{ assetId: "asset-1", status: "ready", fingerprint: FINGERPRINT, segments: READ }] }) });
    const result = await scriptReadCompare(args(), ctx);
    expect(indexPaths).toHaveBeenCalledWith(["asset-1"], ctx.signal);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(result.source.transcript).toBe("footage-index");
    expect(result.passages).toHaveLength(2);
  });

  it("reports busy instead of transcribing while an indexing run holds the speech engine", async () => {
    const { ctx } = project();
    mocks.footage.mockResolvedValue({ fingerprint: FINGERPRINT, transcript: null, indexedAt: null, engine: "whisper-base" });
    const indexPaths = vi.fn();
    mocks.service.mockReturnValue({ indexPaths, snapshot: () => ({ indexing: true, items: [] }) });
    await expect(scriptReadCompare(args(), ctx)).rejects.toMatchObject({ code: "busy", message: expect.stringContaining("one recording at a time") });
    await expect(scriptReadCompare(args({ start: 5, end: 20 }), ctx)).rejects.toMatchObject({ code: "busy" });
    // A file outside the library would be transcribed by the same engine.
    const outside = project(undefined, { imported: false });
    await expect(scriptReadCompare(args(), outside.ctx)).rejects.toMatchObject({ code: "busy" });
    expect(indexPaths).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    // An indexed recording needs no transcription, so a busy index does not matter.
    mocks.footage.mockResolvedValue({ fingerprint: FINGERPRINT, transcript: READ, indexedAt: "2026-11-03T10:00:00.000Z", engine: "whisper-base" });
    await expect(scriptReadCompare(args(), project().ctx)).resolves.toMatchObject({ source: { transcript: "footage-index" } });
  });

  it("takes an inline script without a project and does not save", async () => {
    mocks.resolve.mockResolvedValue({ id: "transient", type: "AUDIO", path: "/Users/me/Movies/read.wav", source: "/Users/me/Movies/read.wav", duration: 30 });
    const ctx = { signal: new AbortController().signal, session: () => null } as unknown as ToolContext;
    const result = await scriptReadCompare(args({ path: "/Users/me/Movies/read.wav", script: { text: "Most people buy a new camera when their videos look flat.\nThe camera isn't the problem." } }), ctx);
    expect(mocks.footage).not.toHaveBeenCalled();
    expect(result.script).toEqual({ kind: "text", format: "script", lines: 2 });
    expect(result.source).toMatchObject({ assetId: null, transcript: "transcribed" });
    expect(result.unspoken).toEqual([]);
    expect(result.savedPath).toBeNull();
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("not imported")]));
  });

  it("lists only each line's suggested take when detail is best", async () => {
    const { ctx, write } = project();
    const result = await scriptReadCompare(args({ detail: "best" }), ctx);
    expect(result.lines[1]).toMatchObject({ takeCount: 2, best: 0 });
    expect(result.lines[1]!.takes).toHaveLength(1);
    expect(result.lines[1]!.takes[0]!.coverage).toBe(1);
    expect(result.lines[2]).toMatchObject({ takeCount: 0, best: null, takes: [] });
    const saved = JSON.parse(await (write.mock.calls[0]![1] as Blob).text());
    expect(saved.lines[1].takes).toHaveLength(2);
  });

  it("fails before transcribing when the brief is missing or has no script", async () => {
    const missing = project({});
    await expect(scriptReadCompare(args(), missing.ctx)).rejects.toMatchObject({ code: "not-found", message: expect.stringContaining("no brief.md") });
    const empty = project({ "brief.md": "## Goal\n- format: talking head\n" });
    await expect(scriptReadCompare(args(), empty.ctx)).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining('"## Script"') });
    const noProject = { signal: new AbortController().signal, session: () => null } as unknown as ToolContext;
    await expect(scriptReadCompare(args(), noProject)).rejects.toMatchObject({ code: "no-project" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("reads other project markdown files but nothing outside the project", async () => {
    const drafts = project({ "drafts/v2.md": "1. The camera isn't the problem." });
    await expect(scriptReadCompare(args({ script: { path: "drafts/v2.md" } }), drafts.ctx)).resolves.toMatchObject({ script: { kind: "file", path: "drafts/v2.md", format: "script", lines: 1 } });
    const linked = project(undefined, { real: (path) => (path === "" ? "/projects/lamp" : "/Users/me/secret/brief.md") });
    await expect(scriptReadCompare(args(), linked.ctx)).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("outside") });
    for (const given of ["../brief.md", "/etc/brief.md", "C:/brief.md", "drafts\\brief.md", "~/brief.md", "notes.pdf", "./"]) {
      expect(() => projectScriptPath(given), given).toThrow(expect.objectContaining({ code: "invalid-input" }));
    }
    expect(projectScriptPath("./drafts//brief.md")).toBe("drafts/brief.md");
  });

  it("rejects remote media, bad windows, recordings over two hours and silent recordings", async () => {
    const { ctx } = project();
    await expect(scriptReadCompare(args({ path: "https://example.com/read.mp4" }), ctx)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(scriptReadCompare(args({ start: 40 }), ctx)).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("30.00 s") });
    // Transcription and the index refuse the whole file, so a short window of it is refused up front too.
    mocks.resolve.mockResolvedValueOnce({ id: "asset-1", type: "VIDEO", path: "takes/long.mp4", source: "takes/long.mp4", duration: 3 * 3600 });
    await expect(scriptReadCompare(args({ start: 60, end: 600 }), ctx)).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("Split the recording") });
    expect(mocks.footage).not.toHaveBeenCalled();
    mocks.footage.mockResolvedValue({ fingerprint: FINGERPRINT, transcript: [], indexedAt: "2026-11-03T10:00:00.000Z", engine: "whisper-base" });
    await expect(scriptReadCompare(args(), ctx)).rejects.toThrow("No speech detected");
  });

  it("reports a save failure as a warning instead of failing the comparison", async () => {
    const { ctx, write } = project();
    write.mockRejectedValue(new Error("disk full"));
    const result = await scriptReadCompare(args(), ctx);
    expect(result.savedPath).toBeNull();
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("disk full")]));
  });

  it("stops when the project changes while transcribing", async () => {
    let session: unknown = { world: {}, project: { dir: () => "/projects/lamp" } };
    project();
    const ctx = { signal: new AbortController().signal, session: () => session } as unknown as ToolContext;
    mocks.footage.mockImplementationOnce(async () => { session = { world: {}, project: { dir: () => "/projects/other" } }; return { fingerprint: FINGERPRINT, transcript: READ }; });
    await expect(scriptReadCompare(args(), ctx)).rejects.toMatchObject({ code: "no-project" });
  });
});
