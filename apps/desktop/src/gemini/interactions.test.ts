import { describe, expect, it, vi } from "vitest";
import { GeminiError } from "./files";
import { GeminiInteractions, answerText, offsetString, requestBody, type AskRequest } from "./interactions";

// Built in two pieces: a literal in this shape would look like a real key to a secret scanner.
const KEY = ["AIza", "SyTestKeyForCutroomUnitTests_0123456"].join("");
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const done = (text = "[00:04] She laughs.", extra: Record<string, unknown> = {}) => ({
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  usage: { total_input_tokens: 6000, total_output_tokens: 40, total_tokens: 6040 },
  ...extra,
});
const video: AskRequest = { model: "gemini-test", media: { type: "video", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", mimeType: "video/mp4" }, text: "What happens?" };

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
function gemini(respond: (sent: Sent) => Response | Promise<Response> = () => reply(done()), options: { timeoutMs?: number; key?: string | null } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const record: Sent = { url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) };
    sent.push(record);
    return respond(record);
  }) as unknown as typeof fetch;
  const key = options.key === undefined ? KEY : options.key;
  return { client: new GeminiInteractions({ key: async () => key, fetch: fetchImpl, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }), sent };
}

describe("the request", () => {
  it("asks about an uploaded video with the question after it, and keeps no copy at Google", () => {
    expect(requestBody(video)).toEqual({
      model: "gemini-test",
      store: false,
      input: [{ type: "video", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", mime_type: "video/mp4" }, { type: "text", text: "What happens?" }],
    });
  });

  it("names how a video is looked at: agentic, or a static window in seconds", () => {
    const agentic = requestBody({ ...video, media: { ...video.media, processing: "agentic" } as AskRequest["media"] });
    expect((agentic.input as Array<Record<string, unknown>>)[0]).toMatchObject({ processing: "agentic" });
    const clipped = requestBody({ ...video, media: { ...video.media, processing: { type: "static", startOffset: 120, endOffset: 150.5 } } as AskRequest["media"] });
    expect((clipped.input as Array<Record<string, unknown>>)[0]).toMatchObject({ processing: { type: "static", start_offset: "120s", end_offset: "150.5s" } });
    const open = requestBody({ ...video, media: { ...video.media, processing: { type: "static", startOffset: 30 } } as AskRequest["media"] });
    expect(((open.input as Array<Record<string, unknown>>)[0]!.processing as Record<string, unknown>)).toEqual({ type: "static", start_offset: "30s" });
  });

  it("sends a YouTube link as a link, with no mime type, and sound as audio", () => {
    const link = requestBody({ model: "m", media: { type: "video", uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, text: "q" });
    expect((link.input as Array<Record<string, unknown>>)[0]).toEqual({ type: "video", uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const sound = requestBody({ model: "m", media: { type: "audio", uri: "https://x/files/a", mimeType: "audio/wav" }, text: "q" });
    expect((sound.input as Array<Record<string, unknown>>)[0]).toEqual({ type: "audio", uri: "https://x/files/a", mime_type: "audio/wav" });
  });

  it("writes offsets the way Google reads them", () => {
    expect(offsetString(90)).toBe("90s");
    expect(offsetString(10.5)).toBe("10.5s");
    expect(offsetString(1 / 3)).toBe("0.333s");
    expect(offsetString(-4)).toBe("0s");
  });

  it("goes to the Interactions endpoint with the key in a header only", async () => {
    const { client, sent } = gemini();
    await client.ask(video, new AbortController().signal);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(sent[0]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(sent[0]!.headers).not.toHaveProperty("Api-Revision");
    expect(sent[0]!.url).not.toContain(KEY);
    expect(JSON.stringify(sent[0]!.body)).not.toContain(KEY);
    expect(sent[0]!.body.store).toBe(false);
    expect(sent[0]!.body).not.toHaveProperty("background");
  });
});

describe("the answer", () => {
  it("is the text of the model's output steps, leaving out its navigation and thoughts", () => {
    expect(answerText({
      steps: [
        { type: "processing_call", id: "1" },
        { type: "processing_result", call_id: "1" },
        { type: "thought", content: [{ type: "text", text: "hmm" }] },
        { type: "model_output", content: [{ type: "text", text: "First." }, { type: "image", data: "x" }, { type: "text", text: "  " }, { type: "text", text: "Second." }] },
        { type: "model_output", content: [{ type: "text", text: "Third." }] },
      ],
    })).toBe("First.\nSecond.\nThird.");
    expect(answerText({})).toBe("");
    expect(answerText({ steps: "nope" })).toBe("");
  });

  it("comes back with the text and the tokens it cost", async () => {
    const { client } = gemini();
    expect(await client.ask(video, new AbortController().signal)).toEqual({ text: "[00:04] She laughs.", totalTokens: 6040, incomplete: false });
  });

  it("says when Google stopped before the answer was whole", async () => {
    const { client } = gemini(() => reply(done("Part one", { status: "incomplete" })));
    expect(await client.ask(video, new AbortController().signal)).toMatchObject({ text: "Part one", incomplete: true });
  });
});

describe("when it goes wrong", () => {
  const ask = (client: GeminiInteractions, signal = new AbortController().signal) => client.ask(video, signal);

  it("tells a refused key, a quota, a missing model and a server error apart", async () => {
    const failing = (status: number, message: string) => gemini(() => reply({ error: { code: "x", message } }, status)).client;
    await expect(ask(failing(401, "API key expired"))).rejects.toMatchObject({ kind: "auth", status: 401 });
    await expect(ask(failing(403, "permission denied"))).rejects.toMatchObject({ kind: "auth" });
    await expect(ask(failing(429, "rate limit"))).rejects.toMatchObject({ kind: "quota" });
    await expect(ask(failing(402, "credit depleted"))).rejects.toMatchObject({ kind: "quota" });
    await expect(ask(failing(404, "model gemini-test not found"))).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("pick another in Settings") });
    await expect(ask(failing(400, "The video is too long"))).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("too long") });
    await expect(ask(failing(503, "overloaded"))).rejects.toMatchObject({ kind: "service" });
  });

  it("never lets the key into an error, even one that echoes it", async () => {
    const { client } = gemini(() => reply({ error: { message: `bad key ${KEY}` } }, 400));
    const error = await ask(client).catch((thrown: unknown) => thrown);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).toContain("[key]");
  });

  it("reports a refusal Google makes while answering, and an answer with no text", async () => {
    await expect(ask(gemini(() => reply({ status: "failed", error: { code: "safety", message: "blocked" } })).client)).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("blocked") });
    await expect(ask(gemini(() => reply({ status: "cancelled" })).client)).rejects.toMatchObject({ kind: "rejected" });
    await expect(ask(gemini(() => reply({ status: "completed", steps: [] })).client)).rejects.toMatchObject({ kind: "response" });
    await expect(ask(gemini(() => new Response("<html>", { status: 200 })).client)).rejects.toMatchObject({ kind: "response" });
  });

  it("makes no request without a key", async () => {
    const { client, sent } = gemini(undefined, { key: null });
    await expect(ask(client)).rejects.toMatchObject({ kind: "auth" });
    expect(sent).toHaveLength(0);
  });

  it("reports an unreachable network, a timeout, and a cancel for what each is", async () => {
    const down = new GeminiInteractions({ key: async () => KEY, fetch: (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }) as typeof fetch });
    await expect(ask(down)).rejects.toMatchObject({ kind: "network", message: expect.stringContaining("ENOTFOUND") });

    // Like fetch: rejects at once for a signal that is already aborted, and when it aborts otherwise.
    const hangs = (init?: Parameters<typeof fetch>[1]) => new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) return reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    const slow = new GeminiInteractions({ key: async () => KEY, fetch: ((_: unknown, init?: Parameters<typeof fetch>[1]) => hangs(init)) as typeof fetch, timeoutMs: 20 });
    await expect(ask(slow)).rejects.toMatchObject({ kind: "timeout" });

    const controller = new AbortController();
    const waiting = new GeminiInteractions({ key: async () => KEY, fetch: ((_: unknown, init?: Parameters<typeof fetch>[1]) => hangs(init)) as typeof fetch });
    const running = ask(waiting, controller.signal);
    controller.abort(new GeminiError("canceled", "The call was canceled."));
    await expect(running).rejects.toMatchObject({ kind: "canceled" });
  });
});
