import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { SpeakerAnalysisProgress, SpeakerAnalysisResult } from '@desktop/speaker-types';
import { mainBridge } from './ipc';
const listeners = new Map<string, (progress: SpeakerAnalysisProgress) => void>();
let stop: (() => void) | undefined;
export async function analyzeSpeakersLocally(dir: string, source: string, start: number, end: number, options: {
  sourceStart?: number; signal?: AbortSignal; onProgress?: (progress: SpeakerAnalysisProgress) => void;
} = {}): Promise<SpeakerAnalysisResult> {
  const { signal } = options; signal?.throwIfAborted();
  const id = crypto.randomUUID();
  listeners.set(id, (progress) => { if (!signal?.aborted) options.onProgress?.(progress); });
  stop ??= mainBridge.handle(MAIN_CHANNELS.SPEAKER_PROGRESS, (progress) => listeners.get(progress.id)?.(progress));
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.SPEAKER_CANCEL, { id }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await mainBridge.call(MAIN_CHANNELS.SPEAKER_ANALYZE, { id, dir, source, start, end, ...(options.sourceStart === undefined ? {} : { sourceStart: options.sourceStart }) });
    signal?.throwIfAborted(); return result;
  } catch (error) { signal?.throwIfAborted(); throw error; }
  finally { signal?.removeEventListener('abort', cancel); listeners.delete(id); if (!listeners.size) { stop?.(); stop = undefined; } }
}
