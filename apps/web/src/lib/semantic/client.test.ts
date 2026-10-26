import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SemanticClient } from './client';
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.all.push(this); }
  result(data: unknown) { this.onmessage?.({ data }); }
}
beforeEach(() => { FakeWorker.all = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => vi.unstubAllGlobals());
describe('semantic worker lifecycle', () => {
  it('does not spawn or download until requested and forwards progress/results', async () => {
    const client = new SemanticClient(); expect(FakeWorker.all).toHaveLength(0);
    const progress = vi.fn(); const pending = client.request<boolean>({ type: 'status' }, { progress });
    const worker = FakeWorker.all[0]!; expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, type: 'status' }, []);
    worker.result({ id: 1, progress: { completed: 1, total: 2, label: 'test' } }); expect(progress).toHaveBeenCalledOnce();
    worker.result({ id: 1, result: false }); expect(await pending).toBe(false); client.dispose();
  });
  it('terminates pending work immediately on cancellation and permits a clean retry', async () => {
    const client = new SemanticClient(); const controller = new AbortController();
    const pending = client.request({ type: 'prepare', download: true }, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejection; expect(FakeWorker.all[0]!.terminate).toHaveBeenCalledOnce();
    const retry = client.request<boolean>({ type: 'status' }); expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1]!.result({ id: 2, result: false }); expect(await retry).toBe(false); client.dispose();
  });
  it('rejects worker crashes and does not leave pending promises or aborted jobs running', async () => {
    const client = new SemanticClient(); const pending = client.request({ type: 'text', text: 'ocean' });
    const rejection = expect(pending).rejects.toThrow('crash'); FakeWorker.all[0]!.onerror?.({ message: 'crash' }); await rejection;
    expect(() => client.request({ type: 'status' }, { signal: AbortSignal.abort() })).toThrow();
    expect(FakeWorker.all).toHaveLength(1); client.dispose();
  });
});
