/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from 'node:string_decoder';
import { visualInterval, VISUAL_MAX_SAMPLES, VISUAL_MAX_SECONDS } from "./visual-types";
import type { VisualProgress, VisualAnalysis, VisualSample } from "./visual-types";
import { validateVisualAnalysis } from './visual-validation';

export interface LocalVisualAnalyzerOptions {
  runtimePath: string;
  runTimeoutMs?: number;
  killGraceMs?: number;
}

export type VisualAnalysisRequest = { id: string; path: string; duration: number; sourceStart?: number; sampleInterval?: number; startIndex?: number; endIndex?: number };

const CANCELLED = "Visual indexing cancelled.";
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const signature = (info: Awaited<ReturnType<typeof stat>>): string => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

function validateRequest(input: VisualAnalysisRequest): Required<VisualAnalysisRequest> {
  if (!input || typeof input.id !== "string" || !UUID.test(input.id)) throw new Error("Invalid visual indexing request ID.");
  if (typeof input.path !== "string" || !isAbsolute(input.path) || input.path.includes("\0")) throw new Error("Choose a local video file for visual indexing.");
  const sampleInterval = input.sampleInterval ?? visualInterval(input.duration);
  const sourceStart = input.sourceStart ?? 0;
  const total = Math.ceil(input.duration / sampleInterval - 1e-9);
  const startIndex = input.startIndex ?? 0, endIndex = input.endIndex ?? total;
  if (!finite(input.duration) || input.duration <= 0 || input.duration > VISUAL_MAX_SECONDS ||
    !finite(sourceStart) || sourceStart < 0 || sourceStart > 86400 ||
    !finite(sampleInterval) || sampleInterval < 1 || sampleInterval > 30 ||
    total > VISUAL_MAX_SAMPLES || !Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex <= startIndex || endIndex > total) {
    throw new Error("Index videos up to two hours, with at most 720 frames sampled every 1–30 seconds.");
  }
  return { id: input.id, path: input.path, duration: input.duration, sourceStart, sampleInterval, startIndex, endIndex };
}

/** A bounded, cancellable local Vision process. No source bytes leave this Mac. */
export class LocalVisualAnalyzer {
  private active: { id: string; controller: AbortController } | null = null;
  private disposed = false;
  private readonly options: LocalVisualAnalyzerOptions;

  constructor(options: LocalVisualAnalyzerOptions) { this.options = options; }

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

  async analyze(input: VisualAnalysisRequest, onProgress?: (progress: VisualProgress) => void): Promise<VisualAnalysis> {
    if (this.disposed) throw new Error("The local visual indexing service has closed.");
    if (this.active) throw new Error("Another visual indexing is running. Wait for it to finish or cancel it first.");
    const request = validateRequest(input);
    const task = { id: request.id, controller: new AbortController() };
    this.active = task;
    try {
      if (!await this.available()) throw new Error("Local visual search is available only in Mac builds with the Vision helper. Visual indexing requires macOS.");
      task.controller.signal.throwIfAborted();
      request.path = await realpath(request.path);
      const before = await stat(request.path);
      if (!before.isFile() || before.size === 0) throw new Error("Choose a readable local video file for visual indexing.");
      task.controller.signal.throwIfAborted();
      const result = await this.run(request, task.controller.signal, onProgress);
      task.controller.signal.throwIfAborted();
      const after = await stat(request.path).catch(() => { throw new Error("The source video is no longer available. Restore its link and analyze it again."); });
      task.controller.signal.throwIfAborted();
      if (signature(after) !== signature(before)) throw new Error("The source video changed during visual indexing. Analyze it again.");
      return result;
    } finally {
      if (this.active === task) this.active = null;
    }
  }

