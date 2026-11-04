/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRIPT_LINT_CODES, SCRIPT_LINT_NOTE, countWords, lintScript, profileHints, spokenText, voiceStats } from "./script-lint";
import { scriptLint } from "./tools/script";
import { toolByName } from "./catalog";

import type { ScriptLintCode, ScriptLintOptions, VoiceSample } from "./script-lint";

const codes = (text: string, options?: ScriptLintOptions) => lintScript(text, options).flags.map((flag) => flag.code);
const flagged = (text: string, code: ScriptLintCode, options?: ScriptLintOptions) => lintScript(text, options).flags.filter((flag) => flag.code === code);

/** A clean script: labelled, specific, addressed to one viewer, closing on an action. */
const clean = [
  "1. [opener · curious] Your rent is €300 too high.",
  "2. [doubt · skeptical] You think nobody negotiates in Lisbon.",
  "3. [point 1 · hopeful] Ask the porteira on Rua da Graça who owns the empty flat.",
  "4. [proof · relieved] Inês did that in May and saved €250.",
  "5. [close · confident] Knock on one door this week.",
].join("\n");

describe("lintScript", () => {
  it("passes a clean script with no flags, and always carries the note", () => {
    const report = lintScript(clean);
    expect(report.flags).toEqual([]);
    expect(report.note).toBe(SCRIPT_LINT_NOTE);
    expect(report.source).toEqual({ kind: "text", format: "script" });
    expect(report.language).toEqual({ code: "en", source: "detected", englishChecks: true });
    expect(report.opening).toMatchObject({ lines: [1], sentences: 1, firstSentenceWords: 6, youInFirst3Sentences: true });
    expect(report.moodTurns.map((turn) => [turn.line, turn.from, turn.to])).toEqual([[2, "curious", "skeptical"], [3, "skeptical", "hopeful"], [4, "hopeful", "relieved"], [5, "relieved", "confident"]]);
    expect(() => scriptLint.output.parse(report)).not.toThrow();
  });

  it("times lines at 150 and 180 wpm", () => {
    const text = "1. [opener · calm] " + Array(30).fill("word").join(" ") + ".\n2. [close · calm] " + Array(15).fill("word").join(" ") + ".";
    const at150 = lintScript(text);
    expect(at150.wpmUsed).toBe(150);
    expect(at150.wpmSource).toBe("default");
    expect(at150.lines.map((line) => [line.words, line.estSeconds, line.startEst])).toEqual([[30, 12, 0], [15, 6, 12]]);
    expect(at150.totals).toMatchObject({ words: 45, estSeconds: 18 });
    expect(at150.opening.wordsInFirst4s).toBe(10);
    const at180 = lintScript(text, { wpm: 180, wpmSource: "argument" });
    expect(at180.wpmSource).toBe("argument");
    expect(at180.lines.map((line) => [line.estSeconds, line.startEst])).toEqual([[10, 0], [5, 10]]);
    expect(at180.totals.estSeconds).toBe(15);
    expect(at180.opening.wordsInFirst4s).toBe(12);
    expect(at180.opening.first4s.split(" ")).toHaveLength(12);
  });

  it("reads a brief's Script section and its Goal target", () => {
    const brief = `## Goal\n- target: 5-10 s\n\n## Script\n${clean}\n\n## Notes\nnone\n`;
    const report = lintScript(brief, { source: { kind: "file", path: "brief.md" } });
    expect(report.source).toEqual({ kind: "file", path: "brief.md", format: "brief" });
    expect(report.totals).toMatchObject({ target: { min: 5, max: 10 }, targetSource: "brief", withinTarget: false });
    expect(codes(brief)).toEqual(["over-length"]);
    expect(lintScript(brief, { targetSeconds: { min: 10, max: 30 } }).totals).toMatchObject({ targetSource: "argument", withinTarget: true });
  });

  it("flags an empty brief and a missing script", () => {
    expect(codes("## Goal\n- viewer: someone\n")).toEqual(["no-script"]);
    expect(flagged("## Goal\n- viewer: someone\n", "no-script")[0]!.message).toMatch(/## Script/);
    expect(codes("   ")).toEqual(["no-script"]);
  });

  it("flags greeting, series-counter and self-introduction openers", () => {
    expect(codes("1. [opener · warm] Hey guys, welcome back to the channel.\n2. [close · warm] Your move: try it on €5.")).toEqual(expect.arrayContaining(["greeting-opener", "group-address"]));
    expect(codes("1. [opener · curious] Day 14 of fixing your posture at the desk.\n2. [close · calm] Set one 3 pm alarm.")).toContain("series-counter-opener");
    expect(codes("1. [opener · curious] Part 3 of my series on your rent.\n2. [close · calm] Ask about 2 flats.")).toContain("series-counter-opener");
    expect(codes("1. [opener · curious] My name is Sam and you should hear this about €20 lunches.\n2. [close · calm] Pack one on Monday.")).toContain("self-intro-opener");
    expect(codes("1. [opener · curious] I'm Priya and your lunch costs too much at €14.\n2. [close · calm] Pack one on Monday.")).toContain("self-intro-opener");
    expect(codes("1. [opener · curious] I'm tired of your €14 lunches.\n2. [close · calm] Pack one on Monday.")).not.toContain("self-intro-opener");
    expect(codes("1. [opener · curious] This is day 12 of my posture challenge, and your neck knows it.\n2. [close · calm] Set one 3 pm alarm.")).toContain("series-counter-opener");
    expect(codes("1. [opener · curious] Quick one: part 3 of my rent series, for you.\n2. [close · calm] Ask about 2 flats.")).toContain("series-counter-opener");
    expect(codes("1. [opener · curious] I'm Sam Okafor, and your rent is €300 too high.\n2. [close · calm] Ask about 2 flats.")).toContain("self-intro-opener");
  });

  it("leaves rankings, a day of the month and a nationality alone in the opener", () => {
    const close = "\n2. [close · calm] Ask the porteira on Monday.";
    expect(codes(`1. [opener · curious] #1 mistake you make with rent in Lisbon.${close}`)).not.toContain("series-counter-opener");
    expect(codes(`1. [opener · curious] Your landlord can't raise rent on day 1 of a lease.${close}`)).not.toContain("series-counter-opener");
    expect(codes(`1. [opener · curious] I'm British and you pay less rent than me in Lisbon.${close}`)).not.toContain("self-intro-opener");
    expect(codes(`1. [opener · curious] I'm New Zealander and your €900 rent shocks me.${close}`)).not.toContain("self-intro-opener");
  });

  it("flags a long opener, a slow first sentence and a late you", () => {
    const long = "1. [opener · curious] Rent is up 12%. Wages are not. Landlords know it.\n2. [close · calm] Ask your landlord for 5% off.";
    expect(flagged(long, "long-opener")[0]).toMatchObject({ line: 1 });
    expect(codes(long)).toContain("no-early-you");
    const slow = "1. [opener · curious] When you sign a lease in a city like Lisbon or Porto through an agency you pay for it.\n2. [close · calm] Ask the porteira about 2 flats.";
    expect(flagged(slow, "slow-opener")[0]!.message).toMatch(/about 7\.6 s to say at 150 wpm \(19 words\)/);
    expect(codes(slow, { wpm: 240, wpmSource: "argument" })).not.toContain("slow-opener");
  });

  it("treats the lines marked opener as the opener", () => {
    const report = lintScript("1. [opener · curious] Your rent is high.\n2. [opener · curious] It is €300 high.\n3. [close · calm] Ask on Monday.");
    expect(report.opening).toMatchObject({ lines: [1, 2], sentences: 2 });
    expect(report.flags.map((flag) => flag.code)).not.toContain("long-opener");
  });

  it("flags crowd address anywhere in the script", () => {
    expect(flagged("1. [opener · curious] Your rent is €300 high.\n2. [point · calm] All of you can fix this in Lisbon.\n3. [close · calm] Ask on Monday.", "group-address")[0]).toMatchObject({ line: 2 });
  });

  it("flags long sentences", () => {
    const line = `1. [opener · curious] You ${Array(23).fill("really").join(" ")} pay €300 too much.`;
    expect(flagged(line, "long-sentence")[0]!.message).toMatch(/28 words/);
  });

  it("flags point, proof and payoff beats with nothing concrete in them", () => {
    const vague = "1. [opener · curious] Your rent is €300 too high.\n2. [point 1 · hopeful] Talk to the people who look after the building.\n3. [proof · relieved] It worked for a friend of mine.\n4. [close · calm] Knock on one door.";
    expect(flagged(vague, "no-specifics-in-beat").map((flag) => flag.line)).toEqual([2, 3]);
    expect(codes("1. You could pay less for rent.\n2. Ask around.")).toContain("no-specifics-in-beat");
    expect(codes("1. Ask Inês about rent.\n2. Knock today.")).not.toContain("no-specifics-in-beat");
  });

  it("checks numbered story beats like any other story beat", () => {
    const story = (label: string) => flagged(`1. [opener · curious] Your rent is €300 too high.\n2. [${label} · tense] I was walking home when it hit me.\n3. [close · calm] Knock on 1 door.`, "no-specifics-in-beat");
    expect(story("story").map((flag) => flag.line)).toEqual([2]);
    expect(story("story 1").map((flag) => flag.line)).toEqual([2]);
    expect(story("story: the flat").map((flag) => flag.line)).toEqual([2]);
    expect(story("storyline")).toEqual([]);
  });

  it("does not count placeholders, stage directions or cues as spoken words", () => {
    expect(countWords("Your rent is ⟦ask: how much over market?⟧ too high.")).toBe(5);
    expect(countWords("Knock on ⟦ask: which street?⟧ this week.")).toBe(4);
    expect(countWords("Pause here [beat] then {music drops} go.")).toBe(4);
    expect(spokenText("Your rent is ⟦ask: how much?⟧ too high.")).toBe("Your rent is too high.");
    const report = lintScript("1. [opener · curious] Your rent is ⟦ask: how much over market?⟧ too high.\n2. [close · calm] Knock on ⟦ask: which street?⟧ this week.");
    expect(report.lines.map((line) => [line.words, line.estSeconds, line.startEst])).toEqual([[5, 2, 0], [4, 1.6, 2]]);
    expect(report.lines[0]!.text).toBe("Your rent is ⟦ask: how much over market?⟧ too high.");
    expect(report.totals.words).toBe(9);
    expect(report.opening).toMatchObject({ firstSentenceWords: 5, first4s: "Your rent is too high. Knock on this week." });
    expect(report.flags.find((flag) => flag.code === "weak-close")).toBeUndefined();
  });

  it("flags every open placeholder with its line and text", () => {
    const text = [
      "1. [opener · curious] Your rent is ⟦ask: how much over market?⟧ too high.",
      "2. [point 1 · hopeful] Ask the porteira on Rua da Graça who owns the empty flat.",
      "3. [proof · relieved] ⟦ask: how much did Inês save, and when?⟧",
      "4. [close · confident] Knock on one door this week.",
    ].join("\n");
    expect(flagged(text, "open-placeholder")).toEqual([
      { line: 1, code: "open-placeholder", message: expect.stringContaining("⟦ask: how much over market?⟧") },
      { line: 3, code: "open-placeholder", message: expect.stringContaining("⟦ask: how much did Inês save, and when?⟧") },
    ]);
    // The proof beat is waiting on the creator's fact, so it isn't asked for one again.
    expect(codes(text)).not.toContain("no-specifics-in-beat");
    expect(lintScript(text).lines[2]).toMatchObject({ words: 0, flags: ["open-placeholder"] });
    expect(flagged("1. [opener · curious] Your rent is high.\n2. [proof · calm] Inês saved ⟦ask: how much", "open-placeholder")[0]!.message).toContain("⟦ask: how much");
    expect(flagged("1. You pay too much rent.\n2. Ask ⟦ask: who?⟧ today.", "no-specifics-in-beat")).toEqual([]);
  });

  it("finds no specifics inside placeholders or stage directions", () => {
    const text = "1. [opener · curious] Your rent is €300 too high.\n2. [point · calm] Talk to the people [cut to Rua da Graça] who look after it.\n3. [close · calm] Knock on 1 door.";
    expect(flagged(text, "no-specifics-in-beat").map((flag) => flag.line)).toEqual([2]);
    expect(flagged(text, "no-specifics-in-beat")[0]!.message).toMatch(/one the creator gave you, or a ⟦ask: …⟧ placeholder/);
  });

  it("flags hedges, jargon, avoided words and stale phrases", () => {
    const text = "1. [opener · curious] Your rent is maybe €300 too high, I think.\n2. [point · calm] Leverage the porteira on Rua da Graça.\n3. [proof · calm] It was a game-changer for Inês in May, a total hack.\n4. [close · calm] Knock on 1 door.";
    const report = lintScript(text, { avoidWords: ["hack"], extraStalePhrases: ["total hack"] });
    expect(report.flags.filter((flag) => flag.code === "hedge")).toEqual([{ line: 1, code: "hedge", message: expect.stringContaining('"maybe", "i think"') }]);
    expect(report.flags.find((flag) => flag.code === "jargon")).toMatchObject({ line: 2 });
    expect(report.flags.find((flag) => flag.code === "avoided-word")).toMatchObject({ line: 3, message: expect.stringContaining('"hack"') });
    expect(report.flags.find((flag) => flag.code === "stale-phrase")!.message).toMatch(/"game-changer", "total hack"/);
    expect(report.lines[2]!.flags).toEqual(["avoided-word", "stale-phrase"]);
  });

  it("flags missing emotion labels, grouped", () => {
    expect(flagged("1. Your rent is €300 high.\n2. Ask Inês.", "missing-emotion")).toEqual([{ line: null, code: "missing-emotion", message: expect.stringMatching(/No line has an emotion/) }]);
    expect(flagged("1. [opener · curious] Your rent is €300 high.\n2. [point] Ask Inês.\n3. [close] Knock on 1 door.", "missing-emotion")).toEqual([{ line: 2, code: "missing-emotion", message: "Lines 2, 3 have no emotion label." }]);
  });

  it("counts separately numbered points, not lines", () => {
    const points = (labels: string[]) => ["1. [opener · curious] Your 5 rent fixes.", ...labels.map((label, i) => `${i + 2}. [${label} · calm] Fix ${i + 1} is Rua ${i + 1}.`), `${labels.length + 2}. [close · calm] Try 1 today.`].join("\n");
    expect(codes(points(["point 1", "point 1", "point 2", "point 3", "point 4"]))).not.toContain("too-many-points");
    expect(flagged(points(["point 1", "point 2", "point 3", "point 4", "point 5"]), "too-many-points")[0]).toMatchObject({ line: 6 });
  });

  it("flags a weak close", () => {
    const close = (last: string) => codes(`1. [opener · curious] Your rent is €300 high.\n2. [close · calm] ${last}`);
    expect(close("What do you think?")).toContain("weak-close");
    expect(close("And then we'll see...")).toContain("weak-close");
    expect(close("Try it on Monday, and")).toContain("weak-close");
    expect(close("Thanks for watching!")).toContain("weak-close");
    expect(close("Knock on one door this week.")).not.toContain("weak-close");
  });

  it("flags over- and under-length against the target", () => {
    const over = lintScript(clean, { targetSeconds: { min: 3, max: 8 } });
    expect(over.flags.find((flag) => flag.code === "over-length")!.message).toMatch(/over the 8 s target; cut about \d+ words/);
    expect(codes(clean, { targetSeconds: { min: 60, max: 90 } })).toContain("under-length");
    expect(lintScript(clean).totals.withinTarget).toBeNull();
  });

  it("flags a repeated line", () => {
    expect(flagged("1. [opener · curious] Your rent is too high.\n2. [point · calm] Ask Inês on Monday.\n3. [close · calm] Your rent is too high!", "duplicate-line")).toEqual([{ line: 3, code: "duplicate-line", message: expect.stringContaining("Repeats line 1") }]);
  });

  it("skips the English word lists for other languages and says which", () => {
    const french = "1. [opener · curieux] Salut tout le monde, ton loyer est trop cher de 300 euros.\n2. [close · calme] Frappe à une porte cette semaine avant vendredi soir.";
    const report = lintScript(french);
    expect(report.language).toEqual({ code: "und", source: "detected", englishChecks: false });
    expect(report.skipped).toContain("greeting-opener");
    expect(report.flags.map((flag) => flag.code)).not.toContain("no-early-you");
    expect(lintScript(french, { language: "fr" }).language).toEqual({ code: "fr", source: "argument", englishChecks: false });
    expect(lintScript(`## Goal\n- language: fr-FR\n\n## Script\n${french}`).language).toEqual({ code: "fr", source: "brief", englishChecks: false });
    expect(codes(french, { avoidWords: ["porte"] })).toContain("avoided-word");
  });

  it("emits only known codes, every one reachable", () => {
    const seen = new Set<string>();
    const scripts = [
      "1. [opener · warm] Hey guys, day 3 of my name is Sam and. Rent. Rent. Rent.\n2. [point · calm] You guys maybe leverage the game changer.",
      "## Goal\n- target: 1-2 s\n",
      "1. [opener · curious] Your rent is ⟦ask: how much?⟧ too high.\n2. [story 1 · tense] It hit me.",
    ];
    for (const script of scripts) for (const code of codes(script)) seen.add(code);
    for (const code of seen) expect(SCRIPT_LINT_CODES).toContain(code);
  });
});

const sample = (text: string, wordsPerSecond = 3): VoiceSample => {
  const tokens = text.split(/\s+/);
  const words = tokens.map((token, index) => ({ text: token, start: index / wordsPerSecond, end: (index + 0.9) / wordsPerSecond }));
  return { path: "footage/talk.mov", segments: [{ text, words }] };
};

describe("voice samples", () => {
  const speech = Array(12).fill("It's cheap. Don't sign yet. You'll save money.").join(" ");

  it("measures rate, sentence length and contractions, and uses the measured rate", () => {
    const stats = voiceStats([sample(speech)], ["Your rent is €300 too high."]);
    expect(stats).toMatchObject({ paths: ["footage/talk.mov"], sampleWords: 96, sampleWpm: 180, sampleAvgSentenceWords: 2.7 });
    expect(stats!.sampleContractionsPer100).toBeGreaterThan(30);
    const report = lintScript(clean, { voiceSamples: [sample(speech)] });
    expect(report.wpmUsed).toBe(180);
    expect(report.wpmSource).toBe("sample");
    expect(report.voice?.sampleWpm).toBe(180);
    expect(lintScript(clean, { voiceSamples: [sample(speech)], wpm: 160, wpmSource: "profile" }).wpmSource).toBe("sample");
    expect(lintScript(clean, { voiceSamples: [sample(speech)], wpm: 160, wpmSource: "argument" }).wpmUsed).toBe(160);
    expect(() => scriptLint.output.parse(report)).not.toThrow();
  });

  it("flags sentences longer and more formal than the creator's speech", () => {
    const formal = "1. [opener · curious] You are paying three hundred euros more than you should for the apartment in Lisbon that you found yourself.\n2. [close · calm] You should not sign the lease until you have asked the porteira about it on Monday.";
    expect(codes(formal, { voiceSamples: [sample(speech)] })).toEqual(expect.arrayContaining(["voice-long-sentences", "voice-formal"]));
  });

  it("does not measure a rate from too little speech", () => {
    const stats = voiceStats([sample("Short one. Two. Three.")], []);
    expect(stats?.sampleWpm).toBeNull();
    expect(lintScript(clean, { voiceSamples: [sample("Short one.")], wpm: 170, wpmSource: "profile" })).toMatchObject({ wpmUsed: 170, wpmSource: "profile" });
  });
});

describe("profileHints", () => {
  it("reads a remembered rate and words to avoid, and nothing else", () => {
    expect(profileHints([
      "Makes Reels about renting in Lisbon for remote workers.",
      "Speaks at about 172 wpm on camera.",
      'Words to avoid: "hustle", grind; boss babe',
      "Never say: crushing it",
    ])).toEqual({ wpm: 172, avoidWords: ["hustle", "grind", "boss babe", "crushing it"] });
    expect(profileHints(["reads around 400 wpm"])).toEqual({ avoidWords: [] });
    expect(profileHints(["Posts at 9:16."])).toEqual({ avoidWords: [] });
  });
});

describe("the script_lint tool", () => {
  it("is in the catalog as a read-only main tool", () => {
    expect(toolByName("script_lint")).toBe(scriptLint);
    expect(scriptLint.environment).toBe("main");
    expect(scriptLint.annotations?.readOnlyHint).toBe(true);
  });

  it("takes either path or text, and a sane target", () => {
    expect(scriptLint.input.safeParse({}).success).toBe(true);
    expect(scriptLint.input.safeParse({ path: "brief.md" }).success).toBe(true);
    expect(scriptLint.input.safeParse({ text: "1. Hi." }).success).toBe(true);
    expect(scriptLint.input.safeParse({ path: "brief.md", text: "1. Hi." }).success).toBe(false);
    expect(scriptLint.input.safeParse({ targetSeconds: { min: 40, max: 30 } }).success).toBe(false);
    expect(scriptLint.input.safeParse({ wpm: 80 }).success).toBe(false);
    expect(scriptLint.input.safeParse({ text: "x".repeat(20_001) }).success).toBe(false);
    expect(scriptLint.input.safeParse({ extraStalePhrases: Array(51).fill("old news") }).success).toBe(false);
  });

  it("finds nothing to flag in the docs' worked examples", () => {
    const docs = join(__dirname, "..", "..", "..", "docs");
    for (const file of [["reference", "brief.md"], ["skills", "uve-scripting", "references", "script-file.md"]]) {
      const path = join(docs, ...file);
      if (!existsSync(path)) continue;
      const example = /```markdown\n([\s\S]*?)\n```/.exec(readFileSync(path, "utf8"))![1]!;
      const report = lintScript(example);
      expect(report.warnings, path).toEqual([]);
      expect(report.flags, path).toEqual([]);
      expect(report.totals.withinTarget, path).toBe(true);
      expect(countWords(report.lines.map((line) => line.text).join(" "))).toBe(report.totals.words);
    }
  });
});
