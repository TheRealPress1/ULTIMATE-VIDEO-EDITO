import type { Engine } from '@/engine/create-engine';

/**
 * Image-encoder frames are relative to the export workarea, on the capture
 * world's own clock. Negative offsets are valid for a playhead scrubbed
 * before that workarea; the offline encoder adds its start back exactly once.
 */
export function versionPreviewFrame(seconds: number, frameRate: number, workareaStart: number, sceneEnd: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(frameRate) || frameRate <= 0 || !Number.isFinite(workareaStart) || !Number.isFinite(sceneEnd)) {
    throw new Error('The scene preview has invalid timing.');
  }
  const last = Math.max(0, Math.ceil(sceneEnd) - 1);
  const absolute = Math.max(0, Math.min(last, Math.round(seconds * frameRate)));
  const origin = Math.max(0, Math.min(Math.max(0, sceneEnd), workareaStart));
  return absolute - origin;
}

/**
 * Render the active scene at the captured playback position in a disposable
 * world. The live playhead, camera and playback state are never changed.
 * A canvas snapshot is a best-effort fallback when no scene can be rendered.
 */
export async function captureVersionPreview(engine: Pick<Engine, 'world' | 'snapshot'>, dir: string): Promise<string | undefined> {
  const { Computed, FrameRate, Workarea, getActiveEntity, isScene } = await import('@diffusionstudio/runtime');
  const { TIME_FPS } = await import('@diffusionstudio/jsx');
  const scene = getActiveEntity(engine.world);
  if (!scene || !scene.isAlive() || !isScene(scene)) return createVersionPreview(() => engine.snapshot());
  const fps = engine.world.get(FrameRate)?.value ?? TIME_FPS;
  const computed = scene.get(Computed);
  const seconds = (computed?.localTime ?? 0) / fps;
  const sceneEnd = computed?.end ?? computed?.duration ?? 0;
  const workareaStart = scene.get(Workarea)?.start ?? 0;
  try {
    const frame = versionPreviewFrame(seconds, fps, workareaStart, sceneEnd);
    const [{ createCapture }, { createImageEncoder }] = await Promise.all([
      import('@/engine/capture'), import('@diffusionstudio/encoder'),
    ]);
    const target = await createCapture(engine.world, scene, { dir, frameRate: fps });
    try {
      const encoder = await createImageEncoder(target.world, { frames: [frame], resolution: 720 });
      const { width, height } = encoder.bounds;
      if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error('The scene preview has invalid dimensions.');
      encoder.resize(Math.min(960, 960 * height / width));
      const result = await encoder.render();
      if (result.type === 'error') throw result.error;
      if (result.type !== 'success' || !result.data[0]) throw new Error('Scene preview was canceled.');
      const blob = new Blob([new Uint8Array(result.data[0].png)], { type: 'image/png' });
      return await createVersionPreview(async () => blob);
    } finally { target.dispose(); }
  } catch {
    return createVersionPreview(() => engine.snapshot());
  }
}

/** Bound encoded PNG size and release decoded pixels after a version preview. */
export async function createVersionPreview(snapshot: () => Promise<Blob | null>): Promise<string | undefined> {
  const blob = await snapshot();
  if (!blob) return undefined;
  const bitmap = await createImageBitmap(blob);
  try {
    if (!bitmap.width || !bitmap.height) return undefined;
    let width = Math.min(960, bitmap.width);
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(bitmap.height * canvas.width / bitmap.width));
      const context = canvas.getContext('2d');
      if (!context) return undefined;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const preview = canvas.toDataURL('image/png');
      if (preview.length <= 1_000_000) return preview;
      width *= 0.65;
    }
    return undefined;
  } finally { bitmap.close(); }
}
