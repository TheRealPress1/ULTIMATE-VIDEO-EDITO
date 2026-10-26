/** Local sampled-frame evidence. Times are original source seconds, never timeline time. */
export const VISUAL_ENGINE = 'apple-vision-labels-ocr-v2';
export const VISUAL_MAX_SECONDS = 7200;
export const VISUAL_MAX_SAMPLES = 720;
export const VISUAL_CHUNK_SECONDS = 120;
export const VISUAL_CHUNK_SAMPLES = 24;
export type VisualSampleWindow = { startIndex: number; endIndex: number };
export type VisualEvidence = { text: string; confidence: number };
export type VisualSample = {
  /** Observed presentation time relative to the editor's video-track origin. */
  time: number;
  /** Exact container presentation timestamp returned by the native decoder. */
  mediaTime: number;
  labels: VisualEvidence[];
  text: VisualEvidence[];
  people: number;
};
export type VisualAnalysis = {
  sourceStart: number; duration: number; width: number; height: number; sampleInterval: number; samples: VisualSample[];
};
export type VisualIndexRequest = { dir: string; source: string; duration: number; sourceStart?: number };
export type VisualIndexJob = VisualIndexRequest & { id: string; sampleInterval?: number };
export type VisualIndexResult = { fingerprint: string; engine: string; indexedAt: string | null; analysis: VisualAnalysis | null };
export type VisualProgress = { id: string; completed: number; total: number };
export function visualInterval(duration: number): number { return Math.max(5, Math.ceil(duration / VISUAL_MAX_SAMPLES)); }
