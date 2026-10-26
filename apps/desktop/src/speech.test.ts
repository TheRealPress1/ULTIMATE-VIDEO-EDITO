import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSpeechService } from "./speech";
import type { LocalSpeechServiceOptions } from "./speech";
import type { SpeechProgress } from "./speech-types";

const MODEL_BYTES = Buffer.from("A small verified model fixture.");
const MODEL = { url: "https://models.example.test/base.bin", bytes: MODEL_BYTES.length, sha256: createHash("sha256").update(MODEL_BYTES).digest("hex") };
const OUTPUT = { model: { multilingual: true }, transcription: [{ text: " Hello world!", tokens: [
  { text: " Hello", id: 100, offsets: { from: 0, to: 300 } },
  { text: " world", id: 101, offsets: { from: 300, to: 700 } },
  { text: "!", id: 102, offsets: { from: 700, to: 720 } },
] }] };

let directory: string;
let runtimePath: string;
let dataDir: string;
let instances: LocalSpeechService[];

function wav(samples = 16_000): Buffer {
  const value = Buffer.alloc(44 + samples * 2);
  value.write("RIFF", 0);
  value.writeUInt32LE(value.length - 8, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(16_000, 24);
  value.writeUInt32LE(32_000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(samples * 2, 40);
  return value;
}

async function runtime(body = `
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  fs.writeFileSync(args[args.indexOf("-of") + 1] + ".json", ${JSON.stringify(JSON.stringify(OUTPUT))});
  process.stderr.write("whisper_print_progress_callback: progress = 75%\\n");
`) {
  await writeFile(runtimePath, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
}

function service(options: Partial<LocalSpeechServiceOptions> = {}) {
  const request = vi.fn(async () => new Response(MODEL_BYTES));
  const instance = new LocalSpeechService({ runtimePath, dataDir, model: MODEL, fetch: request as typeof fetch, killGraceMs: 20, ...options });
  instances.push(instance);
  return { instance, request };
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Fixture process did not start");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cutroom-speech-test-"));
  runtimePath = join(directory, "speech-runtime.cjs");
  dataDir = join(directory, "speech-data");
  instances = [];
  await runtime();
});
afterEach(async () => {
  for (const instance of instances) instance.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe("local speech service", () => {
  it("downloads a verified private model once, runs locally, reports progress and cleans audio/results", async () => {
    const { instance, request } = service();
    expect(await instance.status()).toMatchObject({ available: true, modelDownloaded: false });
    const events: SpeechProgress[] = [];
    const result = await instance.transcribe({ id: randomUUID(), audio: wav(), language: "en" }, (event) => events.push(event));
    expect(result).toEqual({ segments: [{ text: "Hello world!", words: [
      { text: "Hello", start: 0, end: 0.3 }, { text: "world!", start: 0.3, end: 0.72 },
    ] }] });
    expect(events.map((event) => event.stage)).toEqual(expect.arrayContaining(["preparing", "downloading", "transcribing"]));
    expect(events.some((event) => event.stage === "transcribing" && event.progress === 0.75)).toBe(true);
    expect(events.at(-1)?.progress).toBe(1);
    const modelPath = join(dataDir, "models", "ggml-base.bin");
    expect(await readFile(modelPath)).toEqual(MODEL_BYTES);
    expect((await stat(modelPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(dataDir)).toEqual(["models"]);
    expect(await readdir(join(dataDir, "models"))).toEqual(["ggml-base.bin"]);
    expect(await instance.status()).toMatchObject({ available: true, modelDownloaded: true });
    request.mockRejectedValue(new Error("Offline"));
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).resolves.toEqual(result);
    expect(request).toHaveBeenCalledTimes(1);
    const options = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(options[0]).toBe(MODEL.url);
    expect(options[1].body).toBeUndefined();
    expect(options[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("passes paths and language as separate arguments and enables full JSON without VAD", async () => {
    const captured = join(directory, "arguments.json");
    await runtime(`
      const fs = require("node:fs"); const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(args));
      fs.writeFileSync(args[args.indexOf("-of") + 1] + ".json", ${JSON.stringify(JSON.stringify(OUTPUT))});
    `);
    const { instance } = service({ dataDir: join(directory, "space and $symbol data") });
    await instance.transcribe({ id: randomUUID(), audio: wav(), language: "fr" });
    const args: string[] = JSON.parse(await readFile(captured, "utf8"));
    expect(args[args.indexOf("-l") + 1]).toBe("fr");
    expect(args).toContain("-ojf");
    expect(args).not.toContain("--vad");
    expect(args).not.toContain("-ml");
    expect(args[args.indexOf("-m") + 1]).toContain("space and $symbol data");
  });

  it("rejects corrupt downloaded bytes and removes partial files", async () => {
    const corrupted = Buffer.alloc(MODEL.bytes, 1);
    const { instance } = service({ fetch: vi.fn(async () => new Response(corrupted)) as typeof fetch });
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow("incomplete or damaged");
    expect(await readdir(dataDir)).toEqual(["models"]);
    expect(await readdir(join(dataDir, "models"))).toEqual([]);
    expect((await instance.status()).modelDownloaded).toBe(false);
  });

  it.each([MODEL.bytes - 1, MODEL.bytes + 1])("rejects streamed byte count %s even without Content-Length", async (length) => {
    const { instance } = service({ fetch: vi.fn(async () => new Response(Buffer.alloc(length))) as typeof fetch });
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow("incomplete or damaged");
    expect(await readdir(join(dataDir, "models"))).toEqual([]);
  });

  it("verifies existing cache content and repairs a corrupt file before inference", async () => {
    await mkdir(join(dataDir, "models"), { recursive: true });
    await writeFile(join(dataDir, "models", "ggml-base.bin"), Buffer.alloc(MODEL.bytes));
    const { instance, request } = service();
    expect((await instance.status()).modelDownloaded).toBe(false);
    await instance.transcribe({ id: randomUUID(), audio: wav() });
    expect(request).toHaveBeenCalledTimes(1);
    expect((await instance.status()).modelDownloaded).toBe(true);
    // A later external modification must invalidate the verified fingerprint.
    await writeFile(join(dataDir, "models", "ggml-base.bin"), Buffer.alloc(MODEL.bytes));
    expect((await instance.status()).modelDownloaded).toBe(false);
  });

  it("cancels an in-flight download, removes its partial file, and permits retry", async () => {
    const request = vi.fn(async (_url: unknown, options?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(MODEL_BYTES.subarray(0, 3));
        options?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    })));
    const { instance } = service({ fetch: request as typeof fetch });
    const id = randomUUID();
    await expect(instance.transcribe({ id, audio: wav() }, (event) => {
      if (event.stage === "downloading" && (event.progress ?? 0) > 0) instance.cancel(id);
    })).rejects.toThrow("Transcription cancelled");
    expect(await readdir(dataDir)).toEqual(["models"]);
    expect(await readdir(join(dataDir, "models"))).toEqual([]);
    request.mockImplementation(async () => new Response(MODEL_BYTES));
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).resolves.toHaveProperty("segments");
  });

  it("times out a stalled download and releases the active task", async () => {
    const request = vi.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const { instance } = service({ fetch: request as typeof fetch, downloadTimeoutMs: 25 });
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow("download timed out");
    expect(await readdir(dataDir)).toEqual(["models"]);
    request.mockResolvedValue(new Response(MODEL_BYTES));
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).resolves.toHaveProperty("segments");
  });

  it("runs one request at a time and ignores cancellation of a different ID", async () => {
    const { instance } = service();
    let concurrent: Promise<unknown> | undefined;
    const request = { id: randomUUID(), audio: wav() };
    await instance.transcribe(request, (event) => {
      if (event.stage === "preparing") {
        instance.cancel(randomUUID());
        concurrent = instance.transcribe({ id: randomUUID(), audio: wav() }).catch((error: Error) => error.message);
      }
    });
    await expect(concurrent).resolves.toContain("Another transcription is already running");
  });

  it("terminates a running engine, escalates if SIGTERM is ignored, and cleans temporary audio", async () => {
    const marker = join(directory, "started");
    await runtime(`
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const { instance } = service();
    const id = randomUUID();
    const task = instance.transcribe({ id, audio: wav() });
    const rejection = expect(task).rejects.toThrow("Transcription cancelled");
    await waitForFile(marker);
    const pid = Number(await readFile(marker, "utf8"));
    instance.cancel(id);
    await rejection;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(dataDir)).toEqual(["models"]);
  });

  it("times out a stalled process and allows a later transcription", async () => {
    await runtime("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const { instance } = service({ runTimeoutMs: 1_000 });
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow("took too long");
    expect(await readdir(dataDir)).toEqual(["models"]);
    await runtime();
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).resolves.toHaveProperty("segments");
  });

  it("disposes an active task and prevents new tasks", async () => {
    const { instance } = service();
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() }, () => instance.dispose())).rejects.toThrow("cancelled");
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow("has closed");
    expect((await instance.status()).available).toBe(false);
  });

  it("does not expose raw engine stderr and cleans up after an engine failure", async () => {
    await runtime(`process.stderr.write("private/audio/path: secret transcript\\n".repeat(10000)); process.exitCode = 7;`);
    const { instance } = service();
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow("(exit 7)");
    expect(await readdir(dataDir)).toEqual(["models"]);
  });

  it.each(["not json", JSON.stringify({ transcription: [{ text: "speech", tokens: [] }] })])("rejects unusable engine output", async (output) => {
    await runtime(`const args = process.argv.slice(2); require("node:fs").writeFileSync(args[args.indexOf("-of") + 1] + ".json", ${JSON.stringify(output)});`);
    const { instance } = service();
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow(/unreadable results|no usable word timestamps/);
    expect(await readdir(dataDir)).toEqual(["models"]);
  });

  it("accepts silence as an empty transcript", async () => {
    await runtime(`const args = process.argv.slice(2); require("node:fs").writeFileSync(args[args.indexOf("-of") + 1] + ".json", '{"transcription":[]}');`);
    const { instance } = service();
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).resolves.toEqual({ segments: [] });
  });

  it("reports an unavailable executable before attempting any download", async () => {
    await rm(runtimePath);
    const { instance, request } = service();
    expect(await instance.status()).toMatchObject({ available: false, modelDownloaded: false });
    await expect(instance.transcribe({ id: randomUUID(), audio: wav() })).rejects.toThrow("engine is unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    (audio: Buffer) => audio.writeUInt16LE(2, 22),
    (audio: Buffer) => audio.writeUInt16LE(3, 20),
    (audio: Buffer) => audio.writeUInt32LE(48_000, 24),
    (audio: Buffer) => audio.writeUInt32LE(0xffffffff, 40),
    (audio: Buffer) => audio.writeUInt32LE(44, 4),
    (audio: Buffer) => audio.write("RF64", 0),
    (audio: Buffer) => audio.writeUInt8(audio[0] | 0x80, 0),
    (audio: Buffer) => audio.writeUInt16LE(8, 34),
  ])("rejects malformed or unsupported WAV input before file creation or download", async (mutate) => {
    const audio = wav();
    mutate(audio);
    const { instance, request } = service();
    await expect(instance.transcribe({ id: randomUUID(), audio })).rejects.toThrow("valid 16 kHz mono PCM16 WAV");
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(["speech-runtime.cjs"]);
  });

  it("rejects PCM payloads exceeding the bounded native speech window", async () => {
    const { instance, request } = service();
    await expect(instance.transcribe({ id: randomUUID(), audio: wav(16_000 * 3_600 + 1) })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects invalid IDs and language values without invoking a shell", async () => {
    const { instance, request } = service();
    await expect(instance.transcribe({ id: "../../elsewhere", audio: wav() })).rejects.toThrow("request ID");
    await expect(instance.transcribe({ id: randomUUID(), audio: wav(), language: "en; touch /tmp/no" })).rejects.toThrow("supported transcription language");
    expect(request).not.toHaveBeenCalled();
  });
});
