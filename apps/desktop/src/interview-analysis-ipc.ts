import { app, BrowserWindow, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadFootageTranscript, saveFootageTranscript, loadFootageChunks, saveFootageChunk } from './footage-index';
import { mainBridge } from './main-manager';
import { MAIN_CHANNELS } from './main-channels';
import { realPathEntry } from './projects';
import { LocalSpeakerAnalysisService } from './speaker-analysis';
import { LocalAnalysisCache } from './analysis-cache';

/** Local jobs are canceled when their renderer navigates, crashes or closes. */
export function registerInterviewAnalysis(): void {
  const speakers = new LocalSpeakerAnalysisService({ runtimePath: join(app.getAppPath(), 'dist', 'speaker-analysis'), modelPath: join(app.getAppPath(), 'dist', 'speaker-model.mlmodelc') });
  const cache = new LocalAnalysisCache();
  const owners = new Map<string, { renderer: number; cancel: () => void }>();
  async function owned<T>(key: string, event: IpcMainEvent, cancelJob: () => void, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (owners.has(key)) throw new Error('This analysis job is already running.');
    const controller = new AbortController(), sender = event.sender;
    const cancel = () => { controller.abort(new Error('Analysis canceled.')); cancelJob(); };
    owners.set(key, { renderer: sender.id, cancel });
    sender.once('destroyed', cancel); sender.once('render-process-gone', cancel); sender.once('did-start-loading', cancel);
    try { const result = await run(controller.signal); controller.signal.throwIfAborted(); return result; }
    finally {
      owners.delete(key); sender.removeListener('destroyed', cancel); sender.removeListener('render-process-gone', cancel); sender.removeListener('did-start-loading', cancel);
    }
  }
  const cancel = (key: string, event: IpcMainEvent) => { const owner = owners.get(key); if (owner?.renderer === event.sender.id) owner.cancel(); };
  const requestId = (id?: string) => {
    if (id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid analysis request identifier.');
    return id ?? randomUUID();
  };
  mainBridge.handle(MAIN_CHANNELS.FOOTAGE_INDEX_GET, (request, event) => owned(`footage:${requestId(request.id)}`, event, () => {}, (signal) => loadFootageTranscript(request, signal)));
  mainBridge.handle(MAIN_CHANNELS.FOOTAGE_INDEX_PUT, (request, event) => owned(`footage:${requestId(request.id)}`, event, () => {}, (signal) => saveFootageTranscript(request, signal)));
  mainBridge.handle(MAIN_CHANNELS.FOOTAGE_INDEX_CHUNKS_GET, (request, event) => owned(`footage:${requestId(request.id)}`, event, () => {}, (signal) => loadFootageChunks(request, signal)));
  mainBridge.handle(MAIN_CHANNELS.FOOTAGE_INDEX_CHUNK_PUT, (request, event) => owned(`footage:${requestId(request.id)}`, event, () => {}, (signal) => saveFootageChunk(request, signal)));
  mainBridge.handle(MAIN_CHANNELS.FOOTAGE_INDEX_CANCEL, ({ id }, event) => cancel(`footage:${id}`, event));
  mainBridge.handle(MAIN_CHANNELS.SPEAKER_ANALYZE, (request, event) => owned(`speaker:${request.id}`, event, () => speakers.cancel(request.id), async (signal) => {
    const path = await realPathEntry(request.dir, request.source); signal.throwIfAborted();
    if (!path) throw new Error('Relink this footage locally before following its speakers.');
    const result = await speakers.analyze({ ...request, path }, (progress) => {
      if (!signal.aborted && !event.sender.isDestroyed()) mainBridge.emit(BrowserWindow.fromWebContents(event.sender), MAIN_CHANNELS.SPEAKER_PROGRESS, progress);
    });
    signal.throwIfAborted(); return result;
  }));
  mainBridge.handle(MAIN_CHANNELS.SPEAKER_CANCEL, ({ id }, event) => cancel(`speaker:${id}`, event));
  mainBridge.handle(MAIN_CHANNELS.ANALYSIS_CACHE_GET, (request, event) => owned(`cache:${requestId(request.id)}`, event, () => {}, (signal) => cache.get(request, signal)));
  mainBridge.handle(MAIN_CHANNELS.ANALYSIS_CACHE_PUT, (request, event) => owned(`cache:${requestId(request.id)}`, event, () => {}, (signal) => cache.put(request, signal)));
  mainBridge.handle(MAIN_CHANNELS.ANALYSIS_CACHE_CANCEL, ({ id }, event) => cancel(`cache:${id}`, event));
  app.on('will-quit', () => { speakers.dispose(); for (const owner of owners.values()) owner.cancel(); });
}
