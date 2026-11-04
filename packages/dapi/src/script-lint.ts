/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Deterministic checks for a short-form script: word counts and spoken
// length at a reading rate, the opener's first seconds, and a fixed list of
// flags an agent fixes or justifies. Everything here is counting and pattern
// matching; none of it judges whether a script is good. The phrase lists are
// Cutroom's own and English-only, so for other languages those checks are
// skipped and say so. Pure: the handler reads the files and passes text in.

import { beatKind, parseBrief, parseScript, splitSentences } from "./brief";
import type { BriefScriptLine } from "./brief";

export const SCRIPT_LINT_DEFAULT_WPM = 150;
export const SCRIPT_LINT_MIN_WPM = 90;
export const SCRIPT_LINT_MAX_WPM = 240;
/** Characters of script text the tool takes inline. */
export const SCRIPT_LINT_TEXT_MAX = 20_000;
/** A sentence longer than this many words is flagged. */
export const LONG_SENTENCE_WORDS = 22;
/** The window `opening.first4s` reports: what a scrolling viewer hears before deciding. */
export const OPENING_WINDOW_SECONDS = 4;
/** A first sentence that takes longer than this to say is flagged. */
export const FIRST_SENTENCE_SECONDS = 5;
/** More separate `point` beats than this is flagged. */
export const MAX_POINTS = 4;
export const SCRIPT_LINT_NOTE = "Heuristic prompts, not editorial judgments: fix each flag or say why it stays.";

export const SCRIPT_LINT_CODES = [
  "no-script",
  "open-placeholder",
  "greeting-opener",
  "series-counter-opener",
  "self-intro-opener",
  "long-opener",
  "slow-opener",
  "no-early-you",
  "group-address",
  "long-sentence",
  "no-specifics-in-beat",
  "hedge",
  "jargon",
  "avoided-word",
  "stale-phrase",
  "missing-emotion",
  "too-many-points",
  "weak-close",
  "over-length",
  "under-length",
  "duplicate-line",
  "voice-long-sentences",
  "voice-formal",
] as const;
export type ScriptLintCode = (typeof SCRIPT_LINT_CODES)[number];

/** The checks that rely on English word lists, skipped for other languages. */
export const ENGLISH_ONLY_CODES: readonly ScriptLintCode[] = [
  "greeting-opener", "series-counter-opener", "self-intro-opener", "no-early-you", "group-address", "hedge", "jargon", "stale-phrase", "voice-formal",
];

/**
 * Worn phrases a viewer has scrolled past too often to hear. Cutroom's own
 * starter list; the creator's profile and the call can add more.
 */
export const DEFAULT_STALE_PHRASES: readonly string[] = [
  "game changer", "game-changer", "level up", "in today's video", "in this video", "let's dive in", "let's dive right in",
  "without further ado", "you won't believe", "nobody talks about", "no one talks about", "here's the thing",
  "at the end of the day", "stop scrolling", "wait for it", "trust the process", "unlock your potential",
  "one simple trick", "this one trick", "it's that simple", "mind-blowing", "mind blown", "let that sink in",
  "you need to hear this", "this changed my life", "changed my life forever", "smash that like", "like and subscribe",
  "don't forget to subscribe", "make sure to follow", "rise and grind", "secret sauce", "the ultimate guide",
  "best kept secret", "living my best life",
];

const HEDGES = [
  "maybe", "kind of", "sort of", "i think", "i guess", "i feel like", "probably", "perhaps", "basically",
  "somewhat", "a little bit", "in my opinion", "more or less", "i'd say", "arguably", "i suppose", "to be honest",
];

const JARGON = [
  "leverage", "leveraging", "synergy", "synergies", "utilize", "utilizing", "paradigm", "holistic", "actionable",
  "scalable", "ecosystem", "deliverables", "stakeholders", "best practices", "value proposition", "circle back",
  "move the needle", "low-hanging fruit", "bandwidth", "optimize your", "streamline", "robust",
];

