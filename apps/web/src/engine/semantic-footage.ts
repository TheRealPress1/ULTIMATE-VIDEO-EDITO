import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { SemanticClient, type SemanticProgress } from '@/lib/semantic/client';
import { readSemanticRecord, writeSemanticRecord } from '@/lib/semantic/cache';
import { CLIP_KEY } from '@/lib/semantic/model';
import { normalizeVector, rankSemanticFrames, semanticKey, type SemanticRecord } from '@/lib/semantic/math';
import type { VisualService, VisualMatch, VisualItem } from './visual-footage';

export type SemanticSnapshot = { available: boolean; busy: boolean; progress?: SemanticProgress; error?: string; indexedFrames: number };
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const MAX_FRAMES = 20_000;
/** Project-bound owner. Native source hashes and exact observed times bind every embedding. */
export class SemanticFootage {
  private state: SemanticSnapshot = { available: false, busy: false, indexedFrames: 0 };
  private listeners = new Set<() => void>();
  private client = new SemanticClient();
  private controller?: AbortController;
  constructor(private readonly visual: VisualService) {}
  snapshot = (): SemanticSnapshot => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => this.listeners.delete(callback); };
  private publish(patch: Partial<SemanticSnapshot>): void {
    if (this.visual.disposed) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  async status(): Promise<void> {
    if (this.controller) return;
    this.visual.assertCurrent();
    const available = await this.client.request<boolean>({ type: 'status' });
    this.visual.assertCurrent(); this.publish({ available });
  }
  private async operation<T>(run: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    if (this.controller) throw new Error('Description processing is busy. Wait or cancel it first.');
    const controller = new AbortController(); this.controller = controller;
    const cancel = () => controller.abort();
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    this.publish({ busy: true, error: undefined, progress: undefined });
    try { this.guard(controller.signal); return await run(controller.signal); }
    catch (error) { this.publish({ error: errorText(error) }); throw error; }
    finally { externalSignal?.removeEventListener('abort', cancel); this.controller = undefined; this.publish({ busy: false, progress: undefined }); }
  }
  private guard(signal: AbortSignal): void { signal.throwIfAborted(); this.visual.assertCurrent(); }
  private async prepare(download: boolean, signal: AbortSignal): Promise<boolean> {
    try { return await this.client.request<boolean>({ type: 'prepare', download }, { signal, progress: (progress) => this.publish({ progress }) }); }
    catch (error) { this.publish({ available: false }); throw error; }
  }
  /** Only this explicit UI action can download model files. Tools never call it. */
  download(): Promise<void> {
    return this.operation(async (signal) => { await this.prepare(true, signal); this.guard(signal); this.publish({ available: true }); });
  }
  index(paths?: string[], externalSignal?: AbortSignal): Promise<void> {
    return this.operation(async (signal) => {
      await this.prepare(false, signal); this.guard(signal);
      await this.visual.load(); this.guard(signal);
      const items = this.visual.snapshot().items.filter((item) => item.status === 'ready' && item.analysis && item.fingerprint && (!paths || paths.includes(item.assetId) || paths.includes(item.path)));
      if (!items.length) throw new Error('Index visuals for these videos first.');
      const total = items.reduce((sum, item) => sum + item.analysis!.samples.length, 0);
      if (total > MAX_FRAMES) throw new Error('Select fewer videos: description indexing supports 20,000 sampled frames per batch.');
      let completed = 0;
      const failures: string[] = [];
      for (const item of items) {
        this.guard(signal);
        const times = item.analysis!.samples.map((sample) => sample.time);
        try {
          let record = await readSemanticRecord(item.fingerprint!, times); this.guard(signal);
          const match = this.reference(item);
          const asset = await this.visual.validateMatch(match); this.guard(signal);
          if (!record) {
            const file = await asset.handle.getFile(); this.guard(signal);
            const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
            const vectors: number[][] = [];
            try {
              const track = await input.getPrimaryVideoTrack();
              if (!track || !(await track.canDecode())) throw new Error('This source cannot be decoded locally for description search.');
              const first = Math.max(0, (await track.getFirstTimestamp()) ?? 0);
              if (!Number.isFinite(first) || Math.abs(first - item.analysis!.sourceStart) > 0.000001) throw new Error('The video presentation clock changed. Index its visuals again.');
              const sink = new CanvasSink(track, { width: 384 });
              let index = 0;
              // Native evidence records actual decoded PTS, not nominal sampling slots.
              // A one-microsecond nudge absorbs rational-time floating point rounding.
              for await (const frame of sink.canvasesAtTimestamps(item.analysis!.samples.map((sample) => sample.mediaTime + 0.000001))) {
                this.guard(signal);
                if (!frame) throw new Error(`No video frame at ${times[index]} seconds.`);
                if (!Number.isFinite(frame.timestamp) || Math.abs(frame.timestamp - item.analysis!.samples[index]!.mediaTime) > 0.00001) throw new Error('The local decoders returned different frames. Index this source again.');
                const context = frame.canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
                if (!context) throw new Error('The local frame canvas is unavailable.');
                const pixels = context.getImageData(0, 0, frame.canvas.width, frame.canvas.height);
                vectors.push(normalizeVector(await this.client.request<number[]>({ type: 'image', pixels: pixels.data, width: pixels.width, height: pixels.height }, { signal })));
                this.guard(signal); index++;
                this.publish({ progress: { completed: completed + index, total, label: `Indexing descriptions · ${item.path}` } });
              }
              if (vectors.length !== times.length) throw new Error('Not all sampled frames could be decoded.');
            } finally { input.dispose(); }
            // Full source SHA is checked again after decode/inference, before persistence.
            await this.visual.validateMatch(match); this.guard(signal);
            record = { key: semanticKey(item.fingerprint!), fingerprint: item.fingerprint!, model: CLIP_KEY, times, vectors, usedAt: Date.now() };
            await writeSemanticRecord(record); this.guard(signal);
          }
          completed += record.times.length;
          this.publish({ indexedFrames: completed, progress: { completed, total, label: `Indexed ${item.path}` } });
        } catch (error) { this.guard(signal); failures.push(`${item.path}: ${errorText(error)}`); }
      }
      if (failures.length) throw new Error(`Some description indexes could not finish. Completed videos are saved. ${failures.join(' · ')}`);
    }, externalSignal);
  }
  search(query: string, path?: string, externalSignal?: AbortSignal): Promise<{ matches: VisualMatch[]; unindexed: string[] }> {
    return this.operation(async (signal) => {
      if (!query.trim() || query.length > 1000) throw new Error('Enter a description under 1,000 characters.');
      if (this.visual.snapshot().indexing) throw new Error('Wait for visual indexing to finish.');
      await this.visual.load(); this.guard(signal);
      const items = this.visual.snapshot().items.filter((item) => !path || path === item.path || path === item.assetId);
      const records = new Map<string, SemanticRecord>();
      const unindexed: string[] = [];
      let total = 0;
      for (const item of items) {
        if (item.status !== 'ready' || !item.analysis || !item.fingerprint) { unindexed.push(item.path); continue; }
        const record = await readSemanticRecord(item.fingerprint, item.analysis.samples.map((sample) => sample.time)); this.guard(signal);
        if (!record || total + record.times.length > MAX_FRAMES) { unindexed.push(item.path); continue; }
        records.set(item.fingerprint, record); total += record.times.length;
      }
      if (!records.size) throw new Error('No description index is available for these sources. Download the model, then click Index descriptions.');
      await this.prepare(false, signal); this.guard(signal);
      const embedding = await this.client.request<number[]>({ type: 'text', text: query.trim() }, { signal }); this.guard(signal);
      // Loading can take a while; a source replaced during model loading must
      // never be returned with an old vector. Refresh once more before ranking.
      await this.visual.load(); this.guard(signal);
      const current = this.visual.snapshot().items.filter((item) => !path || path === item.path || path === item.assetId);
      this.publish({ indexedFrames: total });
      return { matches: rankSemanticFrames(current, records, embedding), unindexed: [...new Set([...unindexed, ...current.filter((item) => !item.fingerprint || !records.has(item.fingerprint)).map((item) => item.path)])] };
    }, externalSignal);
  }
  private reference(item: VisualItem): VisualMatch {
    return { id: '', assetId: item.assetId, path: item.path, fingerprint: item.fingerprint!, time: item.analysis!.samples[0]!.time,
      evidence: item.analysis!.samples[0]!, sourceIn: 0, sourceOut: item.analysis!.duration, score: 0, matchedTerms: [] };
  }
  cancel(): void { this.controller?.abort(); }
  dispose(): void { this.cancel(); this.client.dispose(); this.listeners.clear(); }
}
