import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWhisperTranscript } from "./speech-transcript";
import { SPEECH_ACCURATE_MODEL_BYTES, SPEECH_MODEL_BYTES, SPEECH_SAMPLE_RATE } from "./speech-types";
import { SPEECH_CHUNK_MAX_SECONDS } from "./speech-chunks";
import type { SpeechProgress, SpeechQuality, SpeechResult, SpeechStatus } from "./speech-types";

const MODEL = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  bytes: SPEECH_MODEL_BYTES,
  sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
};
const MODEL_NAME = "Whisper Base";
const MODEL_FILENAME = "ggml-base.bin";
// The larger model, fetched only when a transcription asks for quality
// "accurate". Pinned by the SHA-1 whisper.cpp publishes for it (models/README.md
// of the pinned v1.9.5 source); its exact size is not pinned, so the download is
// bounded instead and the hash decides.
const ACCURATE_MODEL = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  bytes: SPEECH_ACCURATE_MODEL_BYTES,
  sha1: "4af2b29d7ec73d781377bfd1758ca957a807e941",
};
const ACCURATE_MODEL_NAME = "Whisper Large v3 Turbo";
const ACCURATE_MODEL_FILENAME = "ggml-large-v3-turbo.bin";
const ACCURATE_MAX_BYTES = 1_900_000_000;
const ACCURATE_SIZE_NOTE = "about 1.6 GB";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PCM_BYTES_PER_SECOND = SPEECH_SAMPLE_RATE * 2;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 32 * 1_048_576;
const LANGUAGES = new Set(("auto en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue").split(" "));
const CANCELLED = "Transcription cancelled.";
const INVALID_AUDIO = "Local transcription requires a valid 16 kHz mono PCM16 WAV file.";
const DOWNLOAD_FAILED = "The speech model could not be downloaded. Check your connection and try again.";
const MODEL_DAMAGED = "The speech model download is incomplete or damaged. Try transcribing again.";
const ACCURATE_DOWNLOAD_FAILED = `The accurate speech model (${ACCURATE_SIZE_NOTE}) could not be downloaded. Check your connection and try again, or transcribe with quality "fast".`;
const ACCURATE_DAMAGED = `The accurate speech model download (${ACCURATE_SIZE_NOTE}) is incomplete or damaged. Try again, or transcribe with quality "fast".`;

/** One Whisper model: where it comes from, how it is checked, and what a failure says. */
type ModelSpec = {
  name: string;
  filename: string;
  url: string;
  /** The exact size when `exact`; otherwise about what it downloads, under `maxBytes`. */
  bytes: number;
  exact: boolean;
  maxBytes: number;
  digest: { algorithm: "sha256" | "sha1"; value: string };
  downloading: string;
  failed: string;
  damaged: string;
  timeoutMs: number;
};

