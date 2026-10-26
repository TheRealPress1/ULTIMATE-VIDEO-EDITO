import { describe, expect, it } from "vitest";
import { parseWhisperTranscript } from "./speech-transcript";

const token = (text: string, from: number, to: number, id = 100) => ({
  text, timestamps: { from: "00:00:00,000", to: "00:00:00,000" }, offsets: { from, to }, id, p: 0.9, t_dtw: -1,
});
const transcript = (tokens: unknown[], text = "Recorded speech.") => ({
  model: { multilingual: true },
  result: { language: "en" },
  transcription: [{ text, offsets: { from: 0, to: 10_000 }, tokens }],
});

describe("whisper.cpp transcript normalization", () => {
  it("converts the official full JSON shape into words with seconds, excluding metadata and special tokens", () => {
    // Shape and token spellings from whisper.cpp v1.9.5 examples/cli/cli.cpp
    // and its upstream JSON reproduction in ggml-org/whisper.cpp#4046.
    const result = parseWhisperTranscript(transcript([
      token("[_BEG_]", 0, 0, 50364),
      token(" And", 20, 200), token(" so", 200, 410), token(",", 410, 430),
      token(" my", 430, 600), token(" fellow", 600, 950),
      token(" Americans", 950, 1_500), token(".", 1_500, 1_510),
      token("[_TT_400]", 8_000, 8_000, 50764),
    ]), 10);
    expect(result).toEqual([{ text: "And so, my fellow Americans.", words: [
      { text: "And", start: 0.02, end: 0.2 }, { text: "so,", start: 0.2, end: 0.43 },
      { text: "my", start: 0.43, end: 0.6 }, { text: "fellow", start: 0.6, end: 0.95 },
      { text: "Americans.", start: 0.95, end: 1.51 },
    ] }]);
  });

  it("merges subwords and contractions, preserving trailing punctuation", () => {
    expect(parseWhisperTranscript(transcript([
      token(" Trans", 0, 120), token("cription", 120, 600),
      token(" isn", 650, 800), token("'t", 800, 900),
      token(" hard", 900, 1_200), token(" !", 1_200, 1_220),
    ]), 2)[0].words).toEqual([
      { text: "Transcription", start: 0, end: 0.6 },
      { text: "isn't", start: 0.65, end: 0.9 },
      { text: "hard!", start: 0.9, end: 1.22 },
    ]);
  });

  it("clamps to the actual audio duration and trims overlaps without inventing extra duration", () => {
    const result = parseWhisperTranscript(transcript([
      token(" One", 0, 500), token(" two", 400, 700), token(" three", 650, 1_500),
      token(" beyond", 1_500, 2_000),
    ]), 1);
    expect(result[0].words).toEqual([
      { text: "One", start: 0, end: 0.5 }, { text: "two", start: 0.5, end: 0.7 },
      { text: "three", start: 0.7, end: 1 },
    ]);
    expect(result[0].text).toBe("One two three");
  });

  it("keeps words monotonic across segments and preserves completely backward words in a neighboring group", () => {
    const payload = transcript([token(" First", 0, 1_000)]);
    payload.transcription.push({ text: "Second", offsets: { from: 0, to: 2_000 }, tokens: [
      token(" duplicate", 500, 900), token(" second", 900, 2_000),
    ] });
    expect(parseWhisperTranscript(payload, 3)).toEqual([
      { text: "First duplicate", words: [{ text: "First duplicate", start: 0, end: 1 }] },
      { text: "second", words: [{ text: "second", start: 1, end: 2 }] },
    ]);
  });

  it("preserves zero-duration words before, inside and after a timed word", () => {
    const result = parseWhisperTranscript(transcript([
      token(" I", 100, 100), token(" can", 100, 300), token(" still", 200, 200),
      token(" read", 300, 500), token(" this", 500, 500),
    ]), 1);
    expect(result).toEqual([{ text: "I can still read this", words: [
      { text: "I can still", start: 0.1, end: 0.3 }, { text: "read this", start: 0.3, end: 0.5 },
    ] }]);
  });

  it("anchors a point timestamp after a gap to the following word using observed outer bounds", () => {
    const result = parseWhisperTranscript(transcript([
      token(" First", 100, 300), token(" a", 700, 700), token(" thought", 750, 900),
    ]), 1);
    expect(result[0].words).toEqual([
      { text: "First", start: 0.1, end: 0.3 }, { text: "a thought", start: 0.7, end: 0.9 },
    ]);
  });

  it("coalesces several neighbors when a backward word spans earlier words", () => {
    const result = parseWhisperTranscript(transcript([
      token(" All", 100, 300), token(" these", 300, 500), token(" words", 150, 200),
      token(" remain", 500, 900),
    ]), 1);
    expect(result[0].words).toEqual([
      { text: "All these words", start: 0.1, end: 0.5 }, { text: "remain", start: 0.5, end: 0.9 },
    ]);
  });

  it("keeps a trailing point timestamp in the final observed group without extending beyond audio", () => {
    const result = parseWhisperTranscript(transcript([
      token(" Last", 100, 300), token(" word", 700, 700), token(" outside", 1_000, 1_100),
    ]), 1);
    expect(result[0].words).toEqual([{ text: "Last word", start: 0.1, end: 0.7 }]);
  });

  it("drops an entire word when one of its subwords has no usable timing", () => {
    const result = parseWhisperTranscript(transcript([
      token(" Keep", 0, 100), token(" trans", 100, 200), { text: "crip", id: 123 },
      token("tion", 250, 500), token(" this", 500, 750),
    ]), 1);
    expect(result[0].words).toEqual([
      { text: "Keep", start: 0, end: 0.1 }, { text: "this", start: 0.5, end: 0.75 },
    ]);
  });

  it("does not turn a fragment following a malformed token into an invented word", () => {
    expect(parseWhisperTranscript(transcript([
      token(" bro", 0, 100), null, token("ken", 100, 200), token(" intact", 250, 500),
    ]), 1)[0].text).toBe("intact");
  });

  it.each([
    { from: -10, to: 100 }, { from: 200, to: 100 },
    { from: Number.NaN, to: 100 }, { from: 0, to: Infinity }, { from: "0", to: 100 },
  ])("never substitutes segment timings for invalid token offsets %j", (offsets) => {
    const input = transcript([{ text: " broken", offsets }, token(" valid", 500, 750)]);
    expect(parseWhisperTranscript(input, 1)[0].words).toEqual([{ text: "valid", start: 0.5, end: 0.75 }]);
  });

  it("recognizes English and multilingual numeric special-token cutoffs", () => {
    const input = transcript([token(" content", 0, 100, 50256), token(" ignored", 100, 200, 50257)], "");
    expect(parseWhisperTranscript(input, 1)[0].text).toBe("content");
    input.model.multilingual = false;
    expect(parseWhisperTranscript(input, 1)).toEqual([]);
  });

  it("recognizes control token text when model metadata or numeric ids are absent", () => {
    const input = transcript([
      { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
      { text: "<|endoftext|>", offsets: { from: 0, to: 0 } },
      { text: "[BLANK_AUDIO]", offsets: { from: 0, to: 0 } },
    ], "");
    expect(parseWhisperTranscript(input, 1)).toEqual([]);
  });

  it("accepts genuinely empty speech output", () => {
    expect(parseWhisperTranscript({ transcription: [] }, 1)).toEqual([]);
    expect(parseWhisperTranscript(transcript([], ""), 1)).toEqual([]);
  });

  it("reports recognized speech with entirely missing or zero-length timings", () => {
    expect(() => parseWhisperTranscript(transcript([{ text: " speech" }]), 1)).toThrow("no usable word timestamps");
    expect(() => parseWhisperTranscript(transcript([token(" speech", 100, 100)]), 1)).toThrow("no usable word timestamps");
    expect(() => parseWhisperTranscript(transcript([], "Speech with missing tokens"), 1)).toThrow("no usable word timestamps");
  });

  it.each([null, [], {}, { transcription: {} }, { transcription: [null] }, { transcription: [{ text: "speech" }] }])(
    "rejects malformed response structures", (payload) => {
      expect(() => parseWhisperTranscript(payload, 1)).toThrow("invalid transcript");
    },
  );

  it.each([0, -1, Infinity, Number.NaN])("rejects invalid duration %s", (duration) => {
    expect(() => parseWhisperTranscript({ transcription: [] }, duration)).toThrow("audio duration");
  });
});
