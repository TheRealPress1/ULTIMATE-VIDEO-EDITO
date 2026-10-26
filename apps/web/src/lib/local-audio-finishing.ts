import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { AudioFinishingRequest, AudioFinishingResult } from '@desktop/audio-finishing-types';
import { mainBridge } from '@/lib/ipc';
import { isDesktop } from '@/projects/host';

export async function runLocalAudioFinishing(request: Omit<AudioFinishingRequest, 'id'>, signal?: AbortSignal): Promise<AudioFinishingResult> {
  signal?.throwIfAborted();
  if (!isDesktop()) throw new Error('Audio finishing requires the desktop app with its bundled audio tools.');
  const id = crypto.randomUUID();
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.AUDIO_FINISH_CANCEL, { id }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await mainBridge.call(MAIN_CHANNELS.AUDIO_FINISH_RUN, { ...request, id });
    signal?.throwIfAborted();
    return result;
  } finally { signal?.removeEventListener('abort', cancel); }
}
