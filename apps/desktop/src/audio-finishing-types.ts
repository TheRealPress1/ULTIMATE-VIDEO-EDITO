/** Local audio finishing exchanges only bounded PCM WAV bytes, never arbitrary process arguments. */
export const AUDIO_FINISH_MAX_SECONDS = 600;
export const AUDIO_FINISH_MAX_BYTES = 256 * 1024 * 1024;
export interface AudioPcmMeasurement {
  duration: number;
  sampleRate: number;
  channels: number;
  frames: number;
  samplePeakDb: number | null;
  rmsDb: number | null;
  fullScaleSamples: number;
  silenceSpans: Array<{ start: number; end: number }>;
}
export interface AudioLoudnessMeasurement extends AudioPcmMeasurement {
  integratedLufs: number | null;
  truePeakDb: number | null;
  loudnessRangeLu: number | null;
  thresholdLufs: number | null;
}
export interface AudioFinishingRequest {
  id: string;
  wav: Uint8Array;
  action: 'measure' | 'finish';
  targetLufs?: number;
  truePeakDb?: number;
  levelDialogue?: boolean;
  denoise?: boolean;
}
export interface AudioFinishingResult {
  input: AudioLoudnessMeasurement;
  output?: AudioLoudnessMeasurement;
  wav?: Uint8Array;
  normalization?: 'linear' | 'dynamic';
  warnings: string[];
}
