/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, checkWindow, windowFields } from "../schemas";
import {
  SCRIPT_LINT_CODES,
  SCRIPT_LINT_DEFAULT_WPM,
  SCRIPT_LINT_MAX_WPM,
  SCRIPT_LINT_MIN_WPM,
  SCRIPT_LINT_TEXT_MAX,
} from "../script-lint";

export const ScriptLintCode = z.enum(SCRIPT_LINT_CODES);
const Seconds = z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() });
const LintFlag = z.object({
  line: z.int().nullable().describe("the script line number, or null for the whole script"),
  code: ScriptLintCode,
  message: z.string(),
});
const LintLine = z.object({
  n: z.int(),
  text: z.string(),
  words: z.int().nonnegative(),
  estSeconds: z.number().nonnegative().describe("spoken length at wpmUsed; pauses between lines are not counted"),
  startEst: z.number().nonnegative().describe("estimated start in the read, in seconds"),
  beat: z.string().nullable(),
  emotion: z.string().nullable(),
  flags: z.array(ScriptLintCode),
});
const Voice = z.object({
  paths: z.array(z.string()),
  sampleWords: z.int().nonnegative(),
  sampleSeconds: z.number().nonnegative().describe("time spent speaking in the samples, pauses over a second left out"),
  sampleWpm: z.int().nullable().describe("measured speaking rate; null under 30 words or 10 s of speech"),
  sampleAvgSentenceWords: z.number().nullable(),
  scriptAvgSentenceWords: z.number(),
  sampleContractionsPer100: z.number(),
  scriptContractionsPer100: z.number(),
});

