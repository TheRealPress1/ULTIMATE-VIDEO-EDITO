import { resolve } from "node:path";
import { LocalReferenceAnalyzer } from "./reference-analysis";
import { ReferenceIndexStore } from "./reference-index-store";
import { buildReferenceProfile } from "./reference-profile";
import type { ReferenceAnalyzerOptions } from "./reference-analysis";
import type {
  ReferenceJob,
  ReferenceRequest,
  ReferenceResult,
  ReferenceProgress,
} from "./reference-types";
export class LocalReferenceStyleService {
  private readonly store = new ReferenceIndexStore();
  private readonly analyzer: LocalReferenceAnalyzer;
  private active?: { id: string; controller: AbortController };
  private disposed = false;
  constructor(options: ReferenceAnalyzerOptions) {
    this.analyzer = new LocalReferenceAnalyzer(options);
  }
  get(
    request: ReferenceRequest,
    signal?: AbortSignal,
  ): Promise<ReferenceResult> {
    if (this.disposed) throw new Error("Reference analysis has closed.");
    return this.store.get(request, signal);
  }
  async analyze(
    request: ReferenceJob,
    onProgress?: (p: ReferenceProgress) => void,
  ): Promise<ReferenceResult> {
    if (this.disposed) throw new Error("Reference analysis has closed.");
    if (this.active) throw new Error("Another reference is being analyzed.");
    if (
      !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
        request.id,
      )
    )
      throw new Error("Invalid reference job.");
    const task = { id: request.id, controller: new AbortController() };
    this.active = task;
    try {
      const cached = await this.store.get(request, task.controller.signal);
      task.controller.signal.throwIfAborted();
      if (cached.profile) return cached;
      const analysis = await this.analyzer.analyze(
        {
          id: request.id,
          path: resolve(request.dir, request.source),
          duration: request.duration,
          sourceStart: request.sourceStart,
        },
        onProgress,
      );
      task.controller.signal.throwIfAborted();
      return this.store.put(
        {
          ...request,
          expectedFingerprint: cached.fingerprint,
          profile: buildReferenceProfile(analysis),
        },
        task.controller.signal,
      );
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
  cancel(id: string) {
    if (this.active?.id !== id) return;
    this.active.controller.abort(new Error("Reference analysis cancelled."));
    this.analyzer.cancel(id);
  }
  dispose() {
    this.disposed = true;
    if (this.active) this.cancel(this.active.id);
    this.analyzer.dispose();
  }
}
