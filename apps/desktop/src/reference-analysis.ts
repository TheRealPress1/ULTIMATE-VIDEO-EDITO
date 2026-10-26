import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { validateReferenceAnalysis } from "./reference-profile";
import type { ReferenceAnalysis, ReferenceProgress } from "./reference-types";
export type ReferenceAnalyzerOptions = {
  runtimePath: string;
  runTimeoutMs?: number;
  killGraceMs?: number;
};
export type ReferenceAnalysisRequest = {
  id: string;
  path: string;
  duration: number;
  sourceStart?: number;
};
const signature = (s: Awaited<ReturnType<typeof stat>>) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export class LocalReferenceAnalyzer {
  private active?: { id: string; controller: AbortController };
  private disposed = false;
  private readonly options: ReferenceAnalyzerOptions;
  constructor(options: ReferenceAnalyzerOptions) {
    this.options = options;
  }
  cancel(id: string) {
    if (this.active?.id === id)
      this.active.controller.abort(new Error("Reference analysis cancelled."));
  }
  dispose() {
    this.disposed = true;
    if (this.active) this.cancel(this.active.id);
  }
  async analyze(
    request: ReferenceAnalysisRequest,
    onProgress?: (value: ReferenceProgress) => void,
  ): Promise<ReferenceAnalysis> {
    if (this.disposed) throw new Error("Reference analysis has closed.");
    if (this.active) throw new Error("Another reference is being analyzed.");
    if (
      !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
        request.id,
      ) ||
      !isAbsolute(request.path) ||
      request.path.includes("\0") ||
      !Number.isFinite(request.duration) ||
      request.duration <= 0 ||
      request.duration > 86400 ||
      !Number.isFinite(request.sourceStart ?? 0) ||
      (request.sourceStart ?? 0) < 0 ||
      (request.sourceStart ?? 0) > 86400
    )
      throw new Error("Invalid local reference request.");
    const task = { id: request.id, controller: new AbortController() };
    this.active = task;
    try {
      if (
        process.platform !== "darwin" ||
        !(await access(this.options.runtimePath, constants.X_OK).then(
          () => true,
          () => false,
        ))
      )
        throw new Error(
          "Reference analysis needs the bundled macOS reference helper.",
        );
      task.controller.signal.throwIfAborted();
      const path = await realpath(request.path),
        before = await stat(path);
      if (!before.isFile() || before.size === 0)
        throw new Error("Choose a readable reference video.");
      const result = await this.run(
        { ...request, path },
        task.controller.signal,
        onProgress,
      );
      task.controller.signal.throwIfAborted();
      if (signature(before) !== signature(await stat(path)))
        throw new Error(
          "The reference changed during analysis. Analyze its current version.",
        );
      return result;
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
  private run(
    request: ReferenceAnalysisRequest,
    signal: AbortSignal,
    onProgress?: (value: ReferenceProgress) => void,
  ): Promise<ReferenceAnalysis> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.options.runtimePath,
        [
          request.path,
          String(request.duration),
          String(request.sourceStart ?? 0),
        ],
        { shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      let text = "",
        stderr = "",
        bytes = 0,
        result: ReferenceAnalysis | undefined,
        finished = false,
        failure: Error | undefined,
        last = 0;
      const decoder = new StringDecoder("utf8");
      let kill: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        child.kill("SIGTERM");
        kill = setTimeout(
          () => child.kill("SIGKILL"),
          this.options.killGraceMs ?? 1000,
        );
      };
      const abort = () =>
        stop(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Reference analysis cancelled."),
        );
      const timeout = setTimeout(
        () =>
          stop(
            new Error(
              "Reference analysis took too long. Try a shorter reference.",
            ),
          ),
        this.options.runTimeoutMs ?? 15 * 60000,
      );
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearTimeout(kill);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const line = (raw: string) => {
        const data = JSON.parse(raw);
        if (result)
          throw new Error("Unexpected output after reference result.");
        if (data.type === "progress") {
          const total = Math.ceil(
            Math.min(request.duration, 120) / 0.25 - 1e-9,
          );
          if (
            data.total !== total ||
            data.completed !== last + 1 ||
            data.completed > total
          )
            throw new Error("Invalid reference progress.");
          last = data.completed;
          try {
            onProgress?.({ id: request.id, completed: last, total });
          } catch {
            /* Renderer lifecycle must not break process cleanup. */
          }
        } else if (data.type === "result") {
          result = validateReferenceAnalysis(
            data.analysis,
            request.duration,
            request.sourceStart ?? 0,
          );
          if (last !== result.samples.length)
            throw new Error("Incomplete reference analysis.");
        } else throw new Error("Invalid reference helper output.");
      };
      child.stdout.on("data", (data: Buffer) => {
        if (failure) return;
        bytes += data.length;
        if (bytes > 8 * 1024 * 1024) {
          stop(new Error("Reference analysis returned too much data."));
          return;
        }
        text += decoder.write(data);
        try {
          let newline: number;
          while ((newline = text.indexOf("\n")) >= 0) {
            const value = text.slice(0, newline);
            text = text.slice(newline + 1);
            if (value.trim()) line(value);
          }
        } catch (error) {
          stop(
            error instanceof Error
              ? error
              : new Error("Invalid reference evidence."),
          );
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString("utf8")).slice(-16000);
      });
      child.on("error", finish);
      child.on("close", (code) => {
        text += decoder.end();
        if (failure) {
          finish(failure);
          return;
        }
        if (code !== 0) {
          finish(new Error(stderr.trim() || "Reference helper failed."));
          return;
        }
        if (text.trim() || !result) {
          finish(new Error("Reference analysis was incomplete."));
          return;
        }
        finish();
      });
    });
  }
}
