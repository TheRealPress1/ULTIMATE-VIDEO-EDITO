import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWhisperTranscript } from "./speech-transcript";
import { SPEECH_MODEL_BYTES, SPEECH_SAMPLE_RATE } from "./speech-types";
import { SPEECH_CHUNK_MAX_SECONDS } from "./speech-chunks";
import type { SpeechProgress, SpeechResult, SpeechStatus } from "./speech-types";

const MODEL = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  bytes: SPEECH_MODEL_BYTES,
  sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
};
const MODEL_NAME = "Whisper Base";
const MODEL_FILENAME = "ggml-base.bin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PCM_BYTES_PER_SECOND = SPEECH_SAMPLE_RATE * 2;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 32 * 1_048_576;
const LANGUAGES = new Set(("auto en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue").split(" "));
const CANCELLED = "Transcription cancelled.";
const INVALID_AUDIO = "Local transcription requires a valid 16 kHz mono PCM16 WAV file.";
const DOWNLOAD_FAILED = "The speech model could not be downloaded. Check your connection and try again.";
const MODEL_DAMAGED = "The speech model download is incomplete or damaged. Try transcribing again.";

export type LocalSpeechServiceOptions = {
  runtimePath: string;
  dataDir: string;
  fetch?: typeof globalThis.fetch;
  /** Alternate small model metadata is useful for isolated service tests. */
  model?: { url: string; bytes: number; sha256: string };
  runTimeoutMs?: number;
  downloadTimeoutMs?: number;
  killGraceMs?: number;
};
export type SpeechRequest = { id: string; audio: Uint8Array; language?: string };
type ActiveTask = { id: string; controller: AbortController };

function wavDuration(audio: Uint8Array): number {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 44
    || audio.byteLength > SPEECH_CHUNK_MAX_SECONDS * PCM_BYTES_PER_SECOND + MAX_METADATA_BYTES + 8) {
    throw new Error(INVALID_AUDIO);
  }
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE"
    || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error(INVALID_AUDIO);
  let offset = 12;
  let formatFound = false;
  let dataBytes: number | null = null;
  let metadataBytes = 4;
  let chunks = 0;
  while (offset + 8 <= bytes.length) {
    if (++chunks > 4_096) throw new Error(INVALID_AUDIO);
    const kind = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size % 2);
    if (paddedEnd > bytes.length) throw new Error(INVALID_AUDIO);
    if (kind === "fmt ") {
      if (formatFound || size < 16 || size > 128) throw new Error(INVALID_AUDIO);
      if (bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
        || bytes.readUInt32LE(start + 4) !== SPEECH_SAMPLE_RATE
        || bytes.readUInt32LE(start + 8) !== PCM_BYTES_PER_SECOND
        || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) {
        throw new Error(INVALID_AUDIO);
      }
      formatFound = true;
    }
    if (kind === "data") {
      if (dataBytes !== null || size === 0 || size % 2 !== 0) throw new Error(INVALID_AUDIO);
      dataBytes = size;
    } else {
      metadataBytes += paddedEnd - offset;
      if (metadataBytes > MAX_METADATA_BYTES) throw new Error(INVALID_AUDIO);
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !formatFound || dataBytes === null) throw new Error(INVALID_AUDIO);
  const duration = dataBytes / PCM_BYTES_PER_SECOND;
  if (duration > SPEECH_CHUNK_MAX_SECONDS) throw new Error("Native speech jobs accept bounded five-minute sections.");
  return duration;
}