export const scriptLint = defineTool({
  name: "script_lint",
  title: "Lint a script",
  description: `Deterministic checks for a short-form script, by default the open project's brief.md (its "## Script" section, format in docs/reference/brief.md), or inline text (a brief or bare lines). Counts words per line, estimates spoken seconds at a reading rate (the wpm argument, else the rate measured from voiceSample, else a rate in the creator's memory profile, else ${SCRIPT_LINT_DEFAULT_WPM}), reports what is heard in the first 4 seconds, mood turns between emotion labels, and the length against the target (the argument, else the brief's Goal). Flags greeting, series-counter and self-introduction openers, a long or slow opener, no early "you", crowd address, long sentences, beats without a number or name, hedges, jargon, the creator's words to avoid, stale phrases, missing emotion labels, too many points, a weak close, duplicates, and length. voiceSample compares sentence length and contractions with the creator's own indexed speech (footage_index first). Word lists are English; other languages skip those checks and list them in skipped. The flags are heuristic prompts, not editorial judgments: fix each one or say why it stays. Reads only; never edits the brief.`,
  input: z
    .object({
      path: z.string().trim().min(1).max(500).optional().describe("project-relative markdown file to read (default: brief.md); exclusive with text"),
      text: z.string().min(1).max(SCRIPT_LINT_TEXT_MAX).optional().describe("the script or a whole brief, inline, instead of a project file"),
      wpm: z.int().min(SCRIPT_LINT_MIN_WPM).max(SCRIPT_LINT_MAX_WPM).optional().describe(`reading rate in words per minute (default: measured from voiceSample, else the creator's profile, else ${SCRIPT_LINT_DEFAULT_WPM})`),
      targetSeconds: z.object({ min: z.number().min(0).max(600), max: z.number().min(5).max(600) }).optional().describe("target spoken length; default: the brief's Goal target"),
      extraStalePhrases: z.array(z.string().trim().min(2).max(80)).max(50).optional().describe("more worn phrases to flag, on top of Cutroom's list and the profile's"),
      avoidWords: z.array(z.string().trim().min(2).max(40)).max(50).optional().describe("words or phrases this creator never says, on top of the profile's words to avoid"),
      voiceSample: z.array(AssetPath).min(1).max(5).optional().describe("library paths of recordings of the creator talking, already indexed by footage_index"),
      language: z.string().trim().regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/).optional().describe("language tag such as en or fr (default: the brief's Goal language, else detected)"),
    })
    .superRefine((value, ctx) => {
      if (value.path !== undefined && value.text !== undefined) ctx.addIssue({ code: "custom", path: ["text"], message: "pass either path or text, not both" });
      if (value.targetSeconds && value.targetSeconds.min > value.targetSeconds.max) {
        ctx.addIssue({ code: "custom", path: ["targetSeconds"], message: `targetSeconds.min (${value.targetSeconds.min}) must not exceed max (${value.targetSeconds.max})` });
      }
    }),
  output: z.object({
    source: z.object({ kind: z.enum(["file", "text"]), path: z.string().optional(), format: z.enum(["brief", "script"]) }),
    language: z.object({ code: z.string(), source: z.enum(["argument", "brief", "detected", "default"]), englishChecks: z.boolean() }),
    wpmUsed: z.int(),
    wpmSource: z.enum(["argument", "sample", "profile", "default"]),
    lines: z.array(LintLine),
    totals: z.object({
      lines: z.int().nonnegative(),
      words: z.int().nonnegative(),
      estSeconds: z.number().nonnegative(),
      target: Seconds.nullable(),
      targetSource: z.enum(["argument", "brief"]).nullable(),
      withinTarget: z.boolean().nullable(),
    }),
    opening: z.object({
      lines: z.array(z.int()).describe("the lines treated as the opener: those marked opener, else line 1"),
      sentences: z.int().nonnegative(),
      firstSentenceWords: z.int().nonnegative(),
      firstSentenceSeconds: z.number().nonnegative(),
      wordsInFirst4s: z.int().nonnegative(),
      first4s: z.string().describe("the words heard in the first 4 seconds"),
      youInFirst3Sentences: z.boolean(),
    }),
    moodTurns: z.array(z.object({ line: z.int(), from: z.string(), to: z.string(), atSeconds: z.number().nonnegative() })),
    voice: Voice.optional(),
    flags: z.array(LintFlag),
    skipped: z.array(ScriptLintCode).describe("checks not run because the script is not in English"),
    warnings: z.array(z.string()).describe("what the brief parser had to guess, and samples that could not be read"),
    note: z.string(),
  }),
  environment: "main",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

// script_read_compare: a recorded read or a multi-take shoot against its
// script. The alignment itself lives with the renderer's footage engine
// (apps/web/src/engine/script-align.ts); this is its contract.

/** The longest inline script read by script_read_compare. */
export const SCRIPT_READ_TEXT_MAX = 100_000;
/** Where script_read_compare keeps its last result, inside the project. */
export const SCRIPT_READ_FILE = ".cutroom/script-read.json";

const SourceRange = z.object({ start: z.number(), end: z.number() });
const ReadTake = z.object({
  sourceStart: z.number().describe("first aligned word, source seconds"),
  sourceEnd: z.number().describe("last aligned word, source seconds"),
  keep: z
    .object({ sourceIn: z.number(), sourceOut: z.number() })
    .describe("the take with a short handle that never reaches a neighbouring word; usable as a footage_cut passage's sourceIn/sourceOut"),
  coverage: z.number().min(0).max(1).describe("share of the line's words said exactly, after normalization"),
  spoken: z.string().describe("the recognized words of the take"),
  omitted: z.array(z.string()).describe("script words not said, as runs of normalized words"),
  inserted: z.array(z.string()).describe("words said that the script does not have (ad-libs, restarts inside the line)"),
  substituted: z.array(z.object({ written: z.string(), spoken: z.string() })).describe("script words said differently"),
  pauses: z.array(SourceRange).describe("silences of at least pauseSeconds between words inside the take"),
  fillers: z.int().nonnegative().describe("um, uh and similar sounds inside the take"),
  wpm: z.number().nullable().describe("recognized words per minute over the take, pauses included and fillers left out, counted as script_lint counts words; null under one second"),
});
const ReadLine = z.object({
  n: z.int(),
  text: z.string(),
  words: z.int().nonnegative().describe("spoken words after normalization; 0 for a line with nothing to say"),
  takes: z.array(ReadTake).describe("every take found, in recording order"),
  takeCount: z.int().nonnegative().describe("takes found, also when detail is best and only the suggested one is listed"),
  best: z.int().nullable().describe("index into takes of the suggested take: for a line of up to four words, one read on its own or right beside a neighbouring line's take comes before one said in passing inside other talk; then the most complete, the fewest added or changed words, the fewest pauses, and the latest; null when the line was not found"),
});

export const scriptReadCompare = defineTool({
  name: "script_read_compare",
  title: "Compare a recorded read to the script",
  description: `Line a recorded read-through or a multi-take shoot up with its script: by default the "## Script" lines of the open project's brief.md (format in docs/reference/brief.md), or another project markdown file, or inline text. Uses the recording's footage index transcript when the source has one, and otherwise transcribes the window locally with Whisper (first use downloads the model; nothing is uploaded). Words are compared after normalization: case, punctuation, contractions and numerals ("1,000" and "one thousand" match). Each line can have several takes, found wherever and however often it was read; each take reports its source range, coverage, omitted, inserted and substituted words, pauses, fillers and pace, and best names the suggested one. Also returns the lines never said (unspoken), the order lines were read in, speech outside every take (ad-libs, false starts, slate talk), and keep ranges for the suggested takes in script order. For an imported recording, passages go straight to footage_cut to assemble the scripted cut; keep ranges are source seconds, which match transcript_edit_apply scene time only when the scene plays this recording untrimmed from 0. The full result is saved to ${SCRIPT_READ_FILE} in the project. Recognition is approximate and speakers are not separated: listen at the joins before final cuts.`,
  input: z
    .object({
      path: AssetPath.describe("the recording: an imported library path (preferred: reuses its footage index, and passages work with footage_cut) or an absolute local file path"),
      script: z
        .object({
          path: z.string().trim().min(1).max(500).optional().describe("project-relative markdown file (default: brief.md); exclusive with text"),
          text: z.string().min(1).max(SCRIPT_READ_TEXT_MAX).optional().describe("the script inline: a brief with a \"## Script\" section, or bare lines, one sentence per line"),
        })
        .optional()
        .describe("where the script comes from (default: the open project's brief.md)"),
      start: windowFields.start.describe("source window start (default 0)"),
      end: windowFields.end.describe("source window end (default: the recording's end); recordings up to two hours long"),
      pauseSeconds: z.number().min(0.2).max(2).default(0.6).describe("a silence at least this long inside a take is listed as a pause; lines recorded closer together than this share one keep range"),
      minCoverage: z.number().min(0.2).max(1).default(0.5).describe("share of a line's words (and of its rarer words) a stretch of speech must say exactly to count as a take"),
      detail: z.enum(["full", "best"]).default("full").describe("full lists every take; best lists only each line's suggested take (the saved file always has every take)"),
    })
    .superRefine((value, ctx) => {
      if (value.script?.path !== undefined && value.script.text !== undefined) {
        ctx.addIssue({ code: "custom", path: ["script", "text"], message: "pass either script.path or script.text, not both" });
      }
      checkWindow(value, ctx);
    }),
  output: z.object({
    source: z.object({
      path: z.string(),
      assetId: z.string().nullable().describe("the library asset, when the recording is imported"),
      fingerprint: z.string().nullable().describe("the footage index's source SHA-256, when the transcript came from the index"),
      start: z.number(),
      end: z.number(),
      transcript: z.enum(["footage-index", "transcribed"]),
    }),
    script: z.object({
      kind: z.enum(["file", "text"]),
      path: z.string().optional(),
      format: z.enum(["brief", "script"]),
      lines: z.int().nonnegative(),
    }),
    lines: z.array(ReadLine),
    unspoken: z.array(z.int()).describe("line numbers with words that no take was found for"),
    readOrder: z.array(z.int()).describe("line numbers in the order their suggested takes were recorded"),
    extraSpeech: z
      .array(z.object({ text: z.string(), start: z.number(), end: z.number(), words: z.int().positive() }))
      .describe("speech outside every take, in recording order (at most 100 stretches)"),
    extraSpeechTotal: z.int().nonnegative(),
    coverage: z.number().min(0).max(1).describe("mean coverage of the suggested takes, unspoken lines counting 0"),
    overallWpm: z.number().nullable().describe("words per minute over the suggested takes, in the unit script_lint's wpm takes"),
    keep: z
      .array(z.object({ start: z.number(), end: z.number(), lines: z.array(z.int()) }))
      .describe("the suggested takes in script order, source seconds; lines recorded back to back share a range"),
    passages: z
      .array(z.object({ assetId: z.string(), fingerprint: z.string(), sourceIn: z.number(), sourceOut: z.number(), lines: z.array(z.int()) }))
      .describe("keep as footage_cut passages, in script order; empty unless the recording is imported and indexed"),
    savedPath: z.string().nullable().describe(`absolute path of ${SCRIPT_READ_FILE}, or null when no project is open or it could not be written`),
    warnings: z.array(z.string()),
    limitations: z.array(z.string()),
  }),
  environment: "renderer",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
