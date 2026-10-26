import type { SpeechSegment, SpeechWord } from "./speech-types";

const SPECIAL_TEXT = /^(?:\[_[A-Z0-9_]+\]|\[BLANK_AUDIO\]|<\|[^>]*\|>)$/;
const CLOSING_PUNCTUATION = /^[.,!?;:%…。，、！？；：)\]}>»”’]+$/u;
const HAS_WORD_CONTENT = /[\p{L}\p{N}]/u;
const INVALID_RESPONSE = "Speech recognition returned an invalid transcript. Try transcribing again.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type PendingWord = { text: string; start: number; end: number; valid: boolean };
type TimedGroup = SpeechWord & { segment: number };

/** Combine ambiguous adjacent words using only their observed outer bounds. */
function mergeGroup(target: TimedGroup, next: TimedGroup): void {
  target.text += ` ${next.text}`;
  target.start = Math.min(target.start, next.start);
  target.end = Math.max(target.end, next.end);
}

function normalizeGroups(candidates: TimedGroup[]): TimedGroup[] {
  const groups: TimedGroup[] = [];
  for (const word of candidates) {
    const previous = groups.at(-1);
    if (!previous) groups.push(word);
    else if (previous.end === previous.start || word.end <= previous.end) {
      // Whisper sometimes assigns a whole word a point timestamp or places it
      // entirely within the preceding word. Keep the recognized text together
      // in one timed group instead of dropping it or inventing a new interval.
      mergeGroup(previous, word);
    } else {
      groups.push({ ...word, start: Math.max(previous.end, word.start) });
    }

    // A backward span may reach further back than its immediate neighbor.
    // Coalesce those neighbors too, preserving text order and observed bounds.
    while (groups.length > 1 && groups[groups.length - 1].start < groups[groups.length - 2].end) {
      const current = groups.pop()!;
      mergeGroup(groups[groups.length - 1], current);
    }
  }
  // A final point timestamp has no following word to anchor it to.
  if (groups.length > 1 && groups.at(-1)!.end === groups.at(-1)!.start) {
    const final = groups.pop()!;
    mergeGroup(groups.at(-1)!, final);
  }
  return groups.filter((group) => group.end > group.start);
}

/**
 * Parse whisper.cpp's --output-json-full format. Its offsets are milliseconds,
 * and its tokens are BPE fragments, not words. No segment-level timing fallback
 * is used: that would give fabricated word timings to animated captions.
 *
 * Keep VAD disabled in the CLI: upstream v1.9.5 writes token offsets against the
 * silence-compressed timeline when VAD is enabled (ggml-org/whisper.cpp#4046).
 */
export function parseWhisperTranscript(payload: unknown, durationSeconds: number): SpeechSegment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("The audio duration must be greater than zero.");
  }
  if (!record(payload) || !Array.isArray(payload.transcription)) throw new Error(INVALID_RESPONSE);

  const englishOnly = record(payload.model) && payload.model.multilingual === false;
  const specialTokenStart = englishOnly ? 50_256 : 50_257;
  const candidates: TimedGroup[] = [];
  let sawSpokenText = false;

  for (const [segmentIndex, segment] of payload.transcription.entries()) {
    if (!record(segment) || typeof segment.text !== "string" || !Array.isArray(segment.tokens)) {
      throw new Error(INVALID_RESPONSE);
    }
    const segmentText = segment.text.trim();
    if (!SPECIAL_TEXT.test(segmentText) && HAS_WORD_CONTENT.test(segmentText)) sawSpokenText = true;
    let pending: PendingWord | null = null;
    let afterInvalidFragment = false;

    const flush = () => {
      if (pending?.valid && HAS_WORD_CONTENT.test(pending.text) && pending.start < durationSeconds) {
        candidates.push({ text: pending.text, start: pending.start, end: pending.end, segment: segmentIndex });
      }
      pending = null;
    };

    for (const token of segment.tokens) {
      if (!record(token) || typeof token.text !== "string") {
        // An unknown fragment might be part of the current word. Drop that word
        // and subsequent continuations rather than silently changing its text.
        pending = null;
        afterInvalidFragment = true;
        continue;
      }
      const text = token.text.trim().replace(/\s+/gu, " ");
      if (!text || SPECIAL_TEXT.test(text) || (finite(token.id) && token.id >= specialTokenStart)) continue;
      if (HAS_WORD_CONTENT.test(text)) sawSpokenText = true;

      const startsWord = /^\s/u.test(token.text) && !CLOSING_PUNCTUATION.test(text);
      if (startsWord) {
        flush();
        afterInvalidFragment = false;
      }
      if (afterInvalidFragment) continue;

      const offsets = record(token.offsets) ? token.offsets : null;
      const valid = offsets !== null && finite(offsets.from) && finite(offsets.to)
        && offsets.from >= 0 && offsets.to >= offsets.from;
      const start = valid ? Math.min(durationSeconds, (offsets.from as number) / 1_000) : 0;
      const end = valid ? Math.min(durationSeconds, (offsets.to as number) / 1_000) : 0;

      if (pending) {
        pending.text += text;
        pending.valid &&= valid;
        if (valid) {
          pending.start = Math.min(pending.start, start);
          pending.end = Math.max(pending.end, end);
        }
      } else {
        pending = { text, start, end, valid };
      }
    }
    flush();
  }

  const segments: SpeechSegment[] = [];
  let currentSegment = -1;
  for (const group of normalizeGroups(candidates)) {
    if (group.segment !== currentSegment) {
      currentSegment = group.segment;
      segments.push({ text: "", words: [] });
    }
    segments.at(-1)!.words.push({ text: group.text, start: group.start, end: group.end });
  }
  for (const segment of segments) segment.text = segment.words.map((word) => word.text).join(" ");

  if (sawSpokenText && segments.length === 0) {
    throw new Error("Speech recognition returned no usable word timestamps. Try transcribing again.");
  }
  return segments;
}
