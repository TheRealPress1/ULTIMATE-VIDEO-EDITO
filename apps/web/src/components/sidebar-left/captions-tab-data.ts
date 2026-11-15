/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Captions tab's logic, apart from its components so it can be tested
// without rendering: fixing and finding words in a transcript, the caption
// copy made from it (words per caption, punctuation), and where a scene's
// transcript is kept in the library.

import type { Transcript } from "@diffusionstudio/assets";
import type { CaptionPreset } from "@diffusionstudio/jsx";

/** At most this many words on screen at once; a phrase leaves it to the preset. */
export type CaptionWords = 1 | 2 | 3 | "phrase";
/** The preset's own case, or one that overrides it. */
export type CaptionCase = "preset" | "original" | "lower" | "upper";
export type CaptionStyle = { preset: CaptionPreset; words: CaptionWords; textCase: CaptionCase; punctuation: boolean };

export const DEFAULT_CAPTION_STYLE: CaptionStyle = { preset: "classic", words: "phrase", textCase: "preset", punctuation: true };

/** Where a word sits: its segment and its place in that segment. */
export type WordAt = { segment: number; word: number };

/** Library folder for the transcripts the tab keeps, one per scene. */
export const TRANSCRIPTS_FOLDER = "Transcripts";

/** Spoken languages Whisper handles well, by code; "" detects the language. */
export const CAPTION_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "", label: "Detect automatically" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];

// The presets break a caption after these, so the caption copy does too,
// even when it drops them from the text.
const BREAKS = [".", "!", "?", ",", ";"];
const endsClause = (text: string): boolean => BREAKS.some((mark) => text.trimEnd().endsWith(mark));

/**
 * The word without case or the punctuation around it, for finding: "Ink,"
 * and "ink" are the same word. Apostrophes and hyphens inside it stay.
 */
export function bareWord(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, "");
}