const GROUP_ADDRESS = [
  /\byou guys\b/i, /\by'?all\b/i, /\byou all\b/i, /\ball of you\b/i, /\b(?:everyone|everybody|anyone|anybody) (?:watching|out there|listening)\b/i,
  /\bthose of you\b/i, /\bladies and gentlemen\b/i, /\b(?:hey|hi|hello|morning) (?:guys|everyone|everybody|friends|fam)\b/i, /\bfolks\b/i,
];
const GREETING = /^\W*(?:hey|hi|hello|hiya|yo|sup|what'?s up|good (?:morning|afternoon|evening)|welcome(?: back)?|greetings|howdy)\b/i;
const SERIES_WORD = String.raw`(?:day|part|episode|ep\.?|week|video|chapter|round|lesson)`;
const SERIES = [
  // A counter that starts the opener: "Day 14 of…", "Part 3:", "This is episode 12".
  new RegExp(String.raw`^\W*(?:(?:this is|it'?s|here'?s|welcome(?: back)? to|we'?re on|today is|today'?s)\s+)?${SERIES_WORD}\s*#?\s*\d+\b`, "i"),
  // Anywhere, a counter that names its series: "…part 3 of my rent series", "#4 in this challenge".
  new RegExp(String.raw`(?:\b${SERIES_WORD}\s+#?|#)\d+\s+(?:of|in)\s+(?:my|our|this|the)\s+(?:[\p{L}'-]+\s+){0,3}(?:series|challenge|journey|saga)\b`, "iu"),
];
const SELF_INTRO = /\b(?:my name is|my name's|let me introduce myself|for those (?:of you )?who don'?t know me|if you'?re new here|it'?s your (?:boy|girl|host)|welcome to my (?:channel|page))\b/i;
/** "I'm Sam and…", "I am Priya Shah, and…": a capitalized word or two after "I'm", then "and". */
const SELF_NAME = /\b(?:I'?m|I am) (\p{Lu}[\p{Ll}'-]+)(?: (\p{Lu}[\p{Ll}'-]+))?,? and\b/gu;
/** Capitalized words after "I'm" that describe rather than name: nationalities, faiths, emphasis. */
const NOT_A_SELF_NAME = new Set([
  "american", "british", "english", "scottish", "welsh", "irish", "canadian", "australian", "kiwi", "french", "german", "dutch",
  "belgian", "swiss", "austrian", "italian", "spanish", "portuguese", "brazilian", "mexican", "argentinian", "argentine",
  "colombian", "chilean", "peruvian", "venezuelan", "cuban", "puerto", "rican", "dominican", "jamaican", "haitian", "indian",
  "pakistani", "bangladeshi", "nepali", "lankan", "chinese", "japanese", "korean", "vietnamese", "thai", "filipino", "filipina",
  "indonesian", "malaysian", "singaporean", "taiwanese", "russian", "ukrainian", "polish", "czech", "slovak", "hungarian",
  "romanian", "bulgarian", "serbian", "croatian", "greek", "turkish", "swedish", "norwegian", "danish", "finnish", "icelandic",
  "israeli", "iranian", "iraqi", "lebanese", "syrian", "egyptian", "moroccan", "algerian", "tunisian", "nigerian", "ghanaian",
  "kenyan", "ethiopian", "somali", "ugandan", "african", "european", "asian", "latino", "latina", "latinx", "hispanic", "arab",
  "persian", "zealander", "new", "south", "north", "east", "west", "jewish", "muslim", "catholic", "buddhist", "hindu", "mormon",
  "black", "white", "brown", "gen", "millennial", "not", "so", "just", "also", "still", "really", "sorry", "done", "back", "here",
  "ok", "okay", "tired", "obsessed",
]);
/** Whether the opener introduces the creator by name or with a stock self-introduction. */
function introducesSelf(text: string): boolean {
  if (SELF_INTRO.test(text)) return true;
  for (const match of text.matchAll(SELF_NAME)) {
    if (![match[1], match[2]].some((word) => word && NOT_A_SELF_NAME.has(word.toLowerCase()))) return true;
  }
  return false;
}
const YOU = /\b(?:you|your|you're|youre|yours|yourself|you'll|you've|you'd)\b/i;
const SIGN_OFF = /\b(?:thanks for watching|thank you for watching|see you (?:next time|soon|tomorrow|in the next one)|catch you (?:later|next time)|that'?s (?:it|all) for (?:today|now)|peace out|bye(?:-bye)?|so yeah|until next time)\W*$/i;
const TRAILING_JOINER = /\b(?:and|but|so|or|anyway|because)\W*$/i;
const NUMBER_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half)\b/i;
const NOT_A_NAME = new Set(["I", "I'm", "I've", "I'll", "I'd", "OK", "Okay"]);
const CONTRACTION = /\b\p{L}+(?:'|’)(?:s|re|ve|ll|d|m|t)\b|\b\p{L}+n(?:'|’)t\b/giu;
const ENGLISH_FUNCTION_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are", "was", "were", "it", "this", "that",
  "you", "your", "i", "my", "me", "we", "they", "he", "she", "at", "be", "have", "has", "do", "did", "not", "no", "so", "if",
  "what", "how", "just", "can", "will", "from", "by", "as", "all", "about", "up", "out", "get", "got", "don't", "it's", "i'm",
  "there", "here", "when", "then", "than", "because", "one", "like",
]);

/** Where the reading rate came from: the call, the voice sample, the creator's profile, or the default. */
export type WpmSource = "argument" | "sample" | "profile" | "default";
export type LanguageSource = "argument" | "brief" | "detected" | "default";

export type ScriptLintFlag = { line: number | null; code: ScriptLintCode; message: string };
export type ScriptLintLine = {
  n: number;
  text: string;
  words: number;
  estSeconds: number;
  startEst: number;
  beat: string | null;
  emotion: string | null;
  flags: ScriptLintCode[];
};
export type ScriptVoice = {
  paths: string[];
  sampleWords: number;
  sampleSeconds: number;
  /** Measured speaking rate; null when the sample is too short to measure (under 30 words or 10 s of speech). */
  sampleWpm: number | null;
  sampleAvgSentenceWords: number | null;
  scriptAvgSentenceWords: number;
  sampleContractionsPer100: number;
  scriptContractionsPer100: number;
};
export type ScriptLintReport = {
  source: { kind: "file" | "text"; path?: string; format: "brief" | "script" };
  language: { code: string; source: LanguageSource; englishChecks: boolean };
  wpmUsed: number;
  wpmSource: WpmSource;
  lines: ScriptLintLine[];
  totals: {
    lines: number;
    words: number;
    estSeconds: number;
    target: { min: number; max: number } | null;
    targetSource: "argument" | "brief" | null;
    withinTarget: boolean | null;
  };
  opening: {
    lines: number[];
    sentences: number;
    firstSentenceWords: number;
    firstSentenceSeconds: number;
    wordsInFirst4s: number;
    first4s: string;
    youInFirst3Sentences: boolean;
  };
  moodTurns: Array<{ line: number; from: string; to: string; atSeconds: number }>;
  voice?: ScriptVoice;
  flags: ScriptLintFlag[];
  skipped: ScriptLintCode[];
  warnings: string[];
  note: string;
};

/** A transcript of the creator speaking, as footage_index stores it: segments with timed words. */
export type VoiceSample = { path: string; segments: ReadonlyArray<{ text: string; words: ReadonlyArray<{ text: string; start: number; end: number }> }> };

export type ScriptLintOptions = {
  /** The reading rate, and whether the call or the creator's profile gave it; a voice sample's measured rate beats a profile rate. */
  wpm?: number;
  wpmSource?: "argument" | "profile";
  targetSeconds?: { min: number; max: number };
  extraStalePhrases?: readonly string[];
  /** Words and phrases the creator never says (the call's list and the profile's). */
  avoidWords?: readonly string[];
  language?: string;
  voiceSamples?: readonly VoiceSample[];
  source?: { kind: "file" | "text"; path?: string };
  /** Notes from the caller (unreadable samples and the like), passed through. */
  warnings?: readonly string[];
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Written but not said: `⟦ask: …⟧` placeholders, `[stage directions]` and
 * `{cues}`. script_read_compare leaves out the same spans.
 */
const UNSPOKEN = /⟦[^⟧]*⟧|\[[^\]]*\]|\{[^}]*\}/g;
/** A placeholder for a fact the creator hasn't given yet; one left unclosed runs to the end of the line. */
const PLACEHOLDER = /⟦[^⟧]*⟧?/g;

