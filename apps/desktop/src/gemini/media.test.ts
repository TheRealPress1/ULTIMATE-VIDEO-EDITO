import { mkdtemp, rm, stat, truncate, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DapiError, GEMINI_MAX_UPLOAD_BYTES, toolByName } from "@diffusionstudio/dapi";
import { GeminiError, type UploadedFile } from "./files";
import { AGENTIC_AFTER_SECONDS, GeminiMedia, NO_KEY_MESSAGE, type GeminiMediaDeps } from "./media";

import type { ToolArgs } from "@diffusionstudio/dapi";
import type { MediaStreams } from "../media-download";
import type { AskRequest } from "./interactions";

// Built in two pieces: a literal in this shape would look like a real key to a secret scanner.
const KEY = ["AIza", "SyTestKeyForCutroomUnitTests_0123456"].join("");
const YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const clip = (duration: number): MediaStreams => ({ durationSeconds: duration, video: { codec: "h264", width: 1920, height: 1080 }, audio: { codec: "aac" } });

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cutroom-gemini-media-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const file = async (name: string, bytes = 5000) => { const path = join(dir, name); await writeFile(path, Buffer.alloc(bytes, 1)); return path; };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** A service over fakes that record what would have left the Mac. */
function harness(options: { streams?: Record<string, MediaStreams>; key?: string | null; gate?: Promise<void>; waitMs?: number; askFails?: (request: AskRequest, call: number) => Error | undefined; deleteWarning?: string | null; answer?: string; incomplete?: boolean; now?: () => number } = {}) {
  const uploads: Array<{ path: string; size: number; mimeType: string; displayName: string; signal: AbortSignal }> = [];
  const asks: AskRequest[] = [];
  const deletes: string[] = [];
  const cuts: Array<{ input: string; output: string; start: number; duration: number | null }> = [];
  const probes: string[] = [];
  const events: string[] = [];
  const deps: GeminiMediaDeps = {
    secret: async () => (options.key === undefined ? KEY : options.key),
    model: async () => "gemini-test",
    files: {
      upload: async (upload, signal, onProgress) => {
        events.push("upload");
        uploads.push({ ...upload, signal });
        onProgress?.("uploading", 0.5);
        if (options.gate) {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            void options.gate!.then(resolve);
          });
        }
        signal.throwIfAborted();
        const uploaded: UploadedFile = { name: `files/f${uploads.length}`, uri: `https://files.test/f${uploads.length}`, mimeType: upload.mimeType };
        return uploaded;
      },
      delete: async (name) => { events.push("delete"); deletes.push(name); return options.deleteWarning ?? null; },
    },
    interactions: {
      ask: async (request, signal) => {
        events.push("ask");
        asks.push(request);
        signal.throwIfAborted();
        const failure = options.askFails?.(request, asks.length);
        if (failure) throw failure;
        return { text: options.answer ?? "[00:04] She laughs.", totalTokens: 1234, incomplete: options.incomplete ?? false };
      },
    },
    resolve: async (value, project) => {
      if (value.includes("..")) throw new DapiError("invalid-input", "leaves the project");
      return isAbsolute(value) ? value : join(project ?? dir, value);
    },
    probe: async (path) => {
      probes.push(path);
      const found = options.streams?.[path.slice(dir.length + 1)];
      if (!found) throw new Error("ffprobe could not read the file");
      return found;
    },
    cutAudio: async (input, output, window) => {
      events.push("cut");
      cuts.push({ input, output, start: window.start, duration: window.duration });
      await writeFile(output, Buffer.alloc(32_000, 2));
    },
    // A call waits for its job to finish, so a long wait costs nothing; only a job held open on purpose needs a short one.
    waitMs: options.waitMs ?? (options.gate ? 40 : 5000),
    ...(options.now ? { now: options.now } : {}),
  };
  const service = new GeminiMedia(deps);
  const run = (args: Partial<ToolArgs<"ask_gemini">>, signal = new AbortController().signal) =>
    service.run(toolByName("ask_gemini").input.parse(args), { project: null, signal });
  return { service, run, uploads, asks, deletes, cuts, probes, events };
}

