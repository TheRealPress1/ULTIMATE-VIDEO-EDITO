import { createHash } from "node:crypto";
import { type ReadStream, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FootageIndexStore, FOOTAGE_TRANSCRIPT_ENGINE } from "./footage-index";
import { withProjectLock } from "./project-write-transactions";
import type { FootageIndexRequest, FootageTranscript } from "./footage-types";

const streamHook = vi.hoisted(() => ({ callback: undefined as ((stream: ReadStream) => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    createReadStream: (...args: Parameters<typeof original.createReadStream>) => {
      const stream = original.createReadStream(...args);
      streamHook.callback?.(stream);
      return stream;
    },
  };
});

const speech: FootageTranscript = [{ text: "The good part", words: [
  { text: "The", start: 1.2, end: 1.5 }, { text: "good", start: 1.5, end: 1.9 }, { text: "part", start: 2, end: 2.4 },
] }];
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("persistent footage transcript index", () => {
  let dir: string;
  let source: string;
  let index: string;
  let store: FootageIndexStore;
  let request: FootageIndexRequest;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "uve-footage-"));
    source = join(dir, "interview.mov");
    index = join(dir, ".cutroom", "footage-index.json");
    await writeFile(source, "original media bytes");
    store = new FootageIndexStore();
    request = { dir, source: "interview.mov", duration: 10 };
  });
  afterEach(async () => {
    streamHook.callback = undefined;
    await rm(dir, { recursive: true, force: true });
  });
  const save = async (store: FootageIndexStore, request: FootageIndexRequest, transcript = speech) => {
    const { fingerprint } = await store.get(request);
    return store.put({ ...request, expectedFingerprint: fingerprint, transcript });
  };

  it("streams the complete source fingerprint, persists timestamps, and reloads after restart", async () => {
    expect(await store.get(request)).toEqual({ fingerprint: digest("original media bytes"), transcript: null, indexedAt: null, engine: FOOTAGE_TRANSCRIPT_ENGINE });
    const saved = await save(store, request);
    expect(saved.transcript).toEqual(speech);
    expect(await new FootageIndexStore().get(request)).toEqual(saved);
    expect(await readFile(source, "utf8")).toBe("original media bytes");
  });

  it("reuses renamed and copied footage by full content rather than path or short asset ID", async () => {
    const saved = await save(store, request);
    const renamed = join(dir, "renamed.mov");
    await rename(source, renamed);
    await copyFile(renamed, source);
    expect(await store.get({ ...request, source: renamed })).toEqual(saved);
    expect(await new FootageIndexStore().get(request)).toEqual(saved);
  });

  it("hashes the final bytes of large sources and avoids rereading unchanged media", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    await writeFile(source, bytes);
    let reads = 0;
    streamHook.callback = () => { reads++; };
    const first = await store.get(request);
    expect(first.fingerprint).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect((await store.get(request)).fingerprint).toBe(first.fingerprint);
    expect(reads).toBe(1);
    bytes[bytes.length - 1] = 8;
    await writeFile(source, bytes);
    const second = await store.get(request);
    expect(second.fingerprint).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(reads).toBe(2);
  });

  it("invalidates only changed content even with preserved file size and modification time", async () => {
    const saved = await save(store, request);
    const originalCopy = join(dir, "untouched.mov");
    await copyFile(source, originalCopy);
    const info = await stat(source);
    await writeFile(source, "replaced media bytes");
    await utimes(source, info.atime, info.mtime);
    expect((await stat(source)).size).toBe(info.size);
    expect(await store.get(request)).toMatchObject({ fingerprint: digest("replaced media bytes"), transcript: null });
    expect(await store.get({ ...request, source: originalCopy })).toEqual(saved);
    await expect(store.put({ ...request, expectedFingerprint: saved.fingerprint, transcript: speech })).rejects.toThrow("changed");
    expect(await store.get({ ...request, source: originalCopy })).toEqual(saved);
  });

  it("merges concurrent writers and store instances without losing another asset's transcript", async () => {
    const otherSource = join(dir, "second.mov");
    await writeFile(otherSource, "different media");
    const second = { ...request, source: otherSource };
    await Promise.all([save(store, request), save(new FootageIndexStore(), second)]);
    expect((await new FootageIndexStore().get(request)).transcript).toEqual(speech);
    expect((await new FootageIndexStore().get(second)).transcript).toEqual(speech);
    expect(Object.keys(JSON.parse(await readFile(index, "utf8")).entries)).toHaveLength(2);
  });

  it("remembers a successful no-speech result", async () => {
    const saved = await save(store, request, []);
    expect(saved.transcript).toEqual([]);
    expect(saved.indexedAt).not.toBeNull();
    expect((await new FootageIndexStore().get(request)).transcript).toEqual([]);
  });

  it("clips small recognition padding to playable source bounds and drops words beyond the end", async () => {
    const padded: FootageTranscript = [{ text: "last word extra", words: [
      { text: "last", start: 9.4, end: 9.7 }, { text: "word", start: 9.7, end: 10.1 }, { text: "extra", start: 10.1, end: 10.2 },
    ] }];
    const saved = await save(store, request, padded);
    expect(saved.transcript).toEqual([{ text: "last word", words: [
      { text: "last", start: 9.4, end: 9.7 }, { text: "word", start: 9.7, end: 10 },
    ] }]);
    expect(await new FootageIndexStore().get(request)).toEqual(saved);
    expect((await save(store, request, [{ text: "extra", words: [{ text: "extra", start: 10.1, end: 10.2 }] }])).transcript).toEqual([]);
  });

  it("preserves corrupt, oversized-schema, and unsupported-version index records", async () => {
    const { fingerprint } = await store.get(request);
    await mkdir(join(dir, ".cutroom"));
    for (const contents of ["{broken", JSON.stringify({ version: 2, entries: {} }), JSON.stringify({ version: 1, entries: { [fingerprint]: {} } })]) {
      await writeFile(index, contents);
      await expect(store.get(request)).rejects.toThrow("has not been changed");
      await expect(store.put({ ...request, expectedFingerprint: fingerprint, transcript: speech })).rejects.toThrow("has not been changed");
      expect(await readFile(index, "utf8")).toBe(contents);
    }
  });

  it("invalidates a parsed index cache when its saved file changes externally", async () => {
    const saved = await save(store, request);
    expect(await store.get(request)).toEqual(saved);
    const content = await readFile(index, "utf8");
    const info = await stat(index);
    const corrupt = "!" + content.slice(1);
    await writeFile(index, corrupt);
    await utimes(index, info.atime, info.mtime);
    await expect(store.get(request)).rejects.toThrow("has not been changed");
    await expect(store.put({ ...request, expectedFingerprint: saved.fingerprint, transcript: [] })).rejects.toThrow("has not been changed");
    expect(await readFile(index, "utf8")).toBe(corrupt);
  });

  it("bounds all incoming timestamps and rejects malformed text without losing saved data", async () => {
    const saved = await save(store, request);
    for (const words of [
      [{ text: "bad", start: -1, end: 2 }], [{ text: "bad", start: 2, end: 2 }],
      [{ text: "bad", start: 2, end: Number.NaN }], [{ text: "bad", start: 2, end: Number.POSITIVE_INFINITY }],
      [{ text: "bad", start: 2, end: 11 }], [{ text: "bad", start: 3, end: 4 }, { text: "order", start: 1, end: 2 }],
      [{ text: "x".repeat(2049), start: 1, end: 2 }], [],
    ]) {
      await expect(store.put({ ...request, expectedFingerprint: saved.fingerprint, transcript: [{ text: "bad", words }] })).rejects.toThrow();
    }
    await expect(store.put({ ...request, expectedFingerprint: "bad", transcript: speech })).rejects.toThrow("fingerprint");
    expect(await store.get(request)).toEqual(saved);
  });

  it("rejects invalid duration, URLs, escaped project paths, and non-file media", async () => {
    for (const seconds of [0, -1, Number.NaN, Infinity, 7201]) {
      await expect(store.get({ ...request, duration: seconds })).rejects.toThrow("two hours");
    }
    for (const path of ["https://example.com/clip.mov", "file:///tmp/clip.mov", "data:audio/wav;base64,xyz", "../outside.mov", ""]) {
      await expect(store.get({ ...request, source: path })).rejects.toThrow();
    }
    await expect(store.get({ ...request, source: dir })).rejects.toThrow("file");
  });

  it("reads linked source media but refuses symlinked metadata directories and index files", async () => {
    const link = join(dir, "linked.mov");
    await symlink(source, link);
    const saved = await save(store, { ...request, source: link });
    expect(saved.transcript).toEqual(speech);
    const external = join(dir, "external");
    await mkdir(external);
    const preserved = await readFile(index, "utf8");
    await rename(index, join(external, "index.json"));
    await symlink(join(external, "index.json"), index);
    await expect(store.get(request)).rejects.toThrow("has not been changed");
    await expect(save(store, request)).rejects.toThrow();
    expect(await readFile(join(external, "index.json"), "utf8")).toBe(preserved);
    await rm(join(dir, ".cutroom"), { recursive: true });
    await symlink(external, join(dir, ".cutroom"));
    await expect(store.get(request)).rejects.toThrow("real project directory");
  });

  it("detects source replacement during an active hash", async () => {
    streamHook.callback = (stream) => stream.once("data", () => writeFileSync(source, "replaced media bytes"));
    await expect(store.get(request)).rejects.toThrow("changed");
    await expect(readFile(index, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels streamed hashing without committing any index", async () => {
    const controller = new AbortController();
    streamHook.callback = (stream) => stream.once("data", () => controller.abort());
    await expect(store.get(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(index, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    streamHook.callback = undefined;
    await expect(store.get(request)).resolves.toMatchObject({ transcript: null });
  });

  it("does not commit a cancelled or changed source while waiting for another project operation", async () => {
    const saved = await save(store, request);
    for (const cancel of [true, false]) {
      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => { acquired = resolve; });
      const lock = withProjectLock(dir, async () => { acquired(); await new Promise<void>((resolve) => { release = resolve; }); });
      await held;
      const controller = new AbortController();
      let hashed!: () => void;
      const hashing = new Promise<void>((resolve) => { hashed = resolve; });
      streamHook.callback = (stream) => stream.once("end", () => hashed());
      const saving = store.put({ ...request, expectedFingerprint: saved.fingerprint, transcript: [] }, controller.signal);
      const outcome = saving.then(() => null, (error: unknown) => error);
      await hashing;
      if (cancel) controller.abort();
      else await writeFile(source, "changed after hashing");
      release();
      await lock;
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(cancel ? /abort/i : /changed/);
      expect(Object.values(JSON.parse(await readFile(index, "utf8")).entries)[0]).toMatchObject({ transcript: speech });
      streamHook.callback = undefined;
    }
  });
});