  private run(request: Required<VisualAnalysisRequest>, signal: AbortSignal, onProgress?: (progress: VisualProgress) => void): Promise<VisualAnalysis> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const args = [request.path, String(request.duration), String(request.sampleInterval), String(request.sourceStart)];
      if (request.startIndex !== 0 || request.endIndex !== Math.ceil(request.duration / request.sampleInterval - 1e-9)) args.push(String(request.startIndex), String(request.endIndex));
      const child = spawn(this.options.runtimePath, args, {
        shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let buffered = "";
      const decoder = new StringDecoder('utf8');
      let outputBytes = 0;
      let stderr = "";
      let header: { duration: number; sourceStart: number; width: number; height: number; sampleInterval: number; total: number } | null = null;
      const samples: VisualSample[] = [];
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
      const timeout = setTimeout(() => stop(new Error("Visual indexing took too long. Try a shorter clip.")), this.options.runTimeoutMs ?? 20 * 60_000);
      const finish = (error?: Error, result?: VisualAnalysis) => {
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
        if (!record || typeof record !== "object" || Array.isArray(record) || complete) throw new Error("Invalid visual indexing output.");
        if (record.type === "header" && !header) {
          const { duration, sourceStart, width, height, sampleInterval, total } = record;
          if (!finite(duration) || duration <= 0 || Math.abs(request.duration - duration) > 0.001 ||
            !finite(sourceStart) || Math.abs(sourceStart - request.sourceStart) > 0.000001 ||
            !finite(width) || !Number.isInteger(width) || width < 1 || width > 65536 ||
            !finite(height) || !Number.isInteger(height) || height < 1 || height > 65536 ||
            sampleInterval !== request.sampleInterval || !finite(total) || !Number.isInteger(total) || total < 1 || total > VISUAL_MAX_SAMPLES ||
            total !== request.endIndex - request.startIndex) throw new Error("Invalid visual indexing metadata.");
          header = { duration, sourceStart, width, height, sampleInterval, total };
          report();
        } else if (record.type === "sample" && header) {
          if (!finite(record.time) || record.time < 0 || record.time >= request.duration || record.time < (samples.at(-1)?.time ?? -1) ||
            !finite(record.mediaTime) || Math.abs(record.mediaTime - request.sourceStart - record.time) > 0.000001 ||
            Math.abs(record.time - ((request.startIndex + samples.length) * request.sampleInterval)) > request.sampleInterval ||
            samples.length >= header.total) throw new Error("Invalid visual indexing sample.");
          const evidence = (value: unknown, max: number) => {
            if (!Array.isArray(value) || value.length > max) throw new Error("Invalid visual evidence.");
            return value.map((item) => {
              if (!item || typeof item !== "object" || typeof item.text !== "string" || !item.text.trim() || item.text.length > 480 ||
                !finite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error("Invalid visual evidence.");
              return { text: item.text, confidence: item.confidence };
            });
          };
          if (!finite(record.people) || !Number.isInteger(record.people) || record.people < 0 || record.people > 32) throw new Error("Invalid person count.");
          samples.push({ time: record.time, mediaTime: record.mediaTime, labels: evidence(record.labels, 24), text: evidence(record.text, 40), people: record.people });
          report();
        } else if (record.type === "done" && header && record.completed === header.total && samples.length === header.total) {
          complete = true;
        } else throw new Error("Incomplete or out-of-order visual indexing output.");
      };
      child.stdout.on("data", (data: Buffer) => {
        if (failure) return;
        outputBytes += data.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { stop(new Error("Visual indexing returned too much data.")); return; }
        buffered += decoder.write(data);
        try {
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const next = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
            if (next.trim()) line(next);
            if (failure) break;
          }
        } catch (error) { stop(error instanceof Error ? error : new Error("Invalid visual indexing output.")); }
      });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-16_384); });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        buffered += decoder.end();
        if (failure) { finish(failure); return; }
        if (code !== 0) { finish(new Error(stderr.trim() || "The local visual indexing helper failed.")); return; }
        if (buffered.trim() || !header || !complete) { finish(new Error("The visual indexing helper returned an incomplete result.")); return; }
        const { duration, sourceStart, width, height, sampleInterval } = header;
        try { finish(undefined, validateVisualAnalysis({ duration, sourceStart, width, height, sampleInterval, samples }, request.duration, request.sourceStart, request)); }
        catch (error) { finish(error instanceof Error ? error : new Error('Invalid visual index.')); }
      });
    });
  }
}
