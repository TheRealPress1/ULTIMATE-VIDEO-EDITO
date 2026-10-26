/** Local footage transcripts use source-media seconds, independent of the timeline. */
export type FootageTranscript = {
  text: string;
  words: { text: string; start: number; end: number }[];
}[];

export type FootageIndexRequest = { id?: string; dir: string; source: string; duration: number };
export type FootageIndexPutRequest = FootageIndexRequest & {
  /** Full SHA-256 returned before extracting/transcribing the original source. */
  expectedFingerprint: string;
  transcript: FootageTranscript;
};
export type FootageIndexResult = {
  fingerprint: string;
  /** null means not indexed; [] is a successful recording with no speech. */
  transcript: FootageTranscript | null;
  indexedAt: string | null;
  engine: string;
  partial?: { completed: number; total: number };
};

export type FootageChunkRequest = FootageIndexRequest & { expectedFingerprint: string; language?: string };
export type FootageChunkPutRequest = FootageChunkRequest & { index: number; transcript: FootageTranscript };
export type FootageChunksResult = {
  fingerprint: string; engine: string; chunkSeconds: number; overlapSeconds: number;
  completed: number; total: number; chunks: Record<number, FootageTranscript>;
};