/** Every answer must satisfy the published schema. */
const valid = <T>(result: T): T => { toolByName("ask_gemini").output.parse(result); return result; };

describe("without a key, or with a check that fails, nothing is sent", () => {
  it("refuses to start without a saved key, before it even reads the file", async () => {
    const h = harness({ key: null, streams: { "take.mp4": clip(30) } });
    await file("take.mp4");
    await expect(h.run({ path: "take.mp4" })).rejects.toMatchObject({ code: "unsupported", message: NO_KEY_MESSAGE });
    expect(h.probes).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(NO_KEY_MESSAGE).toMatch(/uploaded to Google/);
  });

  it("refuses a link that is not YouTube, and a YouTube link's sound alone", async () => {
    const h = harness();
    await expect(h.run({ path: "https://vimeo.com/123456789" })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("media_download") });
    await expect(h.run({ path: YOUTUBE, send: "audio" })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("send=audio") });
    expect(h.asks).toEqual([]);
  });

  it("refuses what is not a media file: a folder, a document, a file with no streams", async () => {
    const h = harness({ streams: { "empty.mp4": { durationSeconds: 3 } } });
    await mkdir(join(dir, "folder"));
    await file("notes.pdf");
    await file("empty.mp4");
    await expect(h.run({ path: "folder" })).rejects.toMatchObject({ code: "wrong-kind" });
    await expect(h.run({ path: "notes.pdf" })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("isn't a video or audio file") });
    await expect(h.run({ path: "empty.mp4" })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("no picture or sound") });
    await expect(h.run({ path: "missing.mp4" })).rejects.toMatchObject({ code: "not-found" });
    await expect(h.run({ path: "../secret.mp4" })).rejects.toMatchObject({ code: "invalid-input" });
    expect(h.uploads).toEqual([]);
  });

  it("checks the window against the file", async () => {
    const h = harness({ streams: { "take.mp4": clip(100), "long.mp4": clip(9000) } });
    await file("take.mp4");
    await file("long.mp4");
    await expect(h.run({ path: "take.mp4", start: 100 })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("past the end") });
    await expect(h.run({ path: "long.mp4" })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("pass start and end") });
    expect(h.uploads).toEqual([]);
  });

  it("refuses a video Google can't read, pointing at its sound", async () => {
    const h = harness({ streams: { "take.mkv": clip(30) } });
    await file("take.mkv");
    await expect(h.run({ path: "take.mkv" })).rejects.toMatchObject({ message: expect.stringContaining("send=audio") });
    expect(h.uploads).toEqual([]);
  });

  it("refuses a video over Google's per-file limit, without reading it", async () => {
    const h = harness({ streams: { "huge.mp4": clip(600) } });
    const path = await file("huge.mp4", 10);
    await truncate(path, GEMINI_MAX_UPLOAD_BYTES + 1);
    await expect(h.run({ path: "huge.mp4" })).rejects.toMatchObject({ message: expect.stringMatching(/at most .* per file.*send=audio/s) });
    expect(h.uploads).toEqual([]);
  });

  it("refuses sound from a file without any", async () => {
    const h = harness({ streams: { "silent.mp4": { durationSeconds: 5, video: { codec: "h264" } } } });
    await file("silent.mp4");
    await expect(h.run({ path: "silent.mp4", send: "audio" })).rejects.toMatchObject({ message: expect.stringContaining("no sound") });
  });
});

