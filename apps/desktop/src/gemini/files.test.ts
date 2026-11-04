import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEMINI_API, GeminiError, GeminiFiles, errorDetail, httpError, networkError, putFile, type PutFile } from "./files";

// Built in two pieces: a literal in this shape would look like a real key to a secret scanner.
const KEY = ["AIza", "SyTestKeyForCutroomUnitTests_0123456"].join("");
const FILE = { path: "/tmp/clip.mp4", size: 5_000_000, mimeType: "video/mp4", displayName: "cutroom-clip" };
const SESSION = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const active = { file: { name: "files/abc123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123", state: "ACTIVE", mimeType: "video/mp4" } };

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };
let calls: Call[];

/** A fetch that answers by (method, path) and records every request. */
function fakeFetch(routes: Record<string, (call: Call) => Response | Promise<Response>>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const call: Call = { method: init?.method ?? "GET", url, headers: { ...(init?.headers as Record<string, string>) }, ...(typeof init?.body === "string" ? { body: init.body } : {}) };
    calls.push(call);
    const path = new URL(url).pathname;
    const handler = routes[`${call.method} ${path}`];
    if (!handler) throw new Error(`Unexpected request ${call.method} ${path}`);
    return handler(call);
  }) as typeof fetch;
}

const okPut: PutFile = vi.fn(async ({ onProgress, size }) => { onProgress(size / 2); onProgress(size); return { status: 200, body: JSON.stringify({ file: { ...active.file, state: "PROCESSING" } }) }; });
const start = () => new Response("{}", { status: 200, headers: { "x-goog-upload-url": SESSION } });

function files(routes: Record<string, (call: Call) => Response | Promise<Response>>, extra: Partial<ConstructorParameters<typeof GeminiFiles>[0]> = {}) {
  return new GeminiFiles({ key: async () => KEY, fetch: fakeFetch(routes), put: okPut, sleep: async () => {}, ...extra });
}

beforeEach(() => { calls = []; vi.mocked(okPut).mockClear(); });

