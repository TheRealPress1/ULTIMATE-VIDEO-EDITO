/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { LocalAnalysisCache } from "./analysis-cache";
import { REFRAME_DEFAULT_INTERVAL, REFRAME_MAX_SAMPLES, REFRAME_MAX_SECONDS, REFRAME_CHUNK_SECONDS, REFRAME_NATIVE_MAX_SAMPLES } from "./reframe-types";
import type { ReframeAnalysisProgress, ReframeAnalysisRequest, ReframeAnalysisResult, ReframeFace, ReframeFaceSample } from "./reframe-types";

export interface LocalReframeServiceOptions {
  runtimePath: string;
  cacheDir?: string;
  runTimeoutMs?: number;
  killGraceMs?: number;
}

const CANCELLED = "Face analysis cancelled.";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const signature = (info: Awaited<ReturnType<typeof stat>>): string => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

function validateRequest(input: ReframeAnalysisRequest): Required<ReframeAnalysisRequest> {
  if (!input || typeof input.id !== "string" || !UUID.test(input.id)) throw new Error("Invalid face analysis request ID.");
  if (typeof input.path !== "string" || !isAbsolute(input.path) || input.path.includes("\0")) throw new Error("Choose a local video file for face analysis.");
  const sampleInterval = input.sampleInterval ?? REFRAME_DEFAULT_INTERVAL;
  if ((!finite(input.sourceStart ?? 0) || (input.sourceStart ?? 0) < 0 || (input.sourceStart ?? 0) > 86400) || !finite(input.start) || !finite(input.end) || input.start < 0 || input.end <= input.start ||
    input.end - input.start > REFRAME_MAX_SECONDS || !finite(sampleInterval) || sampleInterval < 0.25 || sampleInterval > 5 ||
    Math.ceil((input.end - input.start) / sampleInterval - 1e-9) > REFRAME_MAX_SAMPLES) {
    throw new Error("Analyze up to two hours and 28,800 frames, sampled every 0.25–5 seconds.");
  }
  return { id: input.id, path: input.path, start: input.start, end: input.end, sampleInterval, sourceStart: input.sourceStart ?? 0 };
}

/** A bounded, cancellable local Vision process. No source bytes leave this Mac. */
export class LocalReframeService {
  private active: { id: string; controller: AbortController } | null = null;
  private disposed = false;
  private readonly options: LocalReframeServiceOptions;
  private readonly cache?: LocalAnalysisCache;

  constructor(options: LocalReframeServiceOptions) { this.options = options; if (options.cacheDir) this.cache = new LocalAnalysisCache({ directory: options.cacheDir }); }

  async available(): Promise<boolean> {
    return !this.disposed && process.platform === "darwin" && await access(this.options.runtimePath, constants.X_OK).then(() => true, () => false);
  }

  cancel(id: string): void {
    if (this.active?.id === id) this.active.controller.abort(new Error(CANCELLED));
  }

  dispose(): void {
    this.disposed = true;
    this.active?.controller.abort(new Error(CANCELLED));
  }

  async analyze(input: ReframeAnalysisRequest, onProgress?: (progress: ReframeAnalysisProgress) => void): Promise<ReframeAnalysisResult> {
    if (this.disposed) throw new Error("The local face analysis service has closed.");
    if (this.active) throw new Error("Another face analysis is running. Wait for it to finish or cancel it first.");
    const request = validateRequest(input);
    const task = { id: request.id, controller: new AbortController() };
    this.active = task;
    try {
      if (!await this.available()) throw new Error("Local face following is available only in Mac builds with the Vision helper. Use center framing instead.");
      task.controller.signal.throwIfAborted();
      request.path = await realpath(request.path);
      const before = await stat(request.path);
      if (!before.isFile() || before.size === 0) throw new Error("Choose a readable local video file for face analysis.");
      task.controller.signal.throwIfAborted();
      const result = await this.runChunks(request, task.controller.signal, onProgress);
      task.controller.signal.throwIfAborted();
      const after = await stat(request.path).catch(() => { throw new Error("The source video is no longer available. Restore its link and analyze it again."); });
      task.controller.signal.throwIfAborted();
      if (signature(after) !== signature(before)) throw new Error("The source video changed during face analysis. Analyze it again.");
      return result;
    } finally {
      if (this.active === task) this.active = null;
    }
  }

