/** Shared local speech contracts. Audio never goes to a hosted service. */
export const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_MAX_SECONDS = 7_200;
export const SPEECH_MODEL_BYTES = 147_951_465;
export type SpeechWord = { text: string; start: number; end: number };
export type SpeechSegment = { text: string; speaker?: string; words: SpeechWord[] };
export type SpeechResult = { segments: SpeechSegment[] };
export type SpeechProgress = {
  id: string;
  stage: "preparing" | "downloading" | "transcribing";
  progress: number | null;
  message: string;
  completedChunks?: number;
  totalChunks?: number;
  resumedChunks?: number;
};
export type SpeechStatus = {
  available: boolean;
  modelDownloaded: boolean;
  modelName: string;
  downloadBytes: number;
  error: string | null;
};
