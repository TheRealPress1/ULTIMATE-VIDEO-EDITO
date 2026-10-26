import { authoredElement } from '@diffusionstudio/reconciler';
import { Computed, getEntityChildren } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';
import type { ReframeVideo } from './reframe-plan';

/** Read the renderer's actual clocks: sequence positions cannot be inferred from JSX start props. */
export function resolveReframeTiming(world: World, scene: Entity, videos: readonly ReframeVideo[], fps: number): { videos: ReframeVideo[]; sceneEnd: number } {
  const sceneTime = scene.get(Computed);
  if (!sceneTime || !Number.isFinite(sceneTime.end) || sceneTime.end <= 0) throw new Error('Wait for the scene timing to finish loading before speaker framing.');
  const sceneEnd = sceneTime.end / fps;
  const result = new Map<string, ReframeVideo>();
  const walk = (parent: Entity, key: string, parentStart: number, parentEnd: number) => {
    // Match authoredTree's indexing, ignoring runtime-generated paint/caption entities.
    const children = getEntityChildren(world, parent).filter((child) => authoredElement(child) !== undefined);
    children.forEach((child, index) => {
      const childKey = key ? `${key}.${index}` : String(index);
      const video = videos.find((item) => item.key === childKey);
      const element = authoredElement(child)!;
      if (!video && element.tag !== 'sequence') return;
      const c = child.get(Computed);
      if (!c || ![c.start, c.end, c.origin, c.playbackRate].every(Number.isFinite) || c.playbackRate <= 0) throw new Error('Wait for all video timing to finish loading before speaker framing.');
      const visibleStart = Math.max(parentStart, c.start / fps);
      const visibleEnd = Math.min(parentEnd, c.end / fps);
      if (!video) { walk(child, childKey, visibleStart, visibleEnd); return; }
      const origin = c.origin / fps, rate = c.playbackRate;
      // Computed already includes the runtime's frame-quantized trims. Raw
      // JSX sourceIn/end values may differ by a fraction of a frame.
      const start = Math.max(0, (visibleStart - origin) * rate);
      const end = Math.min(video.asset.duration, (visibleEnd - origin) * rate);
      if (end <= start) throw new Error(`${video.path} has no visible frames in the selected scene. Remove or extend that clip before speaker framing.`);
      result.set(childKey, { ...video, start, end, playbackRate: rate,
        timeline: { start: origin + start / rate, end: origin + end / rate, origin, rate } });
    });
  };
  walk(scene, '', Math.max(0, (sceneTime.start ?? 0) / fps), sceneEnd);
  if (result.size !== videos.length) throw new Error('The video layout changed while reading its timing. Reopen the intended scene and try again.');
  return { videos: videos.map((video) => result.get(video.key)!), sceneEnd };
}

