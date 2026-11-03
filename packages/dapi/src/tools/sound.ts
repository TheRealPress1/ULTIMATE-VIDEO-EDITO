/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Audio intelligence, powered by earshot (MIT, github.com/Leonxlnx/earshot):
// `sound_analyze` asks earshot's local CLAP and AudioSet models what sounds,
// music and effects sound like; `sound_effects` renders takes from its bank
// of code-made sounds into the project. Both run on this Mac, through an
// add-on the app installs by itself the first time either tool is called.

import { z } from "zod";
import { defineTool } from "../tool";
import { Bytes } from "../schemas";

export const SOUND_ACTIONS = ["describe", "match", "rank", "find", "compare", "ab", "realness", "measure", "timeline", "sheet", "critique"] as const;
export type SoundAction = (typeof SOUND_ACTIONS)[number];

/**
 * The fields each action takes, by the names earshot gives them, and which
 * of them it needs. The handler passes exactly these on.
 */
export const SOUND_ANALYZE_FIELDS: Record<SoundAction, { required: readonly string[]; optional: readonly string[] }> = {
  describe: { required: ["path"], optional: ["start", "end", "top", "full"] },
  match: { required: ["path", "query"], optional: ["alts", "start", "end", "full"] },
  rank: { required: ["paths", "query"], optional: ["top", "full"] },
  find: { required: ["path", "query"], optional: ["top", "kind", "win", "hop", "start", "end", "full"] },
  compare: { required: ["path", "refs"], optional: ["k", "start", "end", "full"] },
  ab: { required: ["a", "b"], optional: ["query", "refs", "a_start", "a_end", "b_start", "b_end", "full"] },
  realness: { required: ["path"], optional: ["start", "end", "ast", "full"] },
  measure: { required: ["path"], optional: ["start", "end", "music", "light", "full"] },
  timeline: { required: ["path"], optional: ["video", "cues", "start", "end", "detail", "full"] },
  sheet: { required: ["path"], optional: ["video", "cues", "start", "end", "detail", "full"] },
  critique: { required: ["path"], optional: ["video", "profile", "fast", "full"] },
};

/** `top` per action: earshot's own bounds and defaults. */
const TOP_LIMITS: Partial<Record<SoundAction, { max: number }>> = { describe: { max: 30 }, rank: { max: 500 }, find: { max: 50 } };

const LocalPath = z.string().trim().min(1).max(4096);
const Seconds = z.number().nonnegative();
const PathList = z.union([LocalPath, z.array(LocalPath).min(1).max(200)]);