  private async runChunks(request: Required<ReframeAnalysisRequest>, signal: AbortSignal, progress?: (value: ReframeAnalysisProgress) => void): Promise<ReframeAnalysisResult> {
    const total = Math.ceil((request.end - request.start) / request.sampleInterval - 1e-9);
    const step = Math.min(REFRAME_NATIVE_MAX_SAMPLES - 1, Math.floor(REFRAME_CHUNK_SECONDS / request.sampleInterval));
    const samples: ReframeFaceSample[] = [];
    let metadata: Omit<ReframeAnalysisResult, 'samples'> | undefined;
    const report = (completed: number) => { try { progress?.({ id: request.id, completed, total }); } catch { /* progress never owns cleanup */ } };
    for (let index = 0; index < total; index += step) {
      signal.throwIfAborted();
      const count = Math.min(step, total - index), leading = index ? 1 : 0;
      const part = { ...request, start: request.start + (index - leading) * request.sampleInterval,
        end: Math.min(request.end, request.start + (index + count) * request.sampleInterval) };
      const cacheRequest = { dir: dirname(request.path), sources: [request.path], key: JSON.stringify(['face-chunks-v2', request.sourceStart, part.start, part.end, request.sampleInterval]) };
      const cached = await this.cache?.get(cacheRequest, signal);
      signal.throwIfAborted();
      let result = this.cachedResult(cached?.chunks.result, part);
      if (!result) {
        result = await this.run(part, signal, value => report(index + Math.max(0, value.completed - leading)));
        signal.throwIfAborted();
        if (cached) await this.cache!.put({ ...cacheRequest, fingerprint: cached.fingerprint, chunk: 'result', value: result }, signal);
      } else report(index + count);
      if (metadata && (metadata.width !== result.width || metadata.height !== result.height || Math.abs(metadata.duration - result.duration) > 0.001)) throw new Error('Face analysis metadata changed between sections.');
      metadata = { duration: result.duration, width: result.width, height: result.height, sampleInterval: result.sampleInterval };
      samples.push(...result.samples.slice(leading));
    }
    if (!metadata || samples.length !== total) throw new Error('Face analysis did not finish all sections.');
    return { ...metadata, samples };
  }

  private cachedResult(value: unknown, request: Required<ReframeAnalysisRequest>): ReframeAnalysisResult | undefined {
    if (!value || typeof value !== 'object') return;
    const result = value as ReframeAnalysisResult;
    const total = Math.ceil((request.end - request.start) / request.sampleInterval - 1e-9);
    if (!finite(result.duration) || result.duration < request.end - 0.05 || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 || result.width > 65536 || result.height > 65536 || result.sampleInterval !== request.sampleInterval || !Array.isArray(result.samples) || result.samples.length !== total) return;
    for (const [index, sample] of result.samples.entries()) {
      if (!sample || !finite(sample.time) || Math.abs(sample.time - (request.start + index * request.sampleInterval)) > 1e-6 || typeof sample.cut !== 'boolean' || !Array.isArray(sample.faces) || sample.faces.length > 32) return;
      for (const face of sample.faces) if (!face || ![face.x, face.y, face.width, face.height, face.confidence].every(n => finite(n) && n >= 0 && n <= 1) || face.width <= 0 || face.height <= 0 || face.x + face.width > 1.000001 || face.y + face.height > 1.000001) return;
    }
    return result;
  }

