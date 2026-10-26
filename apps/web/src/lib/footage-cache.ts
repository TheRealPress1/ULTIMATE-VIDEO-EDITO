import { MAIN_CHANNELS, type MainRequestMap } from '@desktop/main-channels';
import { mainBridge } from './ipc';
type Channel = typeof MAIN_CHANNELS.FOOTAGE_INDEX_GET | typeof MAIN_CHANNELS.FOOTAGE_INDEX_PUT | typeof MAIN_CHANNELS.FOOTAGE_INDEX_CHUNKS_GET | typeof MAIN_CHANNELS.FOOTAGE_INDEX_CHUNK_PUT;

/** File fingerprinting and cache commits share the same cancellation as speech decoding. */
export async function requestFootage<C extends Channel>(channel: C, request: MainRequestMap[C]['request'], signal?: AbortSignal): Promise<MainRequestMap[C]['response']> {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.FOOTAGE_INDEX_CANCEL, { id }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await mainBridge.call(channel, { ...request, id });
    signal?.throwIfAborted(); return result;
  } finally { signal?.removeEventListener('abort', cancel); }
}