const analyzeInput = z
  .object({
    action: z.enum(SOUND_ACTIONS).describe("what to ask; see the tool description for each action's fields"),
    path: LocalPath.optional().describe("the sound or video to analyze: a library path (`music/theme.m4a`, needs an open project), a project-relative or an absolute local path; for realness also a folder or glob"),
    paths: PathList.optional().describe("rank: candidate files, folders (searched recursively) or globs"),
    query: z.string().trim().min(1).max(500).optional().describe("match, rank, find (and optionally ab): a plain description of the sound itself, e.g. `a deep thocky mechanical keyboard press`"),
    alts: z.array(z.string().trim().min(1).max(500)).min(1).max(5).optional().describe("match: 1-5 plausible alternative descriptions that compete with the query"),
    top: z.int().min(1).max(500).optional().describe("describe: tags per category, 1-30 (default 8); rank: best N to return (default 20); find: segments, 1-50 (default 5)"),
    kind: z.enum(["auto", "event", "texture"]).optional().describe("find: `event` = onset-based trims (hits, clicks, steps), `texture` = plain windows (beds, ambiences), `auto` (default) scores both"),
    win: z.number().positive().max(600).optional().describe("find: texture window length in seconds (default: duration / 6, clamped to 1-5 s)"),
    hop: z.number().positive().max(600).optional().describe("find: hop between texture windows in seconds"),
    refs: PathList.optional().describe("compare (and optionally ab): reference files, folders or globs"),
    k: z.int().min(1).max(50).optional().describe("compare: nearest references to list (default 5)"),
    a: LocalPath.optional().describe("ab: sound A, e.g. the current version"),
    b: LocalPath.optional().describe("ab: sound B, e.g. the new render"),
    a_start: Seconds.optional().describe("ab: use A only from this time (s)"),
    a_end: z.number().positive().optional().describe("ab: use A only up to this time (s)"),
    b_start: Seconds.optional().describe("ab: use B only from this time (s)"),
    b_end: z.number().positive().optional().describe("ab: use B only up to this time (s)"),
    start: Seconds.optional().describe("start of the segment to analyze, seconds"),
    end: z.number().positive().optional().describe("end of the segment, seconds"),
    ast: z.boolean().optional().describe("realness: also run the AudioSet tagger for synth-class evidence (slower)"),
    music: z.boolean().optional().describe("measure: also estimate tempo, beats and key (music only)"),
    light: z.boolean().optional().describe("measure: levels and spectrum only (skips onsets, harmonic ratio, pitch)"),
    video: LocalPath.optional().describe("timeline, sheet, critique: the film (mp4/mov) for picture cuts and frames; a video `path` is read for its picture by itself"),
    cues: z.union([z.array(Seconds).min(1).max(2000), z.string().trim().min(1).max(4096)]).optional().describe("timeline, sheet: picture event times as a list of seconds, `\"1.2,3.4\"` or JSON text, or the path of a cues JSON file ({fps, events: [{f or t, kind}]}), resolved like `path`"),
    detail: z.enum(["low", "normal", "high"]).optional().describe("timeline, sheet: `low` (fast), `normal` (default) or `high` (every event tagged, slow)"),
    profile: LocalPath.optional().describe("critique: a reference profile JSON from `earshot profile` (default: the bundled launch films)"),
    fast: z.boolean().optional().describe("critique: skip the AudioSet and realness passes (seconds instead of minutes)"),
    full: z.boolean().optional().describe("return earshot's complete JSON instead of the compact one"),
  })
  .superRefine((value, ctx) => {
    const fields = SOUND_ANALYZE_FIELDS[value.action];
    const allowed = new Set(["action", ...fields.required, ...fields.optional]);
    for (const field of fields.required) {
      if ((value as Record<string, unknown>)[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `${value.action} needs \`${field}\`.` });
    }
    for (const [field, given] of Object.entries(value)) {
      if (given !== undefined && !allowed.has(field)) ctx.addIssue({ code: "custom", path: [field], message: `\`${field}\` doesn't apply to ${value.action}.` });
    }
    const limit = TOP_LIMITS[value.action];
    if (value.top !== undefined && limit && value.top > limit.max) ctx.addIssue({ code: "custom", path: ["top"], message: `${value.action} takes top 1-${limit.max}.` });
    if (value.start !== undefined && value.end !== undefined && value.end <= value.start) ctx.addIssue({ code: "custom", path: ["end"], message: "end must be after start." });
    if (value.a_start !== undefined && value.a_end !== undefined && value.a_end <= value.a_start) ctx.addIssue({ code: "custom", path: ["a_end"], message: "a_end must be after a_start." });
    if (value.b_start !== undefined && value.b_end !== undefined && value.b_end <= value.b_start) ctx.addIssue({ code: "custom", path: ["b_end"], message: "b_end must be after b_start." });
  });

const analyzeOutput = {
  action: z.enum(SOUND_ACTIONS),
  version: z.string().describe("the earshot version that answered"),
  summary: z.string().describe("earshot's plain-language answer (for timeline, the listening transcript too)"),
  result: z.record(z.string(), z.unknown()).describe("earshot's JSON: compact (floats to 3 decimals, long lists cut) unless `full`"),
  sheet: z.string().optional().describe("sheet: the PNG, in a fresh temp folder; its picture comes inline"),
  ignored: z.array(z.string()).optional().describe("fields this earshot version did not take"),
};