  private run(request: Required<ReframeAnalysisRequest>, signal: AbortSignal, onProgress?: (progress: ReframeAnalysisProgress) => void): Promise<ReframeAnalysisResult> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.runtimePath, [request.path, String(request.start), String(request.end), String(request.sampleInterval), ...(request.sourceStart ? [String(request.sourceStart)] : [])], {
        shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let buffered = "";
      let outputBytes = 0;
      let stderr = "";
      let header: { duration: number; width: number; height: number; sampleInterval: number; total: number } | null = null;
      const samples: ReframeFaceSample[] = [];
      let complete = false;
      let failure: Error | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), this.options.killGraceMs ?? 1000);
      };
      const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error(CANCELLED));
      const timeout = setTimeout(() => stop(new Error("Face analysis took too long. Try a shorter clip.")), this.options.runTimeoutMs ?? 10 * 60_000);
      const finish = (error?: Error, result?: ReframeAnalysisResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout); clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result!);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const report = () => {
        try { onProgress?.({ id: request.id, completed: samples.length, total: header!.total }); }
        catch { /* A closed renderer must not interrupt process cleanup. */ }
      };
      const line = (text: string) => {
        const record = JSON.parse(text) as Record<string, unknown>;
        if (!record || typeof record !== "object" || Array.isArray(record) || complete) throw new Error("Invalid face analysis output.");
        if (record.type === "header" && !header) {
          const { duration, width, height, sampleInterval, total } = record;
          if (!finite(duration) || duration <= 0 || request.start >= duration || request.end > duration + 0.05 ||
            !finite(width) || !Number.isInteger(width) || width < 1 || width > 65536 ||
            !finite(height) || !Number.isInteger(height) || height < 1 || height > 65536 ||
            sampleInterval !== request.sampleInterval || !finite(total) || !Number.isInteger(total) || total < 1 || total > REFRAME_NATIVE_MAX_SAMPLES ||
            total !== Math.ceil((Math.min(request.end, duration) - request.start) / request.sampleInterval - 1e-9)) throw new Error("Invalid face analysis metadata.");
          header = { duration, width, height, sampleInterval, total };
          report();
        } else if (record.type === "sample" && header) {
          if (!finite(record.time) || Math.abs(record.time - (request.start + samples.length * request.sampleInterval)) > 1e-6 ||
            samples.length >= header.total || typeof record.cut !== "boolean" || !Array.isArray(record.faces) || record.faces.length > 32) throw new Error("Invalid face analysis sample.");
          const faces = record.faces.map((value: unknown): ReframeFace => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid face bounds.");
            const { x, y, width, height, confidence } = value as Record<string, unknown>;
            if (![x, y, width, height, confidence].every((v) => finite(v) && v >= 0 && v <= 1) ||
              (width as number) <= 0 || (height as number) <= 0 || (x as number) + (width as number) > 1.000001 ||
              (y as number) + (height as number) > 1.000001) throw new Error("Invalid face bounds.");
            return { x, y, width, height, confidence } as ReframeFace;
          });
          samples.push({ time: record.time, faces, cut: record.cut });
          report();
        } else if (record.type === "done" && header && record.completed === header.total && samples.length === header.total) {
          complete = true;
        } else throw new Error("Incomplete or out-of-order face analysis output.");
      };
      child.stdout.on("data", (data: Buffer) => {
        if (failure) return;
        outputBytes += data.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { stop(new Error("Face analysis returned too much data.")); return; }
        buffered += data.toString("utf8");
        try {
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const next = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
            if (next.trim()) line(next);
            if (failure) break;
          }
        } catch (error) { stop(error instanceof Error ? error : new Error("Invalid face analysis output.")); }
      });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-16_384); });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (failure) { finish(failure); return; }
        if (code !== 0) { finish(new Error(stderr.trim() || "The local face analysis helper failed.")); return; }
        if (buffered.trim() || !header || !complete) { finish(new Error("The face analysis helper returned an incomplete result.")); return; }
        const { duration, width, height, sampleInterval } = header;
        finish(undefined, { duration, width, height, sampleInterval, samples });
      });
    });
  }
}
