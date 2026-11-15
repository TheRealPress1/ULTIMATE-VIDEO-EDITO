import { describe, expect, it } from "vitest";

import type { Transcript } from "@diffusionstudio/assets";

import {
  bareWord,
  captionTranscript,
  clock,
  findWord,
  fixWord,
  latestTranscript,
  parseTranscript,
  replaceWord,
  textCaseProp,
  transcriptFileName,
  withoutPunctuation,
  wordAt,
  wordCount,
} from "./captions-tab-data";

/** A made-up interview: two segments, a misheard name, punctuation to drop. */
function sample(): Transcript {
  const words = (list: Array<[string, number]>) => list.map(([text, start], index) => ({ text, start, end: list[index + 1]?.[1] ?? start + 0.4 }));
  const first = words([["So", 0.4], ["we", 0.7], ["started", 0.9], ["in", 1.3], ["my", 1.5], ["garage,", 1.7], ["and", 2.4], ["it", 2.6], ["barely", 2.8], ["worked.", 3.2]]);
  const second = words([["Founders", 5.0], ["Ink", 5.5], ["backed", 5.9], ["us.", 6.3]]);
  return [
    { text: first.map((w) => w.text).join(" "), words: first },
    { text: second.map((w) => w.text).join(" "), words: second },
  ];
}
const texts = (transcript: Transcript) => transcript.map((segment) => segment.words.map((word) => word.text).join(" "));