export const soundAnalyze = defineTool({
  name: "sound_analyze",
  title: "Analyze sound",
  description:
    "Hear what sounds, music and sound effects sound like — not the words spoken (use transcribe/listen for speech) — with earshot's local CLAP and AudioSet models. Actions: `describe` (tags and a one-paragraph summary: use first on any unknown file, and to check a download really is what its title says); `match` (how well one file fits a description: calibrated z and verdict, z >= 3 strong, 2.5-3 plausible, 2-2.5 weak; give 1-5 plausible `alts`); `rank` (sort many files by a description); `find` (the best moments in a long recording, as start/end trims); `compare` (similarity to reference files); `ab` (two files or trims against a description or references); `realness` (real recording vs simple code-synthesized sound); `measure` (exact LUFS, true peak, noise floor, clipping, onsets, tempo; no models); `timeline` (a listening transcript of a soundtrack or film: events, loudness, sync to cuts or `cues`); `sheet` (an annotated picture of a soundtrack, shown inline); `critique` (a scorecard against professional launch films). Vocals check, \"is this an instrumental?\": describe it, or match `an instrumental without vocals` with alts [`a song with singing`]. Paths are library paths (open project), project-relative or absolute local files, folders and globs where noted, never URLs: download first. For an edited scene, export a draft to a temporary path and analyze that file. Verdicts are model evidence, not proof; trust measurements most. Everything runs on this Mac. The first call installs audio intelligence by itself (about 2.4 GB, a few minutes); if a call answers that it is still installing, carry on with other work and call again later. A new worker loads the models first (about 10 s); later calls are fast.",
  input: analyzeInput,
  output: z.object(analyzeOutput),
  /** What the handler returns: sheet's picture as bytes, which the server inlines. */
  result: z.object({ ...analyzeOutput, image: z.object({ bytes: Bytes, mimeType: z.string() }).optional() }),
  environment: "main",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

/** A sound bank id: `<category>/<member>`, `pluck/<name>` or `fit/<role>/<name>`. */
const SoundId = z.string().trim().min(3).max(120).regex(/^[a-z0-9_]+(?:\/[a-z0-9_.-]+){1,2}$/i, "a bank id such as `whoosh_fast/crisp` (see action list)");

const Audit = z.object({
  ok: z.boolean().describe("false when any warning was raised"),
  summary: z.string(),
  warnings: z.array(z.object({ code: z.string(), msg: z.string() })).describe("clicks, edge, clipping, dc, ring, truncated, silent, rising_glide, stacked…"),
  notes: z.array(z.object({ code: z.string(), msg: z.string() })),
});

const BankSound = z.object({
  id: z.string(),
  category: z.string(),
  member: z.string().optional(),
  type: z.string().optional().describe("forge (code-made), fit (fitted from a CC0 recording) or pluck"),
  durationSeconds: z.number().optional(),
  onsetSeconds: z.number().optional(),
  peakSeconds: z.number().optional(),
  endSeconds: z.number().optional(),
  kinds: z.array(z.string()).describe("the cue kinds it serves, e.g. `whoosh.short`, `hit`, `key`"),
  knobs: z.array(z.string()).describe("`dur <how>` (length can be set), `apex` (whoosh family: the loudest moment can be placed), `pitch <native note> (<range>)` (tonal sounds)"),
  notes: z.string().optional().describe("what it is for, when that says more than its category's use"),
});

const BankCategory = z.object({
  category: z.string(),
  count: z.int().nonnegative(),
  kinds: z.array(z.string()),
  use: z.string().optional(),
  ids: z.array(z.string()),
});

export const soundEffects = defineTool({
  name: "sound_effects",
  title: "Render sound effects",
  description:
    "Sound effects from earshot's bank of 252 original, code-made sounds (MIT): whooshes, impacts, clicks, keys, pops, risers, UI sounds, tuned plucks; no models, no network, about a second per take. `list` shows the bank's categories with their ids, cue kinds and use; with a `category` (e.g. `whoosh_fast`, `pro_impact`, `typing_key`) or a cue `kind` (e.g. `whoosh`, `hit`, `key`) also each sound's length, onset and peak times and knobs. `render` makes one take into the open project's `assets/sfx/` and imports it into the library: `dur` sets its exact length, `apex` when its loudest moment comes (whoosh family), `pitch` a note (`E5`) or Hz for tonal sounds, `seed` another take; the same id, knobs and seed reuse the same file (under the name it got first). It returns `src` for JSX, the measured `onsetSeconds`, `peakSeconds` and `endSeconds`, and earshot's model-free audit. Place a take so its sync point lands on the cue: start = cue − onsetSeconds for clicks, keys, pops and hits; cue − peakSeconds for whooshes and swells; cue − endSeconds for risers that stop on their loudest moment. `check` audits any audio file the same way (clicks, clipping, truncation, ring, a cheap rising pitch glide). Takes are credited in the project's CREDITS.md. The first call installs audio intelligence by itself (see sound_analyze); if it answers that it is still installing, carry on and call again later.",
  input: z
    .object({
      action: z.enum(["list", "render", "check"]).default("list"),
      category: z.string().trim().min(1).max(60).optional().describe("list: only this category, e.g. `whoosh_fast`; check: the bank category, for context"),
      kind: z.string().trim().min(1).max(60).optional().describe("list: only sounds for this cue kind or kit role, e.g. `whoosh` (short and long), `hit`, `key`, `bell`"),
      id: SoundId.optional().describe("render: the bank id from list, e.g. `whoosh_fast/crisp`"),
      dur: z.number().min(0.01).max(60).optional().describe("render: exact length in seconds"),
      apex: z.number().positive().max(60).optional().describe("render: seconds from the start to the loudest moment (whoosh family)"),
      pitch: z.string().trim().min(1).max(12).regex(/^(?:[A-Ga-g](?:#|b|s)?-?\d|\d+(?:\.\d+)?)$/, "a note such as `E5`, `Eb6` or a frequency in Hz such as `440`").optional().describe("render: a note (`E5`, `Eb6`) or Hz (`440`), through the recipe's own pitch parameter"),
      seed: z.int().min(0).max(2 ** 31 - 1).optional().describe("render: noise seed for another take (default: the sound's own, the delivered final)"),
      name: z.string().trim().min(1).max(80).optional().describe("render: short base name for a new take's file (default: the id); a take already in the project keeps its name"),
      path: z.string().trim().min(1).max(4096).optional().describe("check: the audio file, as a library path, a project-relative or an absolute local path"),
      role: z.string().trim().min(1).max(60).optional().describe("check: the kit role, for context (`hit` and `land` warn on stacked layers)"),
    })
    .superRefine((value, ctx) => {
      const allowed: Record<string, readonly string[]> = { list: ["category", "kind"], render: ["id", "dur", "apex", "pitch", "seed", "name"], check: ["path", "category", "role"] };
      if (value.action === "render" && !value.id) ctx.addIssue({ code: "custom", path: ["id"], message: "render needs `id`." });
      if (value.action === "check" && !value.path) ctx.addIssue({ code: "custom", path: ["path"], message: "check needs `path`." });
      for (const [field, given] of Object.entries(value)) {
        if (field !== "action" && given !== undefined && !allowed[value.action]!.includes(field)) ctx.addIssue({ code: "custom", path: [field], message: `\`${field}\` doesn't apply to ${value.action}.` });
      }
    }),
  output: z.object({
    action: z.enum(["list", "render", "check"]),
    version: z.string().describe("the earshot version that answered"),
    summary: z.string(),
    bank: z.string().optional().describe("list: the bank version"),
    categories: z.array(BankCategory).optional().describe("list: every matching category with its ids"),
    sounds: z.array(BankSound).optional().describe("list with a category or kind: each matching sound's times and knobs"),
    src: z.string().optional().describe("render: library path to use as `src` in JSX, e.g. `sfx/whoosh-fast-crisp-3f2a9c1d.wav`"),
    assetId: z.string().optional(),
    path: z.string().optional().describe("render, check: absolute path of the file"),
    sound: z.string().optional().describe("render: the bank id"),
    seed: z.int().optional().describe("render: the seed the take was rendered with"),
    durationSeconds: z.number().optional(),
    onsetSeconds: z.number().optional().describe("render: where the sound starts (the envelope's first point within 30 dB of its maximum)"),
    peakSeconds: z.number().optional().describe("render: the loudest 5 ms"),
    endSeconds: z.number().optional().describe("render: the last 5 ms within 50 dB of the loudest"),
    peakDb: z.number().optional().describe("render: sample peak in dBFS"),
    edits: z.record(z.string(), z.unknown()).optional().describe("render: what dur, apex and pitch did, as measured"),
    audit: Audit.optional(),
    reused: z.boolean().optional().describe("render: the same take was already in the project, and that file was reused"),
    creditsFile: z.string().optional().describe("render: the project's CREDITS.md"),
  }),
  environment: "renderer",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
