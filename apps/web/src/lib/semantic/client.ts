import type { SemanticWorkerRequest } from './worker';
export type SemanticProgress = { completed: number; total: number; label: string };
type Request = SemanticWorkerRequest extends infer T ? T extends SemanticWorkerRequest ? Omit<T, 'id'> : never : never;
export class SemanticClient {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; progress?: (value: SemanticProgress) => void }>();
  request<T>(request: Request, options: { signal?: AbortSignal; progress?: (value: SemanticProgress) => void } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        if (data.progress) { pending.progress?.(data.progress); return; }
        this.pending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
      };
      this.worker.onerror = (error) => { this.dispose(new Error(error.message || 'Local description model failed. Retry to load it again.')); };
    }
    const id = ++this.sequence;
    const abort = () => this.dispose(new DOMException('Description processing canceled. Completed files and videos remain cached.', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => this.dispose(new Error('Description processing timed out. Retry or index a shorter source.')), 180_000);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, progress: options.progress });
      this.worker!.postMessage({ ...request, id }, request.type === 'image' ? [request.pixels.buffer] : []);
    }).finally(() => { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); });
  }
  dispose(error = new Error('Description processing stopped.')): void {
    this.worker?.terminate(); this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
