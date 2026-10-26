import { getAssetFile } from '@diffusionstudio/runtime';
import type { Asset } from '@diffusionstudio/assets';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { requestFootage } from './footage-cache';
import { transcribeLocally, type LocalTranscriptionOptions } from './local-transcription';
import type { SpeechSegment } from '@desktop/speech-types';

/** Original-file transcription, including persistent resume for a complete local source. */
export async function transcribeSource(asset: Extract<Asset, { type: 'AUDIO' | 'VIDEO' }>, options: LocalTranscriptionOptions & { dir?: string } = {}): Promise<SpeechSegment[]> {
  const check = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  check();
  const full = !options.window || (options.window.start === 0 && options.window.end === asset.duration);
  const local = !/^[a-z][a-z\d+.-]*:/i.test(asset.source) && !asset.source.startsWith('\\\\');
  const request = options.dir && full && local && !options.language ? { dir: options.dir, source: asset.source, duration: asset.duration } : undefined;
  const cached = request ? await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_GET, request, options.signal) : undefined;
  check();
  if (cached?.transcript) return cached.transcript;
  const file = await getAssetFile(asset, true); check();
  const segments = await transcribeLocally(file, { ...options, sourceDuration: asset.duration,
    ...(cached && request ? { cache: { ...request, expectedFingerprint: cached.fingerprint } } : {}),
  });
  check();
  if (cached && request) {
    const saved = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_PUT, { ...request, expectedFingerprint: cached.fingerprint, transcript: segments }, options.signal);
    check(); return saved.transcript ?? segments;
  }
  return segments;
}
