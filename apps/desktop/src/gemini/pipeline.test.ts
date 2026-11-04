import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import { GeminiFiles } from "./files";
import { GeminiInteractions } from "./interactions";
import { GeminiMedia } from "./media";

import type { ToolArgs } from "@diffusionstudio/dapi";
import type { MediaStreams } from "../media-download";

// The real client, uploader and orchestrator, talking real HTTP to a local
// stand-in for Google's endpoints: what is sent, in what order, and what is
// cleaned up. Only the media probe and the sound cut are faked.

// Built in two pieces: a literal in this shape would look like a real key to a secret scanner.
const KEY = ["AIza", "SyTestKeyForCutroomUnitTests_0123456"].join("");

type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer };
let dir: string;
let server: Server;
let base: string;
let seen: Seen[];
let polls: number;
let uploadedType: string;
let interaction: (body: Record<string, unknown>) => { status: number; json: unknown };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cutroom-gemini-pipeline-"));
  seen = [];
  polls = 0;
  uploadedType = "video/mp4";
  interaction = () => ({ status: 200, json: { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "[00:04] She laughs." }] }], usage: { total_tokens: 4321 } } });
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const record: Seen = { method: request.method!, path: request.url!, headers: request.headers, body: Buffer.concat(chunks) };
      seen.push(record);
      const reply = (status: number, json: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { "Content-Type": "application/json", ...headers }); response.end(JSON.stringify(json)); };
      const origin = base;
      if (record.method === "POST" && record.path === "/upload/v1beta/files") { uploadedType = String(record.headers["x-goog-upload-header-content-type"] ?? uploadedType); return reply(200, {}, { "x-goog-upload-url": `${origin}/upload-session/1`, "x-goog-upload-status": "active" }); }
      if (record.method === "POST" && record.path === "/upload-session/1") return reply(200, { file: { name: "files/abc", uri: `${origin}/v1beta/files/abc`, state: "PROCESSING", mimeType: uploadedType } });
      if (record.method === "GET" && record.path === "/v1beta/files/abc") return reply(200, { name: "files/abc", uri: `${origin}/v1beta/files/abc`, state: ++polls < 2 ? "PROCESSING" : "ACTIVE", mimeType: uploadedType });
      if (record.method === "POST" && record.path === "/v1beta/interactions") { const answer = interaction(JSON.parse(record.body.toString("utf8")) as Record<string, unknown>); return reply(answer.status, answer.json); }
      if (record.method === "DELETE" && record.path === "/v1beta/files/abc") return reply(200, {});
      reply(404, { error: { message: `no route for ${record.method} ${record.path}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function service(streams: Record<string, MediaStreams>) {
  const key = async () => KEY;
  const cuts: string[] = [];
  const media = new GeminiMedia({
    secret: key,
    model: async () => "gemini-test",
    files: new GeminiFiles({ key, base, sleep: async () => {} }),
    interactions: new GeminiInteractions({ key, base }),
    resolve: async (value) => (isAbsolute(value) ? value : join(dir, value)),
    probe: async (path) => streams[path.slice(dir.length + 1)] ?? (() => { throw new Error("unreadable"); })(),
    cutAudio: async (_input, output) => { cuts.push(output); await writeFile(output, Buffer.alloc(64_000, 3)); },
    waitMs: 5000,
  });
  const run = (args: Partial<ToolArgs<"ask_gemini">>) => media.run(toolByName("ask_gemini").input.parse(args), { project: null, signal: new AbortController().signal });
  return { run, cuts };
}
const clip = (duration: number): MediaStreams => ({ durationSeconds: duration, video: { codec: "h264" }, audio: { codec: "aac" } });
const route = (call: Seen) => `${call.method} ${call.path.split("?")[0]}`;
/** The one call made to a route. */
const only = (name: string): Seen => { const found = seen.filter((call) => route(call) === name); expect(found, name).toHaveLength(1); return found[0]!; };

describe("a video question, over real HTTP", () => {
  it("uploads the exact bytes, waits for the file, asks without storing anything, and deletes the copy", async () => {
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    await writeFile(join(dir, "take.mp4"), bytes);
    const result = await service({ "take.mp4": clip(40) }).run({ path: "take.mp4", question: "How does the take feel?" });

    expect(result).toMatchObject({ state: "done", answer: "[00:04] She laughs.", usage: { totalTokens: 4321 }, sent: { what: "video", bytes: bytes.length, processing: "static", deleted: true } });
    // Google first says PROCESSING and then ACTIVE, so the file is polled twice before the question.
    expect(seen.map(route)).toEqual([
      "POST /upload/v1beta/files", "POST /upload-session/1", "GET /v1beta/files/abc", "GET /v1beta/files/abc", "POST /v1beta/interactions", "DELETE /v1beta/files/abc",
    ]);

    const start = only("POST /upload/v1beta/files");
    const finalize = only("POST /upload-session/1");
    const ask = only("POST /v1beta/interactions");
    const remove = only("DELETE /v1beta/files/abc");
    expect(start.headers).toMatchObject({ "x-goog-api-key": KEY, "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start", "x-goog-upload-header-content-length": String(bytes.length), "x-goog-upload-header-content-type": "video/mp4" });
    expect(JSON.parse(start.body.toString())).toEqual({ file: { display_name: "cutroom-video" } });
    expect(finalize.body.equals(bytes)).toBe(true);
    expect(finalize.headers).toMatchObject({ "content-length": String(bytes.length), "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" });
    expect(finalize.headers["transfer-encoding"]).toBeUndefined();

    const body = JSON.parse(ask.body.toString()) as { model: string; store: boolean; input: Array<Record<string, unknown>> };
    expect(ask.headers["x-goog-api-key"]).toBe(KEY);
    expect(body.model).toBe("gemini-test");
    expect(body.store).toBe(false);
    expect(body.input).toHaveLength(2);
    expect(body.input[0]).toEqual({ type: "video", uri: `${base}/v1beta/files/abc`, mime_type: "video/mp4" });
    expect(body.input[1]).toMatchObject({ type: "text", text: expect.stringMatching(/^How does the take feel\?\n\nHow to answer:/) });
    expect(remove.headers["x-goog-api-key"]).toBe(KEY);

    // The key was only ever in a header.
    for (const call of seen) expect(`${call.path}${call.body.length < 5000 ? call.body.toString() : ""}`, route(call)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("deletes the uploaded copy even when Google refuses the question, and reports why without the key", async () => {
    await writeFile(join(dir, "take.mp4"), Buffer.alloc(2000, 1));
    interaction = () => ({ status: 429, json: { error: { code: "rate_limit_exceeded", message: `Quota used up for ${KEY}` } } });
    const result = await service({ "take.mp4": clip(40) }).run({ path: "take.mp4" });
    expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/rate-limited or out of quota/), sent: { deleted: true } });
    expect(seen.map(route).at(-1)).toBe("DELETE /v1beta/files/abc");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("asks again without agentic viewing when Google refuses it, over the same uploaded file", async () => {
    await writeFile(join(dir, "interview.mp4"), Buffer.alloc(2000, 1));
    const processing: unknown[] = [];
    interaction = (body) => {
      processing.push((body.input as Array<Record<string, unknown>>)[0]!.processing);
      return processing.length === 1
        ? { status: 400, json: { error: { code: "invalid_request", message: "processing agentic is not supported by this model" } } }
        : { status: 200, json: { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }] } };
    };
    const result = await service({ "interview.mp4": clip(1800) }).run({ path: "interview.mp4" });
    expect(processing).toEqual(["agentic", undefined]);
    expect(result).toMatchObject({ state: "done", answer: "ok", sent: { processing: "static" } });
    expect(seen.filter((call) => call.method === "POST" && call.path === "/upload-session/1")).toHaveLength(1);
    expect(seen.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
});

describe("a sound question, over real HTTP", () => {
  it("uploads only the cut sound as audio/wav and shifts the answer's times onto the source's clock", async () => {
    await writeFile(join(dir, "interview.mp4"), Buffer.alloc(2000, 1));
    interaction = () => ({ status: 200, json: { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "Tense at [00:04], relaxed at [01:15-01:30]." }] }] } });
    const { run, cuts } = service({ "interview.mp4": clip(1800) });
    const result = await run({ path: "interview.mp4", send: "audio", start: 600, end: 660, question: "How is her tone?" });

    expect(result).toMatchObject({ state: "done", answer: "Tense at [10:04], relaxed at [11:15-11:30].", sent: { what: "audio", bytes: 64_000, deleted: true } });
    expect(only("POST /upload/v1beta/files").headers["x-goog-upload-header-content-type"]).toBe("audio/wav");
    expect(only("POST /upload-session/1").body.length).toBe(64_000);
    const body = JSON.parse(only("POST /v1beta/interactions").body.toString()) as { input: Array<Record<string, unknown>> };
    expect(body.input[0]).toEqual({ type: "audio", uri: `${base}/v1beta/files/abc`, mime_type: "audio/wav" });
    // The cut copy is gone, and the uploaded one deleted.
    await expect(stat(cuts[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(seen.map(route).at(-1)).toBe("DELETE /v1beta/files/abc");
  });
});

describe("a YouTube link, over real HTTP", () => {
  it("sends only the link: no upload and no delete", async () => {
    const result = await service({}).run({ path: "https://youtu.be/dQw4w9WgXcQ?t=5", question: "What is the hook?" });
    expect(result).toMatchObject({ state: "done", sent: { what: "link" } });
    expect(seen.map(route)).toEqual(["POST /v1beta/interactions"]);
    const body = JSON.parse(seen[0]!.body.toString()) as { input: Array<Record<string, unknown>> };
    expect(body.input[0]).toEqual({ type: "video", uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", processing: "agentic" });
  });
});
