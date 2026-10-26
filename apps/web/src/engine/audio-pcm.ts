import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { analyzePcm, encodePcmWav } from '@/dapi/lib/audio-finish';
import { encodeScenePcm } from './scene-audio';
import type { Entity, World } from 'koota';
import type { PcmResult } from '@/dapi/lib/audio-finish';

export async function decodeFinishingAudio(file: Blob, signal: AbortSignal): Promise<PcmResult> {
  signal.throwIfAborted();
  if (file.size > 512 * 1024 * 1024) throw new Error('Audio finishing accepts files up to 512 MiB.');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const cancel = () => input.dispose();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const track = await input.getPrimaryAudioTrack(); signal.throwIfAborted();
    if (!track || !await track.canDecode()) throw new Error('The audio track is missing or cannot be decoded on this machine.');
    return await analyzePcm(new AudioBufferSink(track).buffers(0), true, signal, 256 * 1024 * 1024);
  } finally { signal.removeEventListener('abort', cancel); input.dispose(); }
}

export async function sceneAudioWav(world: World, scene: Entity, dir: string, options: { signal?: AbortSignal; onProgress?: (progress: number) => void; excludeSources?: readonly string[] } = {}): Promise<Uint8Array> {
  const signal = options.signal ?? new AbortController().signal;
  const file = await encodeScenePcm(world, scene, dir, { ...options, signal });
  signal.throwIfAborted();
  const pcm = await decodeFinishingAudio(file, signal);
  return new Uint8Array(encodePcmWav(pcm, signal));
}
