import { AssetId, getAsset, getEntityTree, getLibrary, FrameRate } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';
import type { SpeechSegment } from '@desktop/speech-types';
import type { AnalysisCacheRequest } from '@desktop/analysis-cache-types';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { speechChunks, mergeSpeechChunks, type SpeechChunk } from '@desktop/speech-chunks';
import { mainBridge } from '@/lib/ipc';
import { transcribeLocally } from '@/lib/local-transcription';
import { encodeSceneAudio } from './scene-audio';
const ENGINE = 'scene-whisper-base-overlap-v2';
const SECTION_SECONDS = 120;
function cachedSpeech(value: unknown, window: SpeechChunk): SpeechSegment[] | undefined {
  if (!Array.isArray(value) || value.length > 5000) return;
  let previous = -Infinity, words = 0;
  const copied: SpeechSegment[] = [];
  for (const segment of value) {
    if (!segment || typeof segment !== 'object' || typeof segment.text !== 'string' || !Array.isArray(segment.words)) return;
    const next: SpeechSegment = { text: segment.text, words: [] };
    for (const word of segment.words) {
      if (++words > 10000 || !word || typeof word.text !== 'string' || !word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < window.start - .05 || word.end > window.end + .05 || word.end <= word.start || word.start < previous) return;
      previous = word.start; next.words.push({ text: word.text, start: word.start, end: word.end });
    }
    copied.push(next);
  }
  return copied;
}
async function cacheCall(request: AnalysisCacheRequest, signal: AbortSignal, put?: { fingerprint: string; chunk: string; value: SpeechSegment[] }) {
  signal.throwIfAborted(); const id = crypto.randomUUID();
  const cancel = () => { void mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_CANCEL, { id }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = put ? await mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_PUT, { ...request, ...put, id }) : await mainBridge.call(MAIN_CHANNELS.ANALYSIS_CACHE_GET, { ...request, id });
    signal.throwIfAborted(); return result;
  } finally { signal.removeEventListener('abort', cancel); }
}

/** Long-scene caption analysis; authored caption assets are only replaced after all sections succeed. */
export async function transcribeSceneSections(world: World, scene: Entity, dir: string | undefined, options: {
  duration: number; snapshot: string; signal: AbortSignal; assertCurrent: () => void; onProgress: (message: string, fraction?: number | null) => void;
}): Promise<SpeechSegment[]> {
  const { signal, assertCurrent, onProgress, duration } = options, library = getLibrary(world);
  signal.throwIfAborted(); assertCurrent();
  const sources = new Map<string, { id: string; size: number; mtime: number }>();
  for (const node of getEntityTree(world, scene)) {
    const id = node.get(AssetId)?.value; if (!id) continue;
    const asset = getAsset(world, id); if (!asset || (asset.type !== 'AUDIO' && asset.type !== 'VIDEO') || sources.has(asset.source)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(asset.source)) throw new Error('Download scene media locally before resumable caption analysis.');
    const stat = await library.fs.stat(asset.source); assertCurrent();
    if (!stat || (asset.stat && (stat.size !== asset.stat.size || Math.floor(stat.mtime) !== Math.floor(asset.stat.mtime)))) throw new Error('A source changed before caption analysis. Refresh its media link.');
    sources.set(asset.source, { id, size: stat.size, mtime: stat.mtime });
  }
  const current = async () => {
    signal.throwIfAborted(); assertCurrent();
    for (const [source, expected] of sources) {
      const asset = library.get(expected.id), stat = await library.fs.stat(source); assertCurrent();
      if (!asset || asset.source !== source || !stat || stat.size !== expected.size || stat.mtime !== expected.mtime) throw new Error('Scene media changed during caption analysis. Start again with the current source.');
    }
  };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.snapshot)));
  const hash = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const request = dir ? { dir, key: JSON.stringify([ENGINE, hash, world.get(FrameRate)?.value ?? 30, duration, SECTION_SECONDS]), sources: [...sources.keys()] } : undefined;
  onProgress('Checking saved caption sections');
  const saved = request ? await cacheCall(request, signal) : undefined; await current();
  const windows = speechChunks(duration, 0, duration, SECTION_SECONDS), results: { window: SpeechChunk; segments: SpeechSegment[] }[] = [];
  for (const window of windows) {
    await current();
    const key = `speech-${window.index}`;
    let segments = cachedSpeech(saved?.chunks[key], window);
    if (segments) onProgress(`Resuming caption section ${window.index + 1} of ${windows.length}`, (window.index + 1) / windows.length);
    else {
      const audio = await encodeSceneAudio(world, scene, dir, { signal, window: { start: window.start, end: window.end }, onProgress: fraction => onProgress(`Mixing caption section ${window.index + 1} of ${windows.length}`, (window.index + fraction * .1) / windows.length) });
      await current();
      const result = await transcribeLocally(audio, { signal, assertCurrent, onProgress: progress => onProgress(`Transcribing caption section ${window.index + 1} of ${windows.length}`, progress.progress === null ? null : (window.index + .1 + progress.progress * .9) / windows.length) });
      await current();
      segments = result.map(segment => ({ text: segment.text, words: segment.words.map(word => ({ text: word.text, start: word.start + window.start, end: Math.min(window.end, word.end + window.start) })).filter(word => word.end > word.start) })).filter(segment => segment.words.length);
      if (request && saved) { await cacheCall(request, signal, { fingerprint: saved.fingerprint, chunk: key, value: segments }); await current(); }
    }
    results.push({ window, segments });
  }
  await current(); return mergeSpeechChunks(results, 0, duration);
}
