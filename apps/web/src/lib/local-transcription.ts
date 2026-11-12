/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output, WavOutputFormat } from 'mediabunny';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE } from '@desktop/speech-types';
import { mergeSpeechChunks, speechChunks, SPEECH_CHUNK_MAX_SECONDS, type SpeechChunk } from '@desktop/speech-chunks';
import { mainBridge } from './ipc';
import { requestFootage } from './footage-cache';
import type { SpeechProgress, SpeechQuality, SpeechSegment } from '@desktop/speech-types';
import type { FootageChunkRequest, FootageChunksResult } from '@desktop/footage-types';

export const MAX_TRANSCRIPTION_SECONDS = SPEECH_MAX_SECONDS;
const MAX_WAV_BYTES = SPEECH_CHUNK_MAX_SECONDS * SPEECH_SAMPLE_RATE * 2 + 65_536;
type ProgressListener = (progress: SpeechProgress) => void;
const listeners = new Map<string, ProgressListener>();
let stopProgress: (() => void) | undefined;
function subscribe(id: string, listener: ProgressListener): () => void {
  listeners.set(id, listener);
  stopProgress ??= mainBridge.handle(MAIN_CHANNELS.SPEECH_PROGRESS, event => listeners.get(event.id)?.(event));
  return () => { listeners.delete(id); if (!listeners.size) { stopProgress?.(); stopProgress = undefined; } };
}
function canceled(): DOMException { return new DOMException('Transcription canceled.', 'AbortError'); }
export function isTranscriptionCanceled(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }
export interface LocalTranscriptionOptions {
  signal?: AbortSignal;
  onProgress?: ProgressListener;
  language?: string;
  /** fast (Whisper base, the default) or accurate (Whisper large-v3-turbo, downloaded on its first request). */
  quality?: SpeechQuality;
  /** Source seconds; returned word times remain source-relative. */
  window?: { start: number; end: number };
  /** Original asset duration, including silent video tails and delayed audio. */
  sourceDuration?: number;
  /** A source fingerprint checked by the main process before decoding. Full-source windows only. */
  cache?: FootageChunkRequest;
  /** Guards navigation/relinking before persistent writes and between sections. */
  assertCurrent?: () => void;
}
export async function assertLocalTranscriptionAvailable(): Promise<void> {
  if (!window.desktop) throw new Error('Local transcription is available in the Blackout desktop app.');
  const status = await mainBridge.call(MAIN_CHANNELS.SPEECH_STATUS, undefined);
  if (!status.available) throw new Error(status.error || 'Local transcription is not installed. Rebuild or update Blackout and try again.');
}