/** A line's spoken words: the text without placeholders, stage directions and cues. */
export function spokenText(text: string): string {
  return text.replace(UNSPOKEN, " ").replace(/\s+/g, " ").trim();
}

/** Spoken words: whitespace-separated tokens with a letter or digit in them, outside placeholders and stage directions. */
export function countWords(text: string): number {
  return words(text).length;
}
function words(text: string): string[] {
  return spokenText(text).split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token));
}

const plain = (text: string) => text.replace(/[’‘]/g, "'");

/** Each phrase from `phrases` that occurs in `text` as whole words, case-insensitive. */
function findPhrases(text: string, phrases: readonly string[]): string[] {
  const haystack = plain(text);
  const found: string[] = [];
  for (const phrase of phrases) {
    const needle = plain(phrase).trim();
    if (!needle) continue;
    const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(haystack) && !found.includes(needle.toLowerCase())) found.push(needle.toLowerCase());
  }
  return found;
}

const quoteList = (items: readonly string[]) => items.map((item) => `"${item}"`).join(", ");

/** Whether text names something concrete: a digit, a counted amount, or a capitalized name mid-sentence. */
function hasSpecifics(text: string): boolean {
  if (/\d/.test(text) || NUMBER_WORDS.test(text)) return true;
  return splitSentences(text).some((sentence) =>
    sentence.split(/\s+/).slice(1).some((token) => {
      const word = token.replace(/^[^\p{L}]+|[^\p{L}']+$/gu, "");
      return /^\p{Lu}/u.test(word) && !NOT_A_NAME.has(word);
    }));
}

/** Contractions per 100 words. */
function contractionsPer100(text: string): number {
  const total = countWords(text);
  if (!total) return 0;
  return round1(((plain(text).match(CONTRACTION) ?? []).length / total) * 100);
}

function averageSentenceWords(texts: readonly string[]): { average: number; sentences: number } {
  const sentences = texts.flatMap((text) => splitSentences(text)).filter((sentence) => countWords(sentence) > 0);
  if (!sentences.length) return { average: 0, sentences: 0 };
  return { average: round1(sentences.reduce((sum, sentence) => sum + countWords(sentence), 0) / sentences.length), sentences: sentences.length };
}

/**
 * How the creator speaks, from transcripts of them talking: speaking rate
 * over the time words are being said (pauses over a second left out),
 * sentence length and contractions, beside the script's own.
 */
export function voiceStats(samples: readonly VoiceSample[], script: readonly string[]): ScriptVoice | undefined {
  const timed = samples.flatMap((sample) => sample.segments.flatMap((segment) => segment.words)).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  if (!samples.length) return undefined;
  let seconds = 0;
  const bySource = samples.map((sample) => sample.segments.flatMap((segment) => segment.words).filter((word) => word.end > word.start).sort((a, b) => a.start - b.start));
  for (const list of bySource) {
    list.forEach((word, index) => {
      seconds += word.end - word.start;
      const next = list[index + 1];
      if (next) {
        const gap = next.start - word.end;
        if (gap > 0 && gap <= 1) seconds += gap;
      }
    });
  }
  const sampleText = samples.flatMap((sample) => sample.segments.map((segment) => segment.text)).join(" ");
  const sampleWords = timed.filter((word) => /[\p{L}\p{N}]/u.test(word.text)).length;
  const sample = averageSentenceWords([sampleText]);
  return {
    paths: samples.map((item) => item.path),
    sampleWords,
    sampleSeconds: round1(seconds),
    sampleWpm: sampleWords >= 30 && seconds >= 10 ? Math.round((sampleWords / seconds) * 60) : null,
    sampleAvgSentenceWords: sample.sentences >= 3 ? sample.average : null,
    scriptAvgSentenceWords: averageSentenceWords(script).average,
    sampleContractionsPer100: contractionsPer100(sampleText),
    scriptContractionsPer100: contractionsPer100(script.join(" ")),
  };
}

/**
 * Hints for the lint from the creator's profile entries (the `memory`
 * tool's profile): a measured reading rate ("speaks at about 170 wpm") and
 * words to avoid ("Words to avoid: hustle, grind"). Anything else is ignored.
 */
export function profileHints(entries: readonly string[]): { wpm?: number; avoidWords: string[] } {
  let wpm: number | undefined;
  const avoid: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const rate = /(\d{2,3})\s*(?:wpm|words?\s*(?:per|\/|a)\s*min(?:ute)?)\b/i.exec(entry);
    if (rate && wpm === undefined) {
      const value = Number(rate[1]);
      if (value >= SCRIPT_LINT_MIN_WPM && value <= SCRIPT_LINT_MAX_WPM) wpm = value;
    }
    const list = /\b(?:words?\s+(?:and\s+phrases\s+)?to\s+avoid|avoid(?:\s+(?:the\s+)?(?:words?|phrases?|saying))?|never\s+says?|don'?t\s+say|banned\s+(?:words?|phrases?))\s*[:\-–—]\s*(.+)$/i.exec(plain(entry));
    if (!list) continue;
    for (const raw of list[1]!.split(/[,;]|\s\/\s/)) {
      const word = raw.replace(/["“”`]/g, "").replace(/^[\s'.]+|[\s'.]+$/g, "").toLowerCase();
      if (word.length >= 2 && word.length <= 40 && /^[\p{L}\p{N}' -]+$/u.test(word) && !avoid.includes(word)) avoid.push(word);
      if (avoid.length >= 50) break;
    }
  }
  return { ...(wpm !== undefined ? { wpm } : {}), avoidWords: avoid };
}

type Run = { label: string | null; lines: BriefScriptLine[] };

/** Consecutive lines under the same beat label; an unlabeled line continues the beat above it. */
function beatRuns(lines: readonly BriefScriptLine[]): Run[] {
  const runs: Run[] = [];
  for (const line of lines) {
    const label = line.beat?.trim().toLowerCase() || null;
    const current = runs[runs.length - 1];
    if (current && (label === null || label === current.label)) current.lines.push(line);
    else runs.push({ label, lines: [line] });
  }
  return runs;
}

function language(options: ScriptLintOptions, brief: string | undefined, all: readonly string[]): ScriptLintReport["language"] {
  const given = options.language ?? brief;
  if (given?.trim()) {
    const code = given.trim().toLowerCase().split(/[-_\s]/)[0]!;
    const english = code === "en" || code === "english";
    return { code: english ? "en" : code, source: options.language ? "argument" : "brief", englishChecks: english };
  }
  const tokens = all.flatMap((text) => words(plain(text).toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ")));
  if (tokens.length < 12) return { code: "en", source: "default", englishChecks: true };
  const share = tokens.filter((token) => ENGLISH_FUNCTION_WORDS.has(token)).length / tokens.length;
  return share >= 0.12 ? { code: "en", source: "detected", englishChecks: true } : { code: "und", source: "detected", englishChecks: false };
}

/** The script a text holds: a brief's `## Script` section, or the whole text when it is only a script. */
export function scriptOf(text: string): { lines: BriefScriptLine[]; format: "brief" | "script"; warnings: string[]; target?: { min: number; max: number }; language?: string } {
  const brief = parseBrief(text);
  if (brief.hasScript || Object.keys(brief.sections).length) {
    return {
      lines: brief.script, format: "brief", warnings: brief.warnings,
      ...(brief.goal?.targetSeconds ? { target: brief.goal.targetSeconds } : {}),
      ...(brief.goal?.language ? { language: brief.goal.language } : {}),
    };
  }
  const warnings = [...brief.warnings];
  return { lines: parseScript(text, warnings), format: "script", warnings };
}

/** Lints a brief.md or a bare script. Never throws on content; an empty script is a `no-script` flag. */
export function lintScript(text: string, options: ScriptLintOptions = {}): ScriptLintReport {
  const parsed = scriptOf(text);
  const lines = parsed.lines;
  // Every check reads what is said; placeholders get their own flag.
  const said = (line: BriefScriptLine) => spokenText(line.text);
  const texts = lines.map(said);
  const placeholders = (line: BriefScriptLine) => line.text.match(PLACEHOLDER) ?? [];
  const lang = language(options, parsed.language, texts);
  const english = lang.englishChecks;
  const voice = options.voiceSamples?.length ? voiceStats(options.voiceSamples, texts) : undefined;

  let wpmUsed = SCRIPT_LINT_DEFAULT_WPM;
  let wpmSource: WpmSource = "default";
  const clampWpm = (value: number) => Math.min(SCRIPT_LINT_MAX_WPM, Math.max(SCRIPT_LINT_MIN_WPM, Math.round(value)));
  if (options.wpm !== undefined && options.wpmSource !== "profile") { wpmUsed = clampWpm(options.wpm); wpmSource = "argument"; }
  else if (voice?.sampleWpm) { wpmUsed = clampWpm(voice.sampleWpm); wpmSource = "sample"; }
  else if (options.wpm !== undefined) { wpmUsed = clampWpm(options.wpm); wpmSource = "profile"; }
  const seconds = (count: number) => (count / wpmUsed) * 60;

  const flags: ScriptLintFlag[] = [];
  const byLine = new Map<number, ScriptLintCode[]>();
  const flag = (line: number | null, code: ScriptLintCode, message: string) => {
    flags.push({ line, code, message });
    if (line !== null) byLine.set(line, [...(byLine.get(line) ?? []), code]);
  };

  // Timing.
  let clock = 0;
  const timed = lines.map((line) => {
    const count = countWords(said(line));
    const start = clock;
    clock += seconds(count);
    return { line, words: count, start, seconds: seconds(count) };
  });
  const totalWords = timed.reduce((sum, item) => sum + item.words, 0);
  const totalSeconds = round1(clock);
  const target = options.targetSeconds ?? parsed.target ?? null;
  const targetSource = options.targetSeconds ? "argument" : parsed.target ? "brief" : null;

  if (!lines.length) {
    flag(null, "no-script", parsed.format === "brief"
      ? 'This brief has no script lines. Write them under "## Script" as "1. [opener · curious] sentence", one per line (docs/reference/brief.md).'
      : "No script lines found. Pass the script text or the project's brief.md.");
  }

  // The opener.
  const marked = lines.filter((line) => beatKind(line.beat) === "opener");
  const opener = marked.length ? marked : lines.slice(0, 1);
  const openerText = opener.map(said).join(" ");
  const openerSentences = opener.reduce((sum, line) => sum + splitSentences(said(line)).length, 0);
  const firstSentence = lines.length ? splitSentences(texts[0]!)[0] ?? "" : "";
  const firstSentenceWords = countWords(firstSentence);
  const allWords = words(texts.join(" "));
  const windowWords = Math.min(allWords.length, Math.floor((OPENING_WINDOW_SECONDS * wpmUsed) / 60));
  const firstThree = texts.flatMap((text) => splitSentences(text)).slice(0, 3).join(" ");
  const youEarly = YOU.test(plain(firstThree));
  if (lines.length) {
    const first = lines[0]!;
    const at = opener[0]!.n;
    if (english && GREETING.test(plain(said(first)))) flag(first.n, "greeting-opener", "Opens with a greeting. A stranger owes the video nothing yet; start on the viewer's problem or the result.");
    if (english && SERIES.some((pattern) => pattern.test(plain(openerText)))) flag(at, "series-counter-opener", "The opener counts the series (day, part, episode). Mention the series later, if at all.");
    if (english && introducesSelf(plain(openerText))) flag(at, "self-intro-opener", "The opener introduces the creator. Trade the name for a reason to listen (a result, a number, what they have done).");
    if (openerSentences > 2) flag(at, "long-opener", `The opener runs ${openerSentences} sentences; keep it to two at most.`);
    if (seconds(firstSentenceWords) > FIRST_SENTENCE_SECONDS) flag(first.n, "slow-opener", `The first sentence takes about ${round1(seconds(firstSentenceWords))} s to say at ${wpmUsed} wpm (${firstSentenceWords} words); land it in under ${FIRST_SENTENCE_SECONDS} s.`);
    if (english && !youEarly) flag(first.n, "no-early-you", 'Nothing in the first three sentences speaks to the viewer as "you".');
  }

  // Line by line.
  const seen = new Map<string, number>();
  const stale = [...(english ? DEFAULT_STALE_PHRASES : []), ...(options.extraStalePhrases ?? [])];
  for (const { line, words: count } of timed) {
    const text = said(line);
    const open = placeholders(line);
    if (open.length) flag(line.n, "open-placeholder", `Waiting on the creator: ${open.join(", ")}. Ask, and put their answer in; never fill it in yourself. Until then the script is a draft.`);
    if (english) {
      const group = GROUP_ADDRESS.map((pattern) => pattern.exec(plain(text))?.[0]).filter((match): match is string => !!match);
      if (group.length) flag(line.n, "group-address", `Addresses a crowd (${quoteList(group.map((item) => item.toLowerCase()))}); talk to one viewer as "you".`);
    }
    const long = splitSentences(text).map(countWords).filter((length) => length > LONG_SENTENCE_WORDS);
    if (long.length) flag(line.n, "long-sentence", `A sentence runs ${Math.max(...long)} words; split anything over ${LONG_SENTENCE_WORDS} so it can be said in one breath.`);
    if (english) {
      const hedges = findPhrases(text, HEDGES);
      if (hedges.length) flag(line.n, "hedge", `Hedges (${quoteList(hedges)}) soften the claim; commit or cut.`);
      const jargon = findPhrases(text, JARGON);
      if (jargon.length) flag(line.n, "jargon", `${quoteList(jargon)} ${jargon.length === 1 ? "is" : "are"} not how a viewer talks; use their words or define it in the same breath.`);
    }
    const avoided = findPhrases(text, options.avoidWords ?? []);
    if (avoided.length) flag(line.n, "avoided-word", `${quoteList(avoided)} ${avoided.length === 1 ? "is" : "are"} on the creator's words-to-avoid list.`);
    const worn = findPhrases(text, stale);
    if (worn.length) flag(line.n, "stale-phrase", `Worn phrase${worn.length === 1 ? "" : "s"} ${quoteList(worn)}; say the specific thing instead.`);
    const key = plain(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
    if (count >= 3 && seen.has(key)) flag(line.n, "duplicate-line", `Repeats line ${seen.get(key)}. Keep a repeat only when it is deliberate.`);
    else if (count >= 3) seen.set(key, line.n);
  }

  // Emotions.
  const labelled = lines.filter((line) => line.emotion?.trim());
  if (lines.length && !labelled.length) flag(null, "missing-emotion", "No line has an emotion label; label each line ([beat · emotion]) before the rewrite passes.");
  else if (labelled.length < lines.length) {
    const missing = lines.filter((line) => !line.emotion?.trim()).map((line) => line.n);
    flag(missing[0]!, "missing-emotion", `Line${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no emotion label.`);
  }
  const moodTurns: ScriptLintReport["moodTurns"] = [];
  let mood: string | null = null;
  for (const { line, start } of timed) {
    const emotion = line.emotion?.trim().toLowerCase();
    if (!emotion) continue;
    if (mood !== null && emotion !== mood) moodTurns.push({ line: line.n, from: mood, to: emotion, atSeconds: round1(start) });
    mood = emotion;
  }

  // Beats.
  const runs = beatRuns(lines);
  const points = runs.filter((run) => beatKind(run.label) === "point");
  if (points.length > MAX_POINTS) flag(points[MAX_POINTS]!.lines[0]!.n, "too-many-points", `${points.length} separate points; one video carries about ${MAX_POINTS} at most. Split the rest into their own videos.`);
  const anyBeat = lines.some((line) => line.beat?.trim());
  // A beat waiting on a placeholder already has its detail coming from the creator.
  const waiting = (group: readonly BriefScriptLine[]) => group.some((line) => placeholders(line).length > 0);
  if (anyBeat) {
    for (const run of runs) {
      const kind = beatKind(run.label);
      const story = run.label?.split(/[\s:#-]+/)[0] === "story";
      if (kind !== "point" && kind !== "proof" && kind !== "payoff" && !story) continue;
      if (waiting(run.lines)) continue;
      if (!hasSpecifics(run.lines.map(said).join(" "))) flag(run.lines[0]!.n, "no-specifics-in-beat", `The ${run.label} beat has no number, name or place; add one the creator gave you, or a ⟦ask: …⟧ placeholder for one.`);
    }
  } else if (lines.length && !waiting(lines) && !hasSpecifics(texts.join(" "))) {
    flag(null, "no-specifics-in-beat", "No line has a number, a name or a place; give the main point one the creator gave you, or a ⟦ask: …⟧ placeholder for one.");
  }

  // The close.
  const last = lines[lines.length - 1];
  if (last && lines.length > 1) {
    const close = plain(said(last)).trim();
    const why = /\?["')\]]*$/.test(close) ? "ends on a question"
      : /(?:\.\.\.|…|[-–—])["')\]]*$/.test(close) ? "trails off"
      : english && TRAILING_JOINER.test(close) ? "trails off on a joining word"
      : english && SIGN_OFF.test(close) ? "is a generic sign-off"
      : null;
    if (why) flag(last.n, "weak-close", `The last line ${why}. End on one action, one line to remember, or the payoff.`);
  }

  // Length.
  const withinTarget = target && lines.length ? totalSeconds >= target.min && totalSeconds <= target.max : null;
  if (target && lines.length && totalSeconds > target.max) {
    const extra = Math.ceil(((totalSeconds - target.max) * wpmUsed) / 60);
    flag(null, "over-length", `About ${totalSeconds} s at ${wpmUsed} wpm, over the ${target.max} s target; cut about ${extra} words.`);
  }
  if (target && lines.length && totalSeconds < target.min) {
    const short = Math.ceil(((target.min - totalSeconds) * wpmUsed) / 60);
    flag(null, "under-length", `About ${totalSeconds} s at ${wpmUsed} wpm, under the ${target.min} s target; about ${short} more words, or a shorter target.`);
  }

  // Voice.
  if (voice && lines.length) {
    if (voice.sampleAvgSentenceWords !== null && voice.scriptAvgSentenceWords > voice.sampleAvgSentenceWords * 1.4 + 2) {
      flag(null, "voice-long-sentences", `Script sentences average ${voice.scriptAvgSentenceWords} words; the creator's own speech averages ${voice.sampleAvgSentenceWords}. Shorten them to sound like them.`);
    }
    if (english && voice.sampleContractionsPer100 >= 2 && voice.scriptContractionsPer100 < voice.sampleContractionsPer100 * 0.5) {
      flag(null, "voice-formal", `The creator uses ${voice.sampleContractionsPer100} contractions per 100 words; the script uses ${voice.scriptContractionsPer100}. Contract where they would ("it's", "don't").`);
    }
  }

  const order = new Map(SCRIPT_LINT_CODES.map((code, index) => [code, index]));
  flags.sort((a, b) => (a.line ?? -1) - (b.line ?? -1) || order.get(a.code)! - order.get(b.code)!);
  return {
    source: { ...(options.source ?? { kind: "text" }), format: parsed.format },
    language: lang,
    wpmUsed,
    wpmSource,
    lines: timed.map(({ line, words: count, start, seconds: length }) => ({
      n: line.n,
      text: line.text,
      words: count,
      estSeconds: round1(length),
      startEst: round1(start),
      beat: line.beat?.trim() || null,
      emotion: line.emotion?.trim() || null,
      flags: byLine.get(line.n) ?? [],
    })),
    totals: { lines: lines.length, words: totalWords, estSeconds: totalSeconds, target, targetSource, withinTarget },
    opening: {
      lines: lines.length ? opener.map((line) => line.n) : [],
      sentences: lines.length ? openerSentences : 0,
      firstSentenceWords,
      firstSentenceSeconds: round1(seconds(firstSentenceWords)),
      wordsInFirst4s: windowWords,
      first4s: allWords.slice(0, windowWords).join(" "),
      youInFirst3Sentences: youEarly,
    },
    moodTurns,
    ...(voice ? { voice } : {}),
    flags,
    skipped: english ? [] : [...ENGLISH_ONLY_CODES],
    warnings: [...parsed.warnings, ...(options.warnings ?? [])],
    note: SCRIPT_LINT_NOTE,
  };
}