describe("captions tab data", () => {
  it("compares words without case or the punctuation around them", () => {
    expect(bareWord("Ink,")).toBe("ink");
    expect(bareWord("“That's")).toBe("that's");
    expect(bareWord("back-end.")).toBe("back-end");
    expect(bareWord("...")).toBe("");
  });

  it("drops punctuation but keeps apostrophes and hyphens inside words", () => {
    expect(withoutPunctuation("garage,")).toBe("garage");
    expect(withoutPunctuation("“That's")).toBe("That's");
    expect(withoutPunctuation("back-end.")).toBe("back-end");
    expect(withoutPunctuation("rock 'n' roll!")).toBe("rock n roll");
    expect(withoutPunctuation("—")).toBe("");
    expect(withoutPunctuation("R&D?")).toBe("R&D");
  });

  it("retypes one word without moving any time", () => {
    const fixed = fixWord(sample(), { segment: 1, word: 1 }, "  Inc ");
    expect(fixed[1]!.words[1]).toEqual({ text: "Inc", start: 5.5, end: 5.9 });
    expect(fixed[1]!.text).toBe("Founders Inc backed us.");
    expect(fixed[0]).toEqual(sample()[0]);
  });

  it("removes a word typed empty, and a segment left with none", () => {
    const one = fixWord(sample(), { segment: 0, word: 0 }, "");
    expect(texts(one)[0]).toBe("we started in my garage, and it barely worked.");
    let transcript = sample();
    for (let i = 0; i < 4; i++) transcript = fixWord(transcript, { segment: 1, word: 0 }, " ");
    expect(transcript).toHaveLength(1);
    expect(() => fixWord(sample(), { segment: 4, word: 0 }, "x")).toThrow("no longer in the transcript");
  });

  it("finds a word everywhere it is said, as a whole word", () => {
    const transcript = fixWord(sample(), { segment: 0, word: 7 }, "Ink.");
    expect(findWord(transcript, "ink")).toEqual([{ segment: 0, word: 7 }, { segment: 1, word: 1 }]);
    expect(findWord(transcript, "in")).toEqual([{ segment: 0, word: 3 }]);
    expect(findWord(transcript, "  ")).toEqual([]);
  });

  it("replaces a word everywhere, keeping the punctuation around each", () => {
    const transcript = fixWord(sample(), { segment: 0, word: 7 }, "Ink.");
    const { transcript: next, count } = replaceWord(transcript, "ink", "Inc");
    expect(count).toBe(2);
    expect(next[0]!.words[7]!.text).toBe("Inc.");
    expect(next[1]!.words[1]!.text).toBe("Inc");
    expect(replaceWord(sample(), "ink", "Inc!").transcript[1]!.words[1]!.text).toBe("Inc!");
    expect(replaceWord(sample(), "ink", "  ")).toEqual({ transcript: sample(), count: 0 });
  });

  it("splits captions to the words asked for, and at every clause end", () => {
    expect(texts(captionTranscript(sample(), { words: 1, punctuation: true }))).toHaveLength(14);
    expect(texts(captionTranscript(sample(), { words: 3, punctuation: true }))).toEqual([
      "So we started", "in my garage,", "and it barely", "worked.", "Founders Ink backed", "us.",
    ]);
    expect(texts(captionTranscript(sample(), { words: "phrase", punctuation: true }))).toEqual([
      "So we started in my garage,", "and it barely worked.", "Founders Ink backed us.",
    ]);
  });

  it("still ends captions at clause ends after dropping the punctuation", () => {
    expect(texts(captionTranscript(sample(), { words: "phrase", punctuation: false }))).toEqual([
      "So we started in my garage", "and it barely worked", "Founders Ink backed us",
    ]);
  });

  it("leaves out a word that was only punctuation, and keeps every time", () => {
    const transcript: Transcript = [{ text: "wait — what?", words: [{ text: "wait", start: 0, end: 0.3 }, { text: "—", start: 0.3, end: 0.4 }, { text: "what?", start: 0.4, end: 0.8 }] }];
    const captions = captionTranscript(transcript, { words: "phrase", punctuation: false });
    expect(captions).toEqual([{ text: "wait what", words: [{ text: "wait", start: 0, end: 0.3 }, { text: "what", start: 0.4, end: 0.8 }] }]);
    expect(wordCount(captionTranscript(sample(), { words: 2, punctuation: false }))).toBe(wordCount(sample()));
  });

  it("leaves the preset's case alone unless another is chosen", () => {
    expect(textCaseProp("preset")).toBe(false);
    expect(textCaseProp("original")).toBe("original");
    expect(textCaseProp("lower")).toBe("lower");
  });

  it("knows which word is being said", () => {
    expect(wordAt(sample(), 0.95)).toEqual({ segment: 0, word: 2 });
    expect(wordAt(sample(), 5.5)).toEqual({ segment: 1, word: 1 });
    expect(wordAt(sample(), 0.1)).toBeUndefined();
    // In the pause between the segments: still the last word for a moment, then nothing.
    expect(wordAt(sample(), 3.7)).toEqual({ segment: 0, word: 9 });
    expect(wordAt(sample(), 4.8)).toBeUndefined();
  });

  it("keeps one transcript per scene and finds the newest", () => {
    expect(transcriptFileName("Scene 1")).toBe("Scene 1.json");
    expect(transcriptFileName("Intro: take/2")).toBe("Intro- take-2.json");
    expect(transcriptFileName("   ")).toBe("Scene.json");
    const assets = [
      { path: "Transcripts/Scene 1.json", createdAt: "2026-11-01T10:00:00Z" },
      { path: "Transcripts/Scene 1 2.json", createdAt: "2026-11-02T10:00:00Z" },
      { path: "Transcripts/Scene 10.json", createdAt: "2026-11-03T10:00:00Z" },
      { path: "Other/Scene 1 3.json", createdAt: "2026-11-04T10:00:00Z" },
    ];
    expect(latestTranscript(assets, "Scene 1")?.path).toBe("Transcripts/Scene 1 2.json");
    expect(latestTranscript(assets, "Scene 2")).toBeUndefined();
    expect(latestTranscript([{ path: "Transcripts/a.b.json", createdAt: "1" }, { path: "Transcripts/aXb.json", createdAt: "2" }], "a.b")?.path).toBe("Transcripts/a.b.json");
  });

  it("reads only well-formed transcripts", () => {
    expect(parseTranscript(JSON.parse(JSON.stringify(sample())))).toEqual(sample());
    expect(() => parseTranscript({ words: [] })).toThrow("not a transcript");
    expect(() => parseTranscript([{ words: [{ text: "a", start: 1, end: 0.5 }] }])).toThrow("valid text or times");
    expect(() => parseTranscript([{ words: [{ text: "a", start: 2, end: 3 }, { text: "b", start: 1, end: 4 }] }])).toThrow("valid text or times");
    expect(() => parseTranscript([{ words: [] }])).toThrow("no words");
  });

  it("formats times", () => {
    expect(clock(65.9)).toBe("1:05");
    expect(clock(3725)).toBe("1:02:05");
  });
});