function fingerprint(info: Awaited<ReturnType<typeof lstat>>): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export class LocalSpeechService {
  private readonly options: LocalSpeechServiceOptions;
  private readonly request: typeof globalThis.fetch;
  private readonly model: typeof MODEL;
  private active: ActiveTask | null = null;
  private verifiedModel: string | null = null;
  private disposed = false;

  constructor(options: LocalSpeechServiceOptions) {
    this.options = options;
    this.request = options.fetch ?? globalThis.fetch;
    this.model = options.model ?? MODEL;
    if (!Number.isSafeInteger(this.model.bytes) || this.model.bytes <= 0
      || !/^[a-f0-9]{64}$/i.test(this.model.sha256)) throw new Error("Invalid local speech model configuration.");
  }

  private get modelPath(): string { return join(this.options.dataDir, "models", MODEL_FILENAME); }

  async status(): Promise<SpeechStatus> {
    const available = !this.disposed && await this.runtimeAvailable();
    const modelDownloaded = await this.modelAvailable();
    return {
      available,
      modelDownloaded,
      modelName: MODEL_NAME,
      downloadBytes: this.model.bytes,
      error: available ? null : "The local speech engine is unavailable in this build of Cutroom.",
    };
  }

  cancel(id: string): void {
    if (this.active?.id === id) this.active.controller.abort(new Error(CANCELLED));
  }

  dispose(): void {
    this.disposed = true;
    this.active?.controller.abort(new Error(CANCELLED));
  }

  async transcribe(input: SpeechRequest, onProgress?: (progress: SpeechProgress) => void): Promise<SpeechResult> {
    if (this.disposed) throw new Error("The local speech service has closed.");
    if (this.active) throw new Error("Another transcription is already running. Wait for it to finish or cancel it first.");
    if (!input || typeof input.id !== "string" || !UUID.test(input.id)) throw new Error("Invalid transcription request ID.");
    const duration = wavDuration(input.audio);
    const language = input.language ?? "auto";
    if (typeof language !== "string" || !LANGUAGES.has(language)) throw new Error("Choose a supported transcription language.");
    const task: ActiveTask = { id: input.id, controller: new AbortController() };
    this.active = task;
    const signal = task.controller.signal;
    const progress = (stage: SpeechProgress["stage"], value: number | null, message: string) => {
      try { onProgress?.({ id: input.id, stage, progress: value, message }); } catch { /* A closed renderer must not break cleanup. */ }
    };
    let temporaryDirectory: string | null = null;
    try {
      progress("preparing", null, "Preparing local transcription…");
      if (!await this.runtimeAvailable()) throw new Error("The local speech engine is unavailable in this build of Cutroom.");
      signal.throwIfAborted();
      await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
      await chmod(this.options.dataDir, 0o700);
      temporaryDirectory = await mkdtemp(join(this.options.dataDir, "transcription-"));
      const wavPath = join(temporaryDirectory, "audio.wav");
      await writeFile(wavPath, input.audio, { mode: 0o600, flag: "wx", signal });
      await this.ensureModel(signal, (value) => progress("downloading", value, "Downloading the speech model for offline use…"));
      signal.throwIfAborted();
      const outputBase = join(temporaryDirectory, "transcript");
      progress("transcribing", 0, "Transcribing on your Mac…");
      await this.run(task, ["-m", this.modelPath, "-f", wavPath, "-l", language, "-ojf", "-pp", "-of", outputBase],
        (value) => progress("transcribing", value, "Transcribing on your Mac…"));
      signal.throwIfAborted();
      const outputPath = `${outputBase}.json`;
      const outputInfo = await lstat(outputPath).catch(() => null);
      if (!outputInfo?.isFile() || outputInfo.size === 0 || outputInfo.size > MAX_OUTPUT_BYTES) {
        throw new Error("Local speech recognition did not produce a valid transcript. Try again.");
      }
      let output: unknown;
      try { output = JSON.parse(await readFile(outputPath, { encoding: "utf8", signal })); }
      catch { signal.throwIfAborted(); throw new Error("Local speech recognition returned unreadable results. Try again."); }
      const segments = parseWhisperTranscript(output, duration);
      progress("transcribing", 1, "Transcription complete.");
      return { segments };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      try { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); }
      finally { if (this.active === task) this.active = null; }
    }
  }

  private async runtimeAvailable(): Promise<boolean> {
    try {
      await access(this.options.runtimePath, constants.X_OK);
      return (await stat(this.options.runtimePath)).isFile();
    } catch { return false; }
  }

  private async modelAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      const info = await lstat(this.modelPath);
      if (!info.isFile() || info.size !== this.model.bytes) { this.verifiedModel = null; return false; }
      const key = fingerprint(info);
      if (this.verifiedModel === key) return true;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(this.modelPath, { signal })) hash.update(chunk);
      const unchanged = fingerprint(await lstat(this.modelPath)) === key;
      if (!unchanged || hash.digest("hex") !== this.model.sha256.toLowerCase()) { this.verifiedModel = null; return false; }
      this.verifiedModel = key;
      return true;
    } catch {
      signal?.throwIfAborted();
      this.verifiedModel = null;
      return false;
    }
  }

  private async ensureModel(signal: AbortSignal, progress: (value: number) => void): Promise<void> {
    if (await this.modelAvailable(signal)) return;
    signal.throwIfAborted();
    const modelDir = join(this.options.dataDir, "models");
    await mkdir(modelDir, { recursive: true, mode: 0o700 });
    await chmod(modelDir, 0o700);
    const temporaryPath = join(modelDir, `.${MODEL_FILENAME}.${randomUUID()}.part`);
    const downloadController = new AbortController();
    const timeout = setTimeout(() => downloadController.abort(new Error("The speech model download timed out. Try again.")),
      this.options.downloadTimeoutMs ?? 10 * 60_000);
    timeout.unref();
    const downloadSignal = AbortSignal.any([signal, downloadController.signal]);
    let file: Awaited<ReturnType<typeof open>> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      progress(0);
      const response = await this.request(this.model.url, { signal: downloadSignal, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(DOWNLOAD_FAILED);
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== this.model.bytes)) throw new Error(MODEL_DAMAGED);
      reader = response.body.getReader();
      file = await open(temporaryPath, "wx", 0o600);
      const hash = createHash("sha256");
      let received = 0;
      let reported = -1;
      while (true) {
        downloadSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > this.model.bytes) throw new Error(MODEL_DAMAGED);
        hash.update(value);
        await file.writeFile(value);
        const percentage = Math.floor(received / this.model.bytes * 100);
        if (percentage !== reported) { reported = percentage; progress(received / this.model.bytes); }
      }
      downloadSignal.throwIfAborted();
      if (received !== this.model.bytes || hash.digest("hex") !== this.model.sha256.toLowerCase()) throw new Error(MODEL_DAMAGED);
      await file.sync();
      await file.close();
      file = null;
      await rename(temporaryPath, this.modelPath);
      this.verifiedModel = fingerprint(await lstat(this.modelPath));
      progress(1);
    } catch (error) {
      downloadSignal.throwIfAborted();
      if (error instanceof Error && [MODEL_DAMAGED, DOWNLOAD_FAILED].includes(error.message)) throw error;
      throw new Error(DOWNLOAD_FAILED);
    } finally {
      clearTimeout(timeout);
      downloadController.abort();
      await reader?.cancel().catch(() => undefined);
      await file?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true });
    }
  }

  private run(task: ActiveTask, args: string[], progress: (value: number) => void): Promise<void> {
    const signal = task.controller.signal;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.runtimePath, args, { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let settled = false;
      let stderr = "";
      let percentage = -1;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const runTimer = setTimeout(() => task.controller.abort(new Error("Local transcription took too long. Try a shorter clip.")),
        this.options.runTimeoutMs ?? 30 * 60_000);
      runTimer.unref();
      const abort = () => {
        child.kill("SIGTERM");
        if (!killTimer) {
          killTimer = setTimeout(() => child.kill("SIGKILL"), this.options.killGraceMs ?? 2_000);
          killTimer.unref();
        }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(runTimer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        child.stderr.removeAllListeners("data");
        if (signal.aborted) reject(signal.reason);
        else if (error) reject(error);
        else resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // Bound output even if a damaged executable emits unbounded logs. Raw
        // stderr contains paths and sometimes transcript text, so never expose it.
        stderr = (stderr + chunk).slice(-8_192);
        for (const match of stderr.matchAll(/progress\s*=\s*(\d{1,3})%/g)) {
          const next = Number(match[1]);
          if (next > percentage && next <= 100) { percentage = next; progress(next / 100); }
        }
      });
      child.once("error", () => finish(new Error("The local speech engine could not start. Restart Cutroom and try again.")));
      child.once("close", (code) => finish(code === 0 ? undefined
        : new Error(`Local speech recognition stopped unexpectedly${typeof code === "number" ? ` (exit ${code})` : ""}. Try again.`)));
    });
  }
}