/** Punctuation dropped for captions; inner apostrophes and hyphens ("that's", "back-end") and "&" stay. */
export function withoutPunctuation(text: string): string {
  return text
    .replace(/[.,!?;:"“”()[\]{}…]/g, "")
    .split(/\s+/)
    .map((token) => token.replace(/^['‘’\-–—]+|['‘’\-–—]+$/g, ""))
    .filter(Boolean)
    .join(" ");
}

const rebuild = (words: Transcript[number]["words"]): Transcript[number] => ({ text: words.map((word) => word.text).join(" "), words });

/**
 * The transcript with one word retyped. Spaces inside are kept as typed, so a
 * misheard pair becomes one caption word. An empty word is removed, and so is
 * a segment left with none. Times never change.
 */
export function fixWord(transcript: Transcript, at: WordAt, text: string): Transcript {
  const segment = transcript[at.segment];
  if (!segment || !segment.words[at.word]) throw new Error("That word is no longer in the transcript.");
  const typed = text.trim().replace(/\s+/g, " ");
  const words = typed
    ? segment.words.map((word, index) => (index === at.word ? { ...word, text: typed } : word))
    : segment.words.filter((_, index) => index !== at.word);
  const next = transcript.map((item, index) => (index === at.segment ? rebuild(words) : item));
  return next.filter((item) => item.words.length > 0);
}

/** Every place `query` is said, matched as a whole word, ignoring case and punctuation. */
export function findWord(transcript: Transcript, query: string): WordAt[] {
  const wanted = bareWord(query);
  if (!wanted) return [];
  const found: WordAt[] = [];
  transcript.forEach((segment, s) => segment.words.forEach((word, w) => {
    if (bareWord(word.text) === wanted) found.push({ segment: s, word: w });
  }));
  return found;
}

/**
 * Every `query` replaced by `replacement`, keeping the punctuation that was
 * around each one ("Ink." becomes "Inc."), unless the replacement brings its own.
 */
export function replaceWord(transcript: Transcript, query: string, replacement: string): { transcript: Transcript; count: number } {
  const typed = replacement.trim().replace(/\s+/g, " ");
  const places = findWord(transcript, query);
  if (!typed || places.length === 0) return { transcript, count: 0 };
  const at = new Set(places.map((place) => `${place.segment}:${place.word}`));
  const next = transcript.map((segment, s) => rebuild(segment.words.map((word, w) => {
    if (!at.has(`${s}:${w}`)) return word;
    const lead = word.text.match(/^[^\p{L}\p{N}&]*/u)?.[0] ?? "";
    const tail = word.text.match(/[^\p{L}\p{N}&]*$/u)?.[0] ?? "";
    const ownTail = /[^\p{L}\p{N}&]$/u.test(typed);
    return { ...word, text: `${lead}${typed}${ownTail ? "" : tail}` };
  })));
  return { transcript: next, count: places.length };
}

/**
 * The transcript the captions show: punctuation dropped when asked, and the
 * words split into captions of at most `words` each. Every caption also ends
 * where the speaker's clause does, as the presets end them. The fixed
 * transcript itself is left as it is.
 */
export function captionTranscript(transcript: Transcript, style: Pick<CaptionStyle, "words" | "punctuation">): Transcript {
  const limit = style.words === "phrase" ? Infinity : style.words;
  const captions: Transcript = [];
  for (const segment of transcript) {
    let current: Transcript[number]["words"] = [];
    const close = () => {
      if (current.length) captions.push(rebuild(current));
      current = [];
    };
    for (const word of segment.words) {
      const text = style.punctuation ? word.text : withoutPunctuation(word.text);
      if (text) current.push({ ...word, text });
      if (current.length >= limit || endsClause(word.text)) close();
    }
    close();
  }
  return captions;
}

/** The `textCase` prop for a case choice; false leaves the preset's own. */
export function textCaseProp(choice: CaptionCase): "original" | "lower" | "upper" | false {
  return choice === "preset" ? false : choice;
}

/** The word being said at `seconds`, from its start until the next word starts. */
export function wordAt(transcript: Transcript, seconds: number): WordAt | undefined {
  let found: WordAt | undefined;
  transcript.forEach((segment, s) => segment.words.forEach((word, w) => {
    if (word.start <= seconds && (!found || word.start >= transcript[found.segment]!.words[found.word]!.start)) found = { segment: s, word: w };
  }));
  if (!found) return undefined;
  const word = transcript[found.segment]!.words[found.word]!;
  // Past a long silence after the last word, nothing is being said.
  return seconds <= word.end + 1 ? found : undefined;
}

export const wordCount = (transcript: Transcript): number => transcript.reduce((sum, segment) => sum + segment.words.length, 0);

/** A file name for a scene's transcript, from its id or name. */
export function transcriptFileName(sceneKey: string): string {
  const base = sceneKey.replace(/[/\\:*?"<>|\0]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Scene";
  return `${base}.json`;
}

type StoredAsset = { path: string; createdAt: string };

/**
 * The scene's latest saved transcript: `Transcripts/<name>.json` or one of
 * its numbered copies (`<name> 2.json`, made when the name was taken), newest first.
 */
export function latestTranscript<T extends StoredAsset>(assets: readonly T[], sceneKey: string): T | undefined {
  const name = transcriptFileName(sceneKey).slice(0, -".json".length);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${TRANSCRIPTS_FOLDER}/${escaped}(?: \\d+)?\\.json$`);
  return assets
    .filter((asset) => pattern.test(asset.path))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

/** A transcript read from a file, checked: segments of timed, non-empty words in order. */
export function parseTranscript(value: unknown): Transcript {
  if (!Array.isArray(value)) throw new Error("This file is not a transcript.");
  let previous = -Infinity;
  const transcript: Transcript = [];
  for (const segment of value) {
    if (!segment || typeof segment !== "object" || !Array.isArray((segment as { words?: unknown }).words)) throw new Error("This file is not a transcript.");
    const words: Transcript[number]["words"] = [];
    for (const word of (segment as { words: unknown[] }).words) {
      const { text, start, end } = (word ?? {}) as { text?: unknown; start?: unknown; end?: unknown };
      if (typeof text !== "string" || !text.trim() || typeof start !== "number" || typeof end !== "number"
        || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previous) {
        throw new Error("This transcript has a word without valid text or times.");
      }
      previous = start;
      words.push({ text, start, end });
    }
    if (words.length) transcript.push(rebuild(words));
  }
  if (!transcript.length) throw new Error("This transcript has no words.");
  return transcript;
}

/** m:ss, or h:mm:ss past an hour. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