describe("uploading a file to Google", () => {
  it("starts a resumable session, streams the file, and waits until it is active", async () => {
    let polls = 0;
    const phases: string[] = [];
    const uploaded = await files({
      "POST /upload/v1beta/files": start,
      "GET /v1beta/files/abc123": () => json(++polls < 3 ? { ...active.file, state: "PROCESSING" } : active.file),
    }).upload(FILE, new AbortController().signal, (phase) => { if (phases.at(-1) !== phase) phases.push(phase); });

    expect(uploaded).toEqual({ name: "files/abc123", uri: active.file.uri, mimeType: "video/mp4" });
    expect(polls).toBe(3);
    expect(phases).toEqual(["uploading", "processing"]);
    const begin = calls[0]!;
    expect(begin.headers).toMatchObject({
      "x-goog-api-key": KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": "5000000",
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
    });
    expect(JSON.parse(begin.body!)).toEqual({ file: { display_name: "cutroom-clip" } });
    expect(okPut).toHaveBeenCalledWith(expect.objectContaining({
      url: SESSION, path: FILE.path, size: FILE.size,
      headers: expect.objectContaining({ "x-goog-api-key": KEY, "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }),
    }));
    // The address Google returned is the one used, and nothing about the key is in it.
    expect(vi.mocked(okPut).mock.calls[0]![0].url).not.toContain(KEY);
    // The key travels in a header, never in an address.
    for (const call of calls) expect(call.url).not.toContain(KEY);
  });

  it("reports how much has been sent as a fraction of the file", async () => {
    const seen: Array<[string, number | null]> = [];
    await files({ "POST /upload/v1beta/files": start, "GET /v1beta/files/abc123": () => json(active.file) })
      .upload(FILE, new AbortController().signal, (phase, fraction) => seen.push([phase, fraction]));
    expect(seen.filter(([phase]) => phase === "uploading").map(([, fraction]) => fraction)).toEqual([0, 0.5, 1]);
  });

  it("uses the answer to the upload itself when the file is already active, with no polling", async () => {
    const put: PutFile = async () => ({ status: 200, body: JSON.stringify(active) });
    const uploaded = await files({ "POST /upload/v1beta/files": start }, { put }).upload(FILE, new AbortController().signal);
    expect(uploaded.uri).toBe(active.file.uri);
    expect(calls).toHaveLength(1);
  });

  it("deletes a file Google could not prepare, and says so", async () => {
    const error = await files({
      "POST /upload/v1beta/files": start,
      "GET /v1beta/files/abc123": () => json({ ...active.file, state: "FAILED", error: { message: "Unsupported codec" } }),
      "DELETE /v1beta/files/abc123": () => json({}),
    }).upload(FILE, new AbortController().signal).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GeminiError);
    expect(error).toMatchObject({ kind: "upload", message: expect.stringContaining("Unsupported codec") });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "DELETE"]);
  });

  it("gives up on a file stuck processing, deleting it", async () => {
    const error = await files({
      "POST /upload/v1beta/files": start,
      "GET /v1beta/files/abc123": () => json({ ...active.file, state: "PROCESSING" }),
      "DELETE /v1beta/files/abc123": () => json({}),
    }, { processingMs: 10_000 }).upload(FILE, new AbortController().signal).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ kind: "upload", message: expect.stringContaining("still preparing") });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("sends the file only where Google serves, and the key only to the API's own host", async () => {
    const via = (address: string) => new Response("{}", { status: 200, headers: { "x-goog-upload-url": address } });
    const attempt = async (address: string) => {
      vi.mocked(okPut).mockClear();
      calls = [];
      return files({ "POST /upload/v1beta/files": () => via(address), "GET /v1beta/files/abc123": () => json(active.file), "DELETE /v1beta/files/abc123": () => json({}) })
        .upload(FILE, new AbortController().signal).catch((thrown: unknown) => thrown);
    };
    for (const address of ["https://evil.example/upload?id=1", "http://generativelanguage.googleapis.com/upload", "https://googleapis.com.evil.example/u", "ftp://generativelanguage.googleapis.com/u", "not an address", "//evil.example/u"]) {
      expect(await attempt(address), address).toMatchObject({ kind: "upload", message: expect.stringMatching(/nothing was sent/) });
      expect(okPut, address).not.toHaveBeenCalled();
    }
    // Another Google host is fine, but it is not given the key.
    await attempt("https://storage.googleapis.com/upload/resumable?upload_id=xyz");
    expect(okPut).toHaveBeenCalledTimes(1);
    expect(vi.mocked(okPut).mock.calls[0]![0].headers).not.toHaveProperty("x-goog-api-key");
    expect(vi.mocked(okPut).mock.calls[0]![0].headers).toMatchObject({ "X-Goog-Upload-Command": "upload, finalize" });
  });

  it("refuses an empty file and a missing key before any request", async () => {
    await expect(files({}).upload({ ...FILE, size: 0 }, new AbortController().signal)).rejects.toMatchObject({ kind: "upload" });
    await expect(files({}, { key: async () => null }).upload(FILE, new AbortController().signal)).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when Google gives no upload address or an unreadable answer", async () => {
    await expect(files({ "POST /upload/v1beta/files": () => new Response("{}", { status: 200 }) }).upload(FILE, new AbortController().signal)).rejects.toMatchObject({ kind: "upload" });
    const garbage: PutFile = async () => ({ status: 200, body: "<html>" });
    await expect(files({ "POST /upload/v1beta/files": start }, { put: garbage }).upload(FILE, new AbortController().signal)).rejects.toMatchObject({ kind: "response" });
    const rejected: PutFile = async () => ({ status: 413, body: JSON.stringify({ error: { message: "File too large" } }) });
    await expect(files({ "POST /upload/v1beta/files": start }, { put: rejected }).upload(FILE, new AbortController().signal)).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("File too large") });
  });

  it("stops when canceled, whether the file is being sent or Google is still preparing it", async () => {
    const sending = new AbortController();
    const slow: PutFile = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const running = files({ "POST /upload/v1beta/files": start }, { put: slow }).upload(FILE, sending.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    sending.abort(new GeminiError("canceled", "The call was canceled."));
    await expect(running).rejects.toMatchObject({ kind: "canceled" });

    const waiting = new AbortController();
    const sleeps: PutFile = async () => ({ status: 200, body: JSON.stringify({ file: { ...active.file, state: "PROCESSING" } }) });
    const stuck = files({
      "POST /upload/v1beta/files": start,
      "DELETE /v1beta/files/abc123": () => json({}),
    }, { put: sleeps, sleep: (_ms, signal) => new Promise((_, reject) => { waiting.abort(new GeminiError("canceled", "The call was canceled.")); reject(signal.reason); }) });
    await expect(stuck.upload(FILE, waiting.signal)).rejects.toMatchObject({ kind: "canceled" });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("deleting an uploaded file", () => {
  it("answers null once it is gone", async () => {
    expect(await files({ "DELETE /v1beta/files/abc123": () => json({}) }).delete("files/abc123")).toBeNull();
    expect(calls[0]).toMatchObject({ method: "DELETE", headers: { "x-goog-api-key": KEY } });
  });

  it("never throws: a failure becomes a sentence naming the 48-hour expiry, without the key", async () => {
    const warning = await files({ "DELETE /v1beta/files/abc123": () => json({ error: { message: `bad ${KEY}` } }, 500) }).delete("files/abc123");
    expect(warning).toContain("48 hours");
    expect(warning).not.toContain(KEY);
    expect(await files({}, { key: async () => null }).delete("files/abc123")).toContain("48 hours");
  });
});

describe("what a failure from Google stands for", () => {
  it("tells a refused key from a quota, a server error and a bad request", () => {
    expect(httpError(401, "nope")).toMatchObject({ kind: "auth" });
    expect(httpError(403, "forbidden")).toMatchObject({ kind: "auth" });
    expect(httpError(400, "API key not valid. Please pass a valid API key.")).toMatchObject({ kind: "auth" });
    expect(httpError(429, "slow down")).toMatchObject({ kind: "quota" });
    expect(httpError(503, "overloaded")).toMatchObject({ kind: "service", message: expect.stringContaining("overloaded") });
    expect(httpError(400, "Video too long")).toMatchObject({ kind: "rejected", status: 400, message: expect.stringContaining("Video too long") });
  });

  it("never lets the key into a message, and keeps the detail short", () => {
    const leaked = httpError(400, `${KEY} ${"x".repeat(2000)}`, KEY);
    expect(leaked.message).not.toContain(KEY);
    expect(leaked.message.length).toBeLessThan(600);
    expect(httpError(400, `unknown key ${["AIza", "SyAnotherKeyForCutroomTests_9876543"].join("")}`).message).not.toContain("SyAnother");
  });

  it("reads the message out of Google's error body, wrapped in an array or not", () => {
    expect(errorDetail(JSON.stringify({ error: { message: "plain" } }))).toBe("plain");
    expect(errorDetail(JSON.stringify([{ error: { message: "wrapped" } }]))).toBe("wrapped");
    expect(errorDetail("not json")).toBe("not json");
  });

  it("maps thrown errors, letting a signal's reason decide", () => {
    const controller = new AbortController();
    controller.abort(new GeminiError("canceled", "The call was canceled."));
    expect(networkError(new Error("x"), KEY, controller.signal)).toMatchObject({ kind: "canceled" });
    expect(networkError(new DOMException("t", "TimeoutError"), KEY, AbortSignal.timeout(0))).toMatchObject({ kind: "timeout" });
    expect(networkError(new DOMException("a", "AbortError"))).toMatchObject({ kind: "canceled" });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(networkError(reset, KEY)).toMatchObject({ kind: "network", message: expect.stringContaining("ECONNRESET") });
    const known = new GeminiError("quota", "q");
    expect(networkError(known)).toBe(known);
  });
});

describe("streaming a file to Google's upload address", () => {
  let dir: string;
  let server: Server;
  let url: string;
  let seen: { headers: IncomingHttpHeaders; bytes: number; closedEarly: boolean } | undefined;
  let respond: "ok" | "slow";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cutroom-gemini-put-"));
    seen = undefined;
    respond = "ok";
    server = createServer((request, response) => {
      let bytes = 0;
      const record = { headers: request.headers, bytes: 0, closedEarly: false };
      seen = record;
      // A slow link: each chunk is taken, then the server waits a moment, so a big upload is still going when it is canceled.
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        record.bytes = bytes;
        if (respond === "slow") { request.pause(); setTimeout(() => request.resume(), 25); }
      });
      request.on("close", () => { if (!request.complete) record.closedEarly = true; });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(active));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("sends exactly the file's bytes with its length and the headers given, and reports progress", async () => {
    const path = join(dir, "clip.bin");
    const bytes = Buffer.alloc(3_000_000, 7);
    await writeFile(path, bytes);
    const progress: number[] = [];
    const answer = await putFile({ url, headers: { "x-goog-api-key": KEY, "X-Goog-Upload-Command": "upload, finalize" }, path, size: bytes.length, signal: new AbortController().signal, onProgress: (sent) => progress.push(sent) });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual(active);
    expect(seen!.bytes).toBe(bytes.length);
    expect(seen!.headers["content-length"]).toBe(String(bytes.length));
    expect(seen!.headers["transfer-encoding"]).toBeUndefined();
    expect(seen!.headers["x-goog-api-key"]).toBe(KEY);
    expect(seen!.headers["x-goog-upload-command"]).toBe("upload, finalize");
    expect(progress.at(-1)).toBe(bytes.length);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("stops sending when the call is canceled", async () => {
    const path = join(dir, "clip.bin");
    const size = 48_000_000;
    await writeFile(path, Buffer.alloc(size, 1));
    respond = "slow";
    const controller = new AbortController();
    const running = putFile({ url, headers: {}, path, size, signal: controller.signal, onProgress: () => {} });
    await vi.waitFor(() => expect(seen?.bytes ?? 0).toBeGreaterThan(0));
    controller.abort(new GeminiError("canceled", "The call was canceled."));
    await expect(running).rejects.toBeDefined();
    await vi.waitFor(() => expect(seen!.closedEarly).toBe(true));
    expect(seen!.bytes).toBeLessThan(size);
  });

  it("fails without a request when it is canceled before it starts, or the file is missing", async () => {
    const controller = new AbortController();
    controller.abort(new GeminiError("canceled", "x"));
    await expect(putFile({ url, headers: {}, path: join(dir, "none"), size: 1, signal: controller.signal, onProgress: () => {} })).rejects.toBeDefined();
    expect(seen).toBeUndefined();
    await expect(putFile({ url, headers: {}, path: join(dir, "none"), size: 1, signal: new AbortController().signal, onProgress: () => {} })).rejects.toBeDefined();
  });
});

describe("the API address", () => {
  it("is Google's", () => {
    expect(GEMINI_API).toBe("https://generativelanguage.googleapis.com");
  });
});
