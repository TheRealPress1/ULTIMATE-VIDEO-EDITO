import type { AssetLibrary, Transcript } from "@diffusionstudio/assets";

export type CaptionWordDraft = { text: string; start: string; end: string };
export type CaptionDraft = { words: CaptionWordDraft[] }[];

/** Keep input strings until Apply, so an empty timing field never becomes zero. */
export function captionDraft(transcript: Transcript): CaptionDraft {
  return transcript.map((segment) => ({
    words: segment.words.map((word) => ({
      text: word.text,
      start: String(word.start),
      end: String(word.end),
    })),
  }));
}

/** Times are source seconds, never timeline frames or rounded display values. */
export function captionTranscript(draft: CaptionDraft): Transcript {
  let previousEnd = 0;
  let wordCount = 0;
  const transcript = draft.map((segment, segmentIndex) => {
    const words = segment.words.map((word, wordIndex) => {
      const location = `Segment ${segmentIndex + 1}, word ${wordIndex + 1}`;
      const text = word.text.trim().replace(/\s+/g, " ");
      if (!text) throw new Error(`${location}: enter caption text or remove the word.`);
      const start = word.start.trim() === "" ? NaN : Number(word.start);
      const end = word.end.trim() === "" ? NaN : Number(word.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error(`${location}: use a start of zero or later and an end after the start.`);
      }
      if (start < previousEnd) {
        throw new Error(`${location}: start must be at or after the previous word's end (${previousEnd}s).`);
      }
      previousEnd = end;
      wordCount++;
      return { text, start, end };
    });
    return { text: words.map((word) => word.text).join(" "), words };
  }).filter((segment) => segment.words.length > 0);
  if (!wordCount) throw new Error("Keep at least one caption word.");
  return transcript;
}

/**
 * New bytes get a new asset. Updating the caption's src is the single undoable
 * document edit; other captions and older checkpoints keep their original text.
 */
export async function saveCaptionDraft(
  draft: CaptionDraft,
  library: Pick<AssetLibrary, "store" | "flush">,
  target: { isCurrent(): boolean; commit(path: string): void },
): Promise<void> {
  const transcript = captionTranscript(draft);
  const changed = () => new Error("The caption source changed. Reopen its text editor and try again.");
  if (!target.isCurrent()) throw changed();
  const asset = await library.store(
    new Blob([JSON.stringify(transcript)], { type: "application/json" }),
    { name: "Captions edited.json" },
  );
  await library.flush();
  if (!target.isCurrent()) throw changed();
  target.commit(asset.path);
}