describe("asking about a video file", () => {
  it("uploads the file, asks, deletes the uploaded copy, and reports what left the Mac", async () => {
    const h = harness({ streams: { "take.mp4": clip(40) } });
    const path = await file("take.mp4", 7000);
    const result = valid(await h.run({ path: "take.mp4", question: "How does the take feel?" }));

    expect(h.events).toEqual(["upload", "ask", "delete"]);
    expect(h.uploads[0]).toMatchObject({ path, size: 7000, mimeType: "video/mp4" });
    expect(h.asks[0]).toMatchObject({ model: "gemini-test", media: { type: "video", uri: "https://files.test/f1", mimeType: "video/mp4" } });
    expect((h.asks[0]!.media as { processing?: unknown }).processing).toBeUndefined();
    expect(h.asks[0]!.text.startsWith("How does the take feel?\n\nHow to answer:")).toBe(true);
    expect(h.deletes).toEqual(["files/f1"]);
    expect(result).toMatchObject({
      state: "done", method: "gemini", model: "gemini-test", answer: "[00:04] She laughs.", usage: { totalTokens: 1234 },
      source: { path, kind: "file", duration: 40, start: 0, end: null },
      sent: { what: "video", bytes: 7000, processing: "static", deleted: true },
    });
    expect(result.limitations!.join(" ")).toMatch(/confirm a moment with grab/);
    expect(result.limitations!.join(" ")).toMatch(/about once a second/);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("looks at a long video agentically", async () => {
    const h = harness({ streams: { "interview.mp4": clip(AGENTIC_AFTER_SECONDS + 1), "short.mp4": clip(AGENTIC_AFTER_SECONDS) } });
    await file("interview.mp4");
    await file("short.mp4");
    const long = valid(await h.run({ path: "interview.mp4" }));
    expect((h.asks[0]!.media as { processing?: unknown }).processing).toBe("agentic");
    expect(long.sent).toMatchObject({ what: "video", processing: "agentic" });
    expect(long.limitations!.join(" ")).toMatch(/chose where to look/);
    await h.run({ path: "short.mp4" });
    expect((h.asks[1]!.media as { processing?: unknown }).processing).toBeUndefined();
  });

  it("asks again, sampled, when Google won't look agentically, and says so", async () => {
    const h = harness({
      streams: { "interview.mp4": clip(2000) },
      askFails: (_request, call) => (call === 1 ? new GeminiError("rejected", "Google refused the request. (400: processing agentic is not supported)") : undefined),
    });
    await file("interview.mp4");
    const result = valid(await h.run({ path: "interview.mp4" }));
    expect(h.asks).toHaveLength(2);
    expect((h.asks[0]!.media as { processing?: unknown }).processing).toBe("agentic");
    expect((h.asks[1]!.media as { processing?: unknown }).processing).toBeUndefined();
    expect(result).toMatchObject({ state: "done", sent: { processing: "static" } });
    expect(result.warnings!.join(" ")).toMatch(/didn't accept agentic/);
    expect(h.deletes).toEqual(["files/f1"]);
  });

  it("treats the 401 Google can return to a long synchronous agentic request as that, asking again sampled, and reports a truly bad key as one", async () => {
    const lateAuth = harness({
      streams: { "interview.mp4": clip(2000) },
      askFails: (_request, call) => (call === 1 ? new GeminiError("auth", "Google refused the key. Check it in Settings.", 401) : undefined),
    });
    await file("interview.mp4");
    const recovered = valid(await lateAuth.run({ path: "interview.mp4" }));
    expect(lateAuth.asks).toHaveLength(2);
    expect(recovered).toMatchObject({ state: "done", sent: { processing: "static" } });
    expect(recovered.warnings!.join(" ")).toMatch(/didn't accept agentic/);

    const badKey = harness({ streams: { "interview.mp4": clip(2000) }, askFails: () => new GeminiError("auth", "Google refused the key. Check it in Settings.", 401) });
    const failed = valid(await badKey.run({ path: "interview.mp4" }));
    expect(badKey.asks).toHaveLength(2);
    expect(failed).toMatchObject({ state: "failed", error: "Google refused the key. Check it in Settings." });
    expect(badKey.deletes).toEqual(["files/f1"]);

    // A sampled request is never retried: its failure is what it says.
    const short = harness({ streams: { "take.mp4": clip(30) }, askFails: () => new GeminiError("auth", "Google refused the key. Check it in Settings.", 401) });
    await file("take.mp4");
    await short.run({ path: "take.mp4" });
    expect(short.asks).toHaveLength(1);
  });

  it("names a window to Google and tells the model which part it is, uploading the whole file", async () => {
    const h = harness({ streams: { "take.mp4": clip(600) }, answer: "[02:10] The speaker leans in." });
    await file("take.mp4", 9000);
    const result = valid(await h.run({ path: "take.mp4", start: 125, end: 190 }));
    expect(h.uploads[0]!.size).toBe(9000);
    expect(h.asks[0]!.media).toMatchObject({ processing: { type: "static", startOffset: 125, endOffset: 190 } });
    expect(h.asks[0]!.text).toContain("from 02:05 to 03:10");
    // The model keeps the recording's clock for a video window, so its times are passed through as written.
    expect(result.answer).toBe("[02:10] The speaker leans in.");
    expect(result).toMatchObject({ source: { start: 125, end: 190 }, sent: { what: "video", bytes: 9000, processing: "static" } });
  });

  it("clamps an end past the file's end, and warns", async () => {
    const h = harness({ streams: { "take.mp4": clip(100) } });
    await file("take.mp4");
    const result = await h.run({ path: "take.mp4", start: 10, end: 500 });
    expect(result.source!.end).toBe(100);
    expect(result.warnings!.join(" ")).toMatch(/stops at 1 min/);
  });

  it("goes ahead, unchecked, when a media file's length can't be read, and says so", async () => {
    const h = harness({ streams: {} });
    await file("odd.mov");
    const result = valid(await h.run({ path: "odd.mov" }));
    expect(h.uploads[0]).toMatchObject({ mimeType: "video/mov" });
    expect(result.warnings!.join(" ")).toMatch(/length couldn't be read/);
  });

  it("still deletes the uploaded copy when asking fails, and reports the failure without the key", async () => {
    const h = harness({ streams: { "take.mp4": clip(30) }, askFails: () => new GeminiError("auth", "Google refused the key. Check it in Settings.") });
    await file("take.mp4");
    const result = valid(await h.run({ path: "take.mp4" }));
    expect(result).toMatchObject({ state: "failed", error: "Google refused the key. Check it in Settings.", sent: { what: "video", deleted: true } });
    expect(result.answer).toBeUndefined();
    expect(h.deletes).toEqual(["files/f1"]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("says when Google could not be asked to delete the copy, and when the answer was cut short", async () => {
    const h = harness({ streams: { "take.mp4": clip(30) }, deleteWarning: "Google could not be asked to delete the uploaded copy (x). It expires on its own within 48 hours.", incomplete: true });
    await file("take.mp4");
    const result = valid(await h.run({ path: "take.mp4" }));
    expect(result.sent!.deleted).toBe(false);
    expect(result.warnings!.join(" ")).toMatch(/48 hours/);
    expect(result.warnings!.join(" ")).toMatch(/cut short/);
  });
});

describe("asking about the sound", () => {
  it("cuts the window out, uploads only that, and puts the answer's times on the source's clock", async () => {
    const h = harness({ streams: { "interview.mov": clip(1800) }, answer: "She sounds tense at [00:04] and relaxed by [01:15-01:30]. The clock reads 10:45." });
    const path = await file("interview.mov", 50_000);
    const result = valid(await h.run({ path: "interview.mov", send: "audio", start: 600, end: 660, question: "How is her tone?" }));

    expect(h.cuts).toEqual([{ input: path, output: expect.stringMatching(/sound\.wav$/), start: 600, duration: 60 }]);
    expect(h.uploads[0]).toMatchObject({ mimeType: "audio/wav", size: 32_000 });
    expect(h.asks[0]!.media).toEqual({ type: "audio", uri: "https://files.test/f1", mimeType: "audio/wav" });
    expect(h.asks[0]!.text).toContain("Count times from the start of the media.");
    expect(result.answer).toBe("She sounds tense at [10:04] and relaxed by [11:15-11:30]. The clock reads 10:45.");
    expect(result).toMatchObject({ state: "done", sent: { what: "audio", bytes: 32_000, deleted: true }, source: { start: 600, end: 660 } });
    expect(result.sent!.processing).toBeUndefined();
    expect(result.limitations!.join(" ")).toMatch(/Only the sound was sent/);
    // The cut copy is gone once the call is over.
    await expect(stat(h.cuts[0]!.output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.deletes).toEqual(["files/f1"]);
  });

  it("sends a whole audio file by default, with no times to shift", async () => {
    const h = harness({ streams: { "voice.wav": { durationSeconds: 90, audio: { codec: "pcm_s16le" } } }, answer: "[00:10] A pause." });
    await file("voice.wav");
    const result = valid(await h.run({ path: "voice.wav" }));
    expect(h.cuts[0]).toMatchObject({ start: 0, duration: null });
    expect(result).toMatchObject({ answer: "[00:10] A pause.", sent: { what: "audio" } });
  });

  it("sends only the sound of a file that has no picture even when video was asked for", async () => {
    const h = harness({ streams: { "voice.wav": { durationSeconds: 90, audio: { codec: "pcm_s16le" } } } });
    await file("voice.wav");
    const result = valid(await h.run({ path: "voice.wav", send: "video" }));
    expect(result.sent!.what).toBe("audio");
    expect(result.warnings!.join(" ")).toMatch(/no picture/);
  });

  it("deletes everything even when the question fails", async () => {
    const h = harness({ streams: { "take.mp4": clip(30) }, askFails: () => new GeminiError("quota", "Google says this key is rate-limited.") });
    await file("take.mp4");
    const result = valid(await h.run({ path: "take.mp4", send: "audio" }));
    expect(result.state).toBe("failed");
    expect(h.deletes).toEqual(["files/f1"]);
    await expect(stat(h.cuts[0]!.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("asking about a YouTube link", () => {
  it("sends only the link, normalized, and uploads nothing", async () => {
    const h = harness();
    const result = valid(await h.run({ path: "https://youtu.be/dQw4w9WgXcQ?t=30", question: "What is the hook?" }));
    expect(h.probes).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(h.deletes).toEqual([]);
    expect(h.asks[0]!.media).toEqual({ type: "video", uri: YOUTUBE, processing: "agentic" });
    expect(result).toMatchObject({ state: "done", source: { path: YOUTUBE, kind: "youtube", start: 0, end: null }, sent: { what: "link", processing: "agentic" } });
    expect(result.sent!.bytes).toBeUndefined();
    expect(result.sent!.deleted).toBeUndefined();
  });

  it("names a window for a link too", async () => {
    const h = harness();
    await h.run({ path: YOUTUBE, start: 30, end: 90 });
    expect(h.asks[0]!.media).toEqual({ type: "video", uri: YOUTUBE, processing: { type: "static", startOffset: 30, endOffset: 90 } });
    expect(h.asks[0]!.text).toContain("from 00:30 to 01:30");
  });
});

describe("jobs", () => {
  it("answers running with a job id while the upload is slow, then done when followed", async () => {
    const gate = deferred();
    const h = harness({ streams: { "take.mp4": clip(40) }, gate: gate.promise });
    await file("take.mp4");
    const started = valid(await h.run({ path: "take.mp4" }));
    expect(started).toMatchObject({ state: "running", jobId: expect.stringMatching(/^gemini-/), progress: { phase: "uploading", fraction: 0.5 } });
    expect(started.answer).toBeUndefined();
    const waiting = valid(await h.run({ action: "status", jobId: started.jobId }));
    expect(waiting.state).toBe("running");
    gate.release();
    const finished = valid(await h.run({ action: "status", jobId: started.jobId }));
    expect(finished).toMatchObject({ state: "done", answer: "[00:04] She laughs." });
    expect(finished.progress).toBeUndefined();
    // A finished job stays answerable.
    expect((await h.run({ action: "status", jobId: started.jobId })).state).toBe("done");
  });

  it("joins a repeated question instead of uploading twice", async () => {
    const gate = deferred();
    const h = harness({ streams: { "take.mp4": clip(40) }, gate: gate.promise });
    await file("take.mp4");
    const first = await h.run({ path: "take.mp4", question: "same" });
    const again = await h.run({ path: "take.mp4", question: " same " });
    expect(again.jobId).toBe(first.jobId);
    gate.release();
    await h.run({ action: "status", jobId: first.jobId });
    expect(h.uploads).toHaveLength(1);
    const other = await h.run({ path: "take.mp4", question: "different" });
    expect(other.jobId).not.toBe(first.jobId);
  });

  it("runs one at a time: the second waits queued until the first has finished", async () => {
    const gate = deferred();
    const h = harness({ streams: { "a.mp4": clip(40), "b.mp4": clip(40) }, gate: gate.promise });
    await file("a.mp4");
    await file("b.mp4");
    const first = await h.run({ path: "a.mp4" });
    const second = valid(await h.run({ path: "b.mp4" }));
    expect(first.state).toBe("running");
    expect(second.state).toBe("queued");
    expect(second.progress).toBeUndefined();
    expect(h.uploads).toHaveLength(1);
    gate.release();
    expect((await h.run({ action: "status", jobId: first.jobId })).state).toBe("done");
    expect((await h.run({ action: "status", jobId: second.jobId })).state).toBe("done");
    expect(h.uploads.map((upload) => upload.path.slice(-5))).toEqual(["a.mp4", "b.mp4"]);
  });

  it("cancels a running upload, stopping it and deleting what was cut", async () => {
    const gate = deferred();
    const h = harness({ streams: { "take.mp4": clip(40) }, gate: gate.promise });
    await file("take.mp4");
    const started = await h.run({ path: "take.mp4", send: "audio" });
    expect(started.state).toBe("running");
    const canceled = valid(await h.run({ action: "cancel", jobId: started.jobId }));
    expect(canceled).toMatchObject({ state: "canceled", error: expect.stringContaining("canceled") });
    expect(h.uploads[0]!.signal.aborted).toBe(true);
    expect(h.asks).toEqual([]);
    await expect(stat(h.cuts[0]!.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels a job still waiting its turn, at once", async () => {
    const gate = deferred();
    const h = harness({ streams: { "a.mp4": clip(40), "b.mp4": clip(40) }, gate: gate.promise });
    await file("a.mp4");
    await file("b.mp4");
    const first = await h.run({ path: "a.mp4" });
    const queued = await h.run({ path: "b.mp4" });
    expect((await h.run({ action: "cancel", jobId: queued.jobId })).state).toBe("canceled");
    gate.release();
    expect((await h.run({ action: "status", jobId: first.jobId })).state).toBe("done");
    expect(h.uploads).toHaveLength(1);
  });

  it("deletes an uploaded file when the question is canceled after the upload", async () => {
    const release = deferred();
    const h = harness({ streams: { "take.mp4": clip(40) }, waitMs: 40 });
    await file("take.mp4");
    const original = h.service["deps" as keyof typeof h.service] as unknown as GeminiMediaDeps;
    original.interactions.ask = async (_request, signal) => { await new Promise<void>((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); release.release(); }); return { text: "never", incomplete: false }; };
    const started = await h.run({ path: "take.mp4" });
    await release.promise;
    const canceled = await h.run({ action: "cancel", jobId: started.jobId });
    expect(canceled.state).toBe("canceled");
    expect(h.deletes).toEqual(["files/f1"]);
    expect(canceled.sent).toMatchObject({ deleted: true });
  });

  it("knows no job it didn't start, and stops answering for one that is an hour old", async () => {
    let clock = 1_000_000;
    const h = harness({ streams: { "take.mp4": clip(40) }, now: () => clock });
    await file("take.mp4");
    await expect(h.run({ action: "status", jobId: "gemini-404" })).rejects.toMatchObject({ code: "not-found" });
    const done = await h.run({ path: "take.mp4" });
    expect((await h.run({ action: "status", jobId: done.jobId })).state).toBe("done");
    clock += 61 * 60_000;
    await expect(h.run({ action: "status", jobId: done.jobId })).rejects.toMatchObject({ code: "not-found" });
  });

  it("stops every unfinished job at once", async () => {
    const gate = deferred();
    const h = harness({ streams: { "take.mp4": clip(40) }, gate: gate.promise });
    await file("take.mp4");
    const started = await h.run({ path: "take.mp4" });
    h.service.cancelAll();
    expect((await h.run({ action: "status", jobId: started.jobId })).state).toBe("canceled");
  });

  it("returns when the caller goes away, leaving the job to run", async () => {
    const gate = deferred();
    const h = harness({ streams: { "take.mp4": clip(40) }, gate: gate.promise });
    await file("take.mp4");
    const caller = new AbortController();
    const pending = h.run({ path: "take.mp4" }, caller.signal);
    caller.abort();
    const result = await pending;
    expect(result.state).toBe("running");
    gate.release();
    expect((await h.run({ action: "status", jobId: result.jobId })).state).toBe("done");
  });
});
