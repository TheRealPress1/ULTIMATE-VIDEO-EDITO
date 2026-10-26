/// <reference lib="webworker" />
import { env, AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import wasmUrl from '@clip-ort/ort-wasm-simd-threaded.jsep.wasm?url';
import moduleUrl from '@clip-ort/ort-wasm-simd-threaded.jsep.mjs?url';
import { CLIP_FILES, CLIP_MODEL, CLIP_REVISION, CLIP_BYTES, clipURL, verifyClipFile } from './model';
import { normalizeVector } from './math';

const CACHE = 'uve-clip-model-d15189d7';
const networkFetch = globalThis.fetch.bind(globalThis);
// Inference is offline. All network model access lives in download(), whose
// URLs come exclusively from the immutable manifest. Never send pixels/text.
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, import.meta.url).href;
  if (url === new URL(wasmUrl, import.meta.url).href || url === new URL(moduleUrl, import.meta.url).href) return networkFetch(input, init);
  return Promise.reject(new Error('Description inference cannot make network requests. Download the model first.'));
};
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
env.useCustomCache = true;
env.backends.onnx.wasm!.wasmPaths = { wasm: wasmUrl, mjs: moduleUrl };
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;
let textModel: CLIPTextModelWithProjection | undefined;
let imageModel: CLIPVisionModelWithProjection | undefined;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | undefined;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | undefined;
const verified = new Map<string, ArrayBuffer>();

env.customCache = {
  async match(request: string) {
    const file = CLIP_FILES.find((file) => request === clipURL(file.path) || request.endsWith(`/${CLIP_MODEL}/${file.path}`));
    if (file && verified.has(file.path)) return new Response(verified.get(file.path)!.slice(0));
    // Transformers probes this optional config; CLIP uses preprocessor_config.
    if (request.endsWith('/processor_config.json')) return new Response('{}');
    return undefined;
  },
  async put() { throw new Error('Unexpected model write during offline inference.'); },
};

async function cachedFiles(): Promise<boolean> {
  const cache = await caches.open(CACHE);
  for (const file of CLIP_FILES) if (!(await cache.match(clipURL(file.path)))) return false;
  return true;
}
async function prepare(download: boolean, id: number): Promise<void> {
  if (textModel && imageModel) return;
  const cache = await caches.open(CACHE);
  let completed = 0;
  for (const file of CLIP_FILES) {
    let data: ArrayBuffer | undefined;
    const saved = await cache.match(clipURL(file.path));
    if (saved) {
      try { data = await saved.arrayBuffer(); await verifyClipFile(file.path, data); }
      catch { data = undefined; await cache.delete(clipURL(file.path)); }
    }
    if (!data) {
      if (!download) throw new Error('Download the description model in Footage → Visual before using description search.');
      const response = await networkFetch(clipURL(file.path), { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}). Retry to resume completed files.`);
      const reader = response.body.getReader();
      const bytes = new Uint8Array(file.bytes);
      let offset = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.length > bytes.length) throw new Error('Model download exceeded its expected size.');
          bytes.set(value, offset); offset += value.length;
          postMessage({ id, progress: { completed: completed + offset, total: CLIP_BYTES, label: 'Downloading description model' } });
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      data = bytes.buffer;
      if (offset !== file.bytes) throw new Error('Model download was incomplete. Retry to resume completed files.');
      await verifyClipFile(file.path, data);
      await cache.put(clipURL(file.path), new Response(data.slice(0)));
    }
    verified.set(file.path, data);
    completed += file.bytes;
    postMessage({ id, progress: { completed, total: CLIP_BYTES, label: 'Loading local description model' } });
  }
  const options = { revision: CLIP_REVISION, local_files_only: true, dtype: 'q8' as const, device: 'wasm' as const };
  try {
    tokenizer = await AutoTokenizer.from_pretrained(CLIP_MODEL, options);
    processor = await AutoProcessor.from_pretrained(CLIP_MODEL, options);
    textModel = await CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, options);
    imageModel = await CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, options);
  } catch (error) {
    await textModel?.dispose(); await imageModel?.dispose();
    textModel = undefined; imageModel = undefined; tokenizer = undefined; processor = undefined;
    throw error;
  } finally { verified.clear(); }
}

export type SemanticWorkerRequest = { id: number } & (
  { type: 'status' } | { type: 'prepare'; download: boolean } | { type: 'text'; text: string } |
  { type: 'image'; pixels: Uint8ClampedArray; width: number; height: number });
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<SemanticWorkerRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      let result: unknown;
      if (request.type === 'status') result = await cachedFiles();
      else {
        await prepare(request.type === 'prepare' && request.download, request.id);
        if (request.type === 'prepare') result = true;
        else if (request.type === 'text') {
          if (!request.text.trim() || request.text.length > 1000) throw new Error('Enter a description under 1,000 characters.');
          const inputs = tokenizer!(request.text, { padding: true, truncation: true, max_length: 77 });
          const output = await textModel!(inputs);
          try { result = normalizeVector(output.text_embeds.data as Float32Array); }
          finally { for (const value of Object.values(output)) if (value && typeof value === 'object' && 'dispose' in value) (value as { dispose(): void }).dispose(); }
        } else {
          if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 1 || request.height < 1 || request.width * request.height > 1_048_576 || request.pixels.length !== request.width * request.height * 4) throw new Error('Invalid local image for description indexing.');
          const inputs = await processor!(new RawImage(request.pixels, request.width, request.height, 4));
          const output = await imageModel!(inputs);
          try { result = normalizeVector(output.image_embeds.data as Float32Array); }
          finally { for (const value of Object.values(output)) if (value && typeof value === 'object' && 'dispose' in value) (value as { dispose(): void }).dispose(); }
        }
      }
      postMessage({ id: request.id, result });
    } catch (error) { postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
