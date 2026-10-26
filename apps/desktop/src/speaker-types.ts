/** Visible active-speaker evidence, never a real-world identity or audio diarization. */
export const SPEAKER_ENGINE = 'light-asd-coreml-ava-v2';
export const SPEAKER_MAX_SECONDS = 7200;
export const SPEAKER_CHUNK_SECONDS = 30;
export const SPEAKER_INTERVAL = 0.5;
export const SPEAKER_CONTEXT_SECONDS = 6;
export interface SpeakerFace {
  trackId: string;
  x: number; y: number; width: number; height: number;
  confidence: number;
  /** Raw audible-speaking class logit from Light-ASD; not a calibrated probability. */
  speakingScore: number | null;
}
export type SpeakerReason = 'speaker' | 'uncertain' | 'no-visible-speaker' | 'overlap' | 'silence';
export interface SpeakerSample {
  /** Seconds relative to the original video's first presentation timestamp. */
  time: number;
  cut: boolean;
  faces: SpeakerFace[];
  activeTrackId: string | null;
  reason: SpeakerReason;
  /** Original mono audio RMS for this sample's neighborhood. */
  audioRms: number;
}
export interface SpeakerAnalysisRequest {
  id: string; dir: string; path: string; start: number; end: number;
  sourceStart?: number;
}
export interface SpeakerAnalysisProgress {
  id: string;
  phase: 'fingerprinting' | 'analyzing' | 'cached';
  completed: number; total: number;
  completedChunks: number; totalChunks: number;
}
export interface SpeakerAnalysisResult {
  engine: string; fingerprint: string;
  start: number; end: number; sourceStart: number;
  width: number; height: number; sampleInterval: number;
  samples: SpeakerSample[];
  warnings: string[];
  resumedChunks: number; totalChunks: number;
}