export type LocalSpeechServiceOptions = {
  runtimePath: string;
  dataDir: string;
  fetch?: typeof globalThis.fetch;
  /** Alternate small model metadata is useful for isolated service tests. */
  model?: { url: string; bytes: number; sha256: string };
  /** The same for the accurate model; `bytes` is its expected size, and the digest decides. */
  accurateModel?: { url: string; bytes: number; sha1?: string; sha256?: string };
  runTimeoutMs?: number;
  downloadTimeoutMs?: number;
  killGraceMs?: number;
};
export type SpeechRequest = { id: string; audio: Uint8Array; language?: string; quality?: SpeechQuality };
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
  private readonly models: Record<SpeechQuality, ModelSpec>;
  private active: ActiveTask | null = null;
  /** Each model file's stat fingerprint once its digest has been checked, by path. */
  private readonly verified = new Map<string, string>();
  private disposed = false;

  constructor(options: LocalSpeechServiceOptions) {
    this.options = options;
    this.request = options.fetch ?? globalThis.fetch;
    const base = options.model ?? MODEL;
    if (!Number.isSafeInteger(base.bytes) || base.bytes <= 0
      || !/^[a-f0-9]{64}$/i.test(base.sha256)) throw new Error("Invalid local speech model configuration.");
    const accurate: NonNullable<LocalSpeechServiceOptions["accurateModel"]> = options.accurateModel ?? ACCURATE_MODEL;
    const accurateDigest = accurate.sha256 !== undefined ? { algorithm: "sha256" as const, value: accurate.sha256 }
      : accurate.sha1 !== undefined ? { algorithm: "sha1" as const, value: accurate.sha1 } : null;
    if (!Number.isSafeInteger(accurate.bytes) || accurate.bytes <= 0 || accurate.bytes > ACCURATE_MAX_BYTES || !accurateDigest
      || !(accurateDigest.algorithm === "sha256" ? /^[a-f0-9]{64}$/i : /^[a-f0-9]{40}$/i).test(accurateDigest.value)) {
      throw new Error("Invalid local speech model configuration.");
    }
    this.models = {
      fast: { name: MODEL_NAME, filename: MODEL_FILENAME, url: base.url, bytes: base.bytes, exact: true, maxBytes: base.bytes,
        digest: { algorithm: "sha256", value: base.sha256 }, downloading: "Downloading the speech model for offline use…",
        failed: DOWNLOAD_FAILED, damaged: MODEL_DAMAGED, timeoutMs: options.downloadTimeoutMs ?? 10 * 60_000 },
      accurate: { name: ACCURATE_MODEL_NAME, filename: ACCURATE_MODEL_FILENAME, url: accurate.url, bytes: accurate.bytes, exact: false,
        maxBytes: ACCURATE_MAX_BYTES, digest: accurateDigest,
        downloading: `Downloading the accurate speech model (${ACCURATE_SIZE_NOTE}, once) for offline use…`,
        failed: ACCURATE_DOWNLOAD_FAILED, damaged: ACCURATE_DAMAGED, timeoutMs: options.downloadTimeoutMs ?? 90 * 60_000 },
    };
  }

  private modelPath(model: ModelSpec): string { return join(this.options.dataDir, "models", model.filename); }

  async status(): Promise<SpeechStatus> {
    const available = !this.disposed && await this.runtimeAvailable();
    const modelDownloaded = await this.modelAvailable(this.models.fast);
    const accurate = this.models.accurate;
    return {
      available,
      modelDownloaded,
      modelName: MODEL_NAME,
      downloadBytes: this.models.fast.bytes,
      error: available ? null : "The local speech engine is unavailable in this build of Cutroom.",
      // Present on disk is enough here: its digest is checked before each use, not on every status read.
      accurate: { modelName: accurate.name, downloadBytes: accurate.bytes, downloaded: await this.modelPresent(accurate) },
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
    const quality = input.quality ?? "fast";
    if (quality !== "fast" && quality !== "accurate") throw new Error("Choose fast or accurate transcription quality.");
    const model = this.models[quality];
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
      await this.ensureModel(model, signal, (value) => progress("downloading", value, model.downloading));
      signal.throwIfAborted();
      const outputBase = join(temporaryDirectory, "transcript");
      progress("transcribing", 0, "Transcribing on your Mac…");
      await this.run(task, ["-m", this.modelPath(model), "-f", wavPath, "-l", language, "-ojf", "-pp", "-of", outputBase],
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

  private sizeFits(model: ModelSpec, size: number): boolean {
    return model.exact ? size === model.bytes : size > 0 && size <= model.maxBytes;
  }

  /** A file of a plausible size where the model goes; its digest is not checked. */
  private async modelPresent(model: ModelSpec): Promise<boolean> {
    const info = await lstat(this.modelPath(model)).catch(() => null);
    return !!info?.isFile() && this.sizeFits(model, info.size);
  }

  private async modelAvailable(model: ModelSpec, signal?: AbortSignal): Promise<boolean> {
    const path = this.modelPath(model);
    try {
      const info = await lstat(path);
      if (!info.isFile() || !this.sizeFits(model, info.size)) { this.verified.delete(path); return false; }
      const key = fingerprint(info);
      if (this.verified.get(path) === key) return true;
      const hash = createHash(model.digest.algorithm);
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
      const unchanged = fingerprint(await lstat(path)) === key;
      if (!unchanged || hash.digest("hex") !== model.digest.value.toLowerCase()) { this.verified.delete(path); return false; }
      this.verified.set(path, key);
      return true;
    } catch {
      signal?.throwIfAborted();
      this.verified.delete(path);
      return false;
    }
  }

  private async ensureModel(model: ModelSpec, signal: AbortSignal, progress: (value: number) => void): Promise<void> {
    if (await this.modelAvailable(model, signal)) return;
    signal.throwIfAborted();
    const modelDir = join(this.options.dataDir, "models");
    await mkdir(modelDir, { recursive: true, mode: 0o700 });
    await chmod(modelDir, 0o700);
    const modelPath = this.modelPath(model);
    const temporaryPath = join(modelDir, `.${model.filename}.${randomUUID()}.part`);
    const downloadController = new AbortController();
    const timeout = setTimeout(() => downloadController.abort(new Error("The speech model download timed out. Try again.")),
      model.timeoutMs);
    timeout.unref();
    const downloadSignal = AbortSignal.any([signal, downloadController.signal]);
    let file: Awaited<ReturnType<typeof open>> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      progress(0);
      const response = await this.request(model.url, { signal: downloadSignal, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(model.failed);
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || !this.sizeFits(model, Number(length)))) throw new Error(model.damaged);
      // The size the progress counts against: the server's when it says, the expected one otherwise.
      const expected = length !== null && !model.exact ? Number(length) : model.bytes;
      reader = response.body.getReader();
      file = await open(temporaryPath, "wx", 0o600);
      const hash = createHash(model.digest.algorithm);
      let received = 0;
      let reported = -1;
      while (true) {
        downloadSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > model.maxBytes) throw new Error(model.damaged);
        hash.update(value);
        await file.writeFile(value);
        const fraction = Math.min(1, received / expected);
        const percentage = Math.floor(fraction * 100);
        if (percentage !== reported) { reported = percentage; progress(fraction); }
      }
      downloadSignal.throwIfAborted();
      if (!this.sizeFits(model, received) || hash.digest("hex") !== model.digest.value.toLowerCase()) throw new Error(model.damaged);
      await file.sync();
      await file.close();
      file = null;
      await rename(temporaryPath, modelPath);
      this.verified.set(modelPath, fingerprint(await lstat(modelPath)));
      progress(1);
    } catch (error) {
      downloadSignal.throwIfAborted();
      if (error instanceof Error && [model.damaged, model.failed].includes(error.message)) throw error;
      throw new Error(model.failed);
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
