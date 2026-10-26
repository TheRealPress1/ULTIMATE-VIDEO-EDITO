import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { VisualIndexRequest, VisualIndexResult, VisualProgress } from '@desktop/visual-types';
import { mainBridge } from './ipc';
const listeners = new Map<string, (progress: VisualProgress) => void>();
let stop: (() => void) | undefined;

export async function indexVisualLocally(request: VisualIndexRequest, options: {
  signal?: AbortSignal; onProgress?: (progress: VisualProgress) => void;
} = {}): Promise<VisualIndexResult> {
  options.signal?.throwIfAborted();
  const id = crypto.randomUUID();
  listeners.set(id, (progress) => { if (!options.signal?.aborted) options.onProgress?.(progress); });
  stop ??= mainBridge.handle(MAIN_CHANNELS.VISUAL_PROGRESS, (progress) => listeners.get(progress.id)?.(progress));
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.VISUAL_CANCEL, { id }).catch(() => {}); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await mainBridge.call(MAIN_CHANNELS.VISUAL_INDEX, { ...request, id });
    options.signal?.throwIfAborted();
    return result;
  } catch (error) { options.signal?.throwIfAborted(); throw error; }
  finally {
    options.signal?.removeEventListener('abort', cancel);
    listeners.delete(id);
    if (!listeners.size) { stop?.(); stop = undefined; }
  }
}