/** Bounded five-minute PCM sections; original compressed media is never loaded whole. */
export async function transcribeLocally(audio: Blob, options: LocalTranscriptionOptions = {}): Promise<SpeechSegment[]> {
  const { signal, onProgress } = options;
  const language = options.language ?? options.cache?.language;
  const check = () => { if (signal?.aborted) throw canceled(); options.assertCurrent?.(); };
  check(); await assertLocalTranscriptionAvailable(); check();
  const id = crypto.randomUUID();
  let total = 1, completed = 0, resumed = 0;
  const report = (event: SpeechProgress) => {
    if (signal?.aborted) return;
    const fraction = event.progress === null ? null : (completed + (event.stage === 'preparing' ? event.progress * 0.1 : 0.1 + event.progress * 0.9)) / total;
    onProgress?.({ ...event, id, progress: total === 1 ? event.progress : fraction,
      message: total === 1 ? event.message : `${event.message} · section ${Math.min(completed + 1, total)} of ${total}${resumed ? ` · ${resumed} resumed` : ''}`,
      completedChunks: completed, totalChunks: total, resumedChunks: resumed });
  };
  const unsubscribe = subscribe(id, report);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(audio) });
  let conversion: Conversion | undefined, nativeStarted = false;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; }); void aborted.catch(() => {});
  const onAbort = () => {
    rejectAbort?.(canceled()); void conversion?.cancel().catch(() => {});
    if (nativeStarted) void mainBridge.call(MAIN_CHANNELS.SPEECH_CANCEL, { id }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    report({ id, stage: 'preparing', progress: 0, message: 'Reading local speech sections' });
    const track = await input.getPrimaryAudioTrack(); check();
    if (!track) throw new Error('This file has no audio track to transcribe.');
    const [audioEnd, audioFirst, video] = await Promise.all([
      track.computeDuration(), track.getFirstTimestamp?.() ?? Promise.resolve(0),
      input.getPrimaryVideoTrack?.() ?? Promise.resolve(null),
    ]); check();
    const origin = Math.max(0, video ? await video.getFirstTimestamp() : audioFirst);
    const duration = options.cache?.duration ?? options.sourceDuration ?? Math.max(0, audioEnd - origin);
    check();
    if (![duration, origin, audioFirst, audioEnd].every(Number.isFinite) || duration <= 0) throw new Error('This file has no readable audio to transcribe.');
    const from = options.window?.start ?? 0, to = Math.min(options.window?.end ?? duration, duration);
    // The limit is on what one call decodes: a window of a longer recording is fine.
    if (to - from > MAX_TRANSCRIPTION_SECONDS) {
      throw new Error(options.window ? 'Local transcription supports windows up to two hours.' : 'Local transcription supports recordings up to two hours; transcribe a longer one in windows.');
    }
    const windows = speechChunks(duration, from, to); total = windows.length;
    if (options.cache && (from !== 0 || to !== duration)) throw new Error('Persistent speech sections require the full source window.');
    if (options.cache && options.quality === 'accurate') throw new Error('Persistent speech sections are kept for the fast model only.');
    let saved: FootageChunksResult | undefined;
    if (options.cache) { saved = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_CHUNKS_GET, options.cache, signal); check(); }
    const results: { window: SpeechChunk; segments: SpeechSegment[] }[] = [];
    for (const window of windows) {
      check(); completed = results.length;
      const cached = saved?.chunks[window.index];
      if (cached !== undefined) {
        results.push({ window, segments: cached }); resumed++;
        onProgress?.({ id, stage: 'transcribing', progress: results.length / total, message: `Resuming saved speech · section ${results.length} of ${total}`, completedChunks: results.length, totalChunks: total, resumedChunks: resumed });
        continue;
      }
      const trimStart = Math.max(origin + window.start, audioFirst, 0), trimEnd = Math.min(origin + window.end, audioEnd);
      let segments: SpeechSegment[] = [];
      if (trimEnd > trimStart) {
        report({ id, stage: 'preparing', progress: 0, message: 'Preparing audio on your Mac' });
        const target = new BufferTarget();
        conversion = await Conversion.init({ input, output: new Output({ format: new WavOutputFormat(), target }),
          tracks: 'primary', video: { discard: true }, audio: { codec: 'pcm-s16', sampleRate: SPEECH_SAMPLE_RATE, numberOfChannels: 1 },
          trim: { start: trimStart, end: trimEnd }, showWarnings: false });
        if (signal?.aborted) { await conversion.cancel(); throw canceled(); }
        check();
        if (!conversion.isValid) throw new Error('Could not decode this audio. Try importing a WAV, MP3, M4A, or MP4 file.');
        conversion.onProgress = progress => report({ id, stage: 'preparing', progress: Math.max(0, Math.min(1, progress)), message: 'Preparing audio on your Mac' });
        await conversion.execute(); check(); conversion = undefined;
        if (!target.buffer?.byteLength || target.buffer.byteLength > MAX_WAV_BYTES) throw new Error('This speech section could not be prepared within its memory limit.');
        nativeStarted = true;
        const request = mainBridge.call(MAIN_CHANNELS.SPEECH_TRANSCRIBE, { id, audio: new Uint8Array(target.buffer), ...(language ? { language } : {}), ...(options.quality === 'accurate' ? { quality: options.quality } : {}) });
        const result = await Promise.race([request, aborted]); nativeStarted = false; check();
        const shift = trimStart - origin;
        segments = result.segments.map(segment => ({ text: segment.text, words: segment.words.map(word => ({ text: word.text, start: word.start + shift, end: Math.min(trimEnd - origin, word.end + shift) })).filter(word => word.end > word.start) })).filter(segment => segment.words.length);
      }
      if (options.cache) {
        check(); saved = await requestFootage(MAIN_CHANNELS.FOOTAGE_INDEX_CHUNK_PUT, { ...options.cache, index: window.index, transcript: segments }, signal); check();
      }
      results.push({ window, segments });
      onProgress?.({ id, stage: 'transcribing', progress: results.length / total, message: `Speech section ${results.length} of ${total} ${options.cache ? 'saved' : 'processed'}`, completedChunks: results.length, totalChunks: total, resumedChunks: resumed });
    }
    check();
    // A single section retains the recognizer's natural phrase grouping.
    return results.length === 1 ? results[0]!.segments : mergeSpeechChunks(results, from, to);
  } catch (error) { if (signal?.aborted) throw canceled(); throw error; }
  finally { signal?.removeEventListener('abort', onAbort); unsubscribe(); input.dispose(); }
}
