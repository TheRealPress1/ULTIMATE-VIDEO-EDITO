import { resolve } from 'node:path';
import { LocalVisualAnalyzer, type LocalVisualAnalyzerOptions } from './visual-analysis';
import { VisualIndexStore } from './visual-index-store';
import { LocalAnalysisCache } from './analysis-cache';
import { validateVisualAnalysis } from './visual-validation';
import { visualInterval, VISUAL_CHUNK_SAMPLES, VISUAL_CHUNK_SECONDS, VISUAL_ENGINE, VISUAL_MAX_SAMPLES, type VisualAnalysis, type VisualIndexJob, type VisualIndexRequest, type VisualIndexResult, type VisualProgress } from './visual-types';

/** One native worker; full source hashes bracket scanning and bind persistent results. */
export class LocalVisualIndexService {
  private readonly store = new VisualIndexStore();
  private readonly chunks = new LocalAnalysisCache();
  private readonly analyzer: LocalVisualAnalyzer;
  private active?: { id: string; controller: AbortController };
  private disposed = false;
  constructor(options: LocalVisualAnalyzerOptions) { this.analyzer = new LocalVisualAnalyzer(options); }
  get(request: VisualIndexRequest, signal?: AbortSignal): Promise<VisualIndexResult> {
    if (this.disposed) throw new Error('Visual indexing has closed.');
    return this.store.get(request, signal);
  }
  async index(request: VisualIndexJob, onProgress?: (progress: VisualProgress) => void): Promise<VisualIndexResult> {
    if (this.disposed) throw new Error('Visual indexing has closed.');
    if (this.active) throw new Error('Visual indexing is already running. Wait or cancel it first.');
    if (!request || typeof request.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.id)) throw new Error('Invalid visual indexing job ID.');
    const task = { id: request.id, controller: new AbortController() };
    this.active = task;
    try {
      const cached = await this.store.get(request, task.controller.signal);
      task.controller.signal.throwIfAborted();
      const sampleInterval = request.sampleInterval ?? visualInterval(request.duration);
      const total = Math.ceil(request.duration / sampleInterval - 1e-9);
      if (!Number.isFinite(sampleInterval) || sampleInterval < 1 || sampleInterval > 30 || total > VISUAL_MAX_SAMPLES) throw new Error('Index at most 720 frames sampled every 1–30 seconds.');
      if (cached.analysis?.sampleInterval === sampleInterval) return cached;
      const sourceStart = request.sourceStart ?? 0;
      const chunkSize = Math.max(1, Math.min(VISUAL_CHUNK_SAMPLES, Math.floor(VISUAL_CHUNK_SECONDS / sampleInterval)));
      let analysis: VisualAnalysis | undefined;
      for (let startIndex = 0; startIndex < total; startIndex += chunkSize) {
        task.controller.signal.throwIfAborted();
        const endIndex = Math.min(total, startIndex + chunkSize), window = { startIndex, endIndex }, key = `${startIndex}-${endIndex}`;
        const cacheRequest = { dir: request.dir, sources: [request.source], key: JSON.stringify({ engine: VISUAL_ENGINE, chunks: 1, duration: request.duration, sourceStart, sampleInterval, ...window }) };
        const checkpoint = await this.chunks.get(cacheRequest, task.controller.signal);
        let section: VisualAnalysis | undefined;
        try {
          section = validateVisualAnalysis(checkpoint.chunks[key], request.duration, sourceStart, window);
          if (section.sampleInterval !== sampleInterval) section = undefined;
        } catch { /* A damaged checkpoint can be rebuilt from the original. */ }
        if (!section) {
          section = await this.analyzer.analyze({ id: request.id, path: resolve(request.dir, request.source), duration: request.duration, sourceStart, sampleInterval, ...window }, (progress) => {
            try { onProgress?.({ id: request.id, completed: startIndex + progress.completed, total }); } catch { /* Renderer progress cannot interrupt cleanup. */ }
          });
          task.controller.signal.throwIfAborted();
          await this.chunks.put({ ...cacheRequest, fingerprint: checkpoint.fingerprint, chunk: key, value: section }, task.controller.signal);
        }
        task.controller.signal.throwIfAborted();
        if (analysis && (analysis.width !== section.width || analysis.height !== section.height)) throw new Error('The video dimensions changed during visual indexing.');
        if (!analysis) analysis = { ...section, samples: [] };
        analysis.samples.push(...section.samples);
        try { onProgress?.({ id: request.id, completed: endIndex, total }); } catch { /* Ignore progress callback failures. */ }
      }
      if (!analysis) throw new Error('Visual indexing produced no frames.');
      analysis = validateVisualAnalysis(analysis, request.duration, sourceStart);
      task.controller.signal.throwIfAborted();
      return await this.store.put({ ...request, expectedFingerprint: cached.fingerprint, analysis }, task.controller.signal);
    } finally { if (this.active === task) this.active = undefined; }
  }
  cancel(id: string): void {
    if (this.active?.id !== id) return;
    this.active.controller.abort(new Error('Visual indexing cancelled.'));
    this.analyzer.cancel(id);
  }
  dispose(): void {
    this.disposed = true;
    if (this.active) this.cancel(this.active.id);
    this.analyzer.dispose();
  }
}
