import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { ReframeAnalysisProgress, ReframeAnalysisResult } from '@desktop/reframe-types';
import { mainBridge } from './ipc';

type ProgressListener = (progress: ReframeAnalysisProgress) => void;
const listeners = new Map<string, ProgressListener>();
let stopProgress: (() => void) | undefined;

/** Dispatch by job ID: the IPC bridge supports one handler for each event channel. */
function subscribe(id: string, listener: ProgressListener): () => void {
  listeners.set(id, listener);
  stopProgress ??= mainBridge.handle(MAIN_CHANNELS.REFRAME_PROGRESS, (event) => listeners.get(event.id)?.(event));
  return () => {
    listeners.delete(id);
    if (!listeners.size) { stopProgress?.(); stopProgress = undefined; }
  };
}

export async function analyzeReframeLocally(
  dir: string, source: string, start: number, end: number,
  options: { signal?: AbortSignal; onProgress?: ProgressListener; sourceStart?: number } = {},
): Promise<ReframeAnalysisResult> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const unsubscribe = subscribe(id, (progress) => { if (!signal?.aborted) onProgress?.(progress); });
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.REFRAME_CANCEL, { id }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await mainBridge.call(MAIN_CHANNELS.REFRAME_ANALYZE, { id, dir, source, start, end, ...(options.sourceStart === undefined ? {} : { sourceStart: options.sourceStart }) });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    unsubscribe();
  }
}
