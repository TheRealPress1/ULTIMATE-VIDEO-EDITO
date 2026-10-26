/** Local measurements of a flattened reference; all times are relative to its first video PTS. */
export const REFERENCE_ENGINE = "apple-reference-style-v1";
export const REFERENCE_MAX_SECONDS = 120;
export const REFERENCE_MAX_SOURCE_SECONDS = 86400;
export const REFERENCE_INTERVAL = 0.25;
export type ReferenceText = {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type ReferenceSample = {
  time: number;
  mediaTime: number;
  change: number;
  text: ReferenceText[];
  palette: string[];
};
export type ReferenceAnalysis = {
  duration: number;
  sourceStart: number;
  analyzedDuration: number;
  width: number;
  height: number;
  sampleInterval: number;
  samples: ReferenceSample[];
};
export type ReferenceCaption = {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizeRatio: number;
  coverage: number;
  observations: number;
  distinctTexts: number;
  examples: string[];
  suggestedPreset: "classic" | "whisper";
};
export type ReferenceProfile = {
  sourceDuration: number;
  analyzedDuration: number;
  sourceStart: number;
  width: number;
  height: number;
  sampleInterval: number;
  cuts: Array<{ time: number; score: number }>;
  pacing: {
    medianShotSeconds: number | null;
    cutsPerMinute: number;
    shotCount: number;
  };
  caption: ReferenceCaption | null;
  palette: string[];
  sampleTimes: number[];
  limitations: string[];
};
export type ReferenceRequest = {
  dir: string;
  source: string;
  duration: number;
  sourceStart?: number;
};
export type ReferenceJob = ReferenceRequest & { id: string };
export type ReferenceResult = {
  fingerprint: string;
  engine: string;
  analyzedAt: string | null;
  profile: ReferenceProfile | null;
};
export type ReferenceProgress = {
  id: string;
  completed: number;
  total: number;
};
