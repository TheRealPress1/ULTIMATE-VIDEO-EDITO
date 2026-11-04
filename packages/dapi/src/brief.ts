/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A project's brief.md: the plan for one video, written by agents with their
// own file tools and hand-edited by the user in any text editor. Tools read
// it back through parseBrief (script_lint, script_read_compare), so the
// parser is tolerant by design: it never throws, every section is optional,
// and anything it had to guess about comes back as a warning, which is
// information for the agent, not an error. The format is documented in
// docs/reference/brief.md. Pure: no file system, no clock.

/** The file name inside the project folder. */
export const BRIEF_FILE = "brief.md";

/** The format version this parser reads, marked in the file as `<!-- cutroom:brief v1 -->`. */
export const BRIEF_VERSION = 1;
export const BRIEF_MARKER = `<!-- cutroom:brief v${BRIEF_VERSION} -->`;

/** The beat names the skills use. Any other label is kept as free text. */
export const BRIEF_BEATS = ["opener", "doubt", "point", "proof", "turn", "payoff", "close"] as const;
export type BriefBeat = (typeof BRIEF_BEATS)[number];

/** The shot plan's columns, in the order the skill writes them. */
export const SHOT_PLAN_COLUMNS = ["#", "Line", "Point", "Shot", "Job", "Source", "Status", "Notes"] as const;

export type BriefNotes = {
  /** How the line is said: tone, pace, emphasis. */
  delivery?: string;
  /** What the viewer sees: shot, on-screen text, graphic. */
  screen?: string;
  /** What the audio does: music change, effect, silence. */
  sound?: string;
  /** Note text without a recognized key. */
  other?: string;
};

export type BriefScriptLine = {
  /** The line's number as written; an unnumbered sentence gets a number after the highest one written. */
  n: number;
  /** The beat label as written (`opener`, `point 2`, `proof`…), when the line has one. */
  beat?: string;
  /** The emotion label as written, when the line has one. */
  emotion?: string;
  /** The spoken words, without the number and labels. */
  text: string;
  notes?: BriefNotes;
};

export type BriefGoal = {
  viewer?: string;
  /** teach, amuse or move, or the creator's own word for it. */
  payoff?: string;
  format?: string;
  /** The target length as written, e.g. `30-45 s`. */
  target?: string;
  /** The target length in seconds, when `target` reads as one. */
  targetSeconds?: { min: number; max: number };
  aspect?: string;
  platform?: string;
  /** A language tag such as `en` or `fr`, when the brief names one. */
  language?: string;
  /** Every `key: value` line of the section, keys lowercased. */
  fields: Record<string, string>;
};

export type Brief = {
  /** The `cutroom:brief` marker's version; undefined when the file has none. */
  version?: number;
  goal?: BriefGoal;
  viewer?: string;
  ideas?: string;
  /** The `## Script` lines in file order; empty when there is no script. */
  script: BriefScriptLine[];
  /** Whether the file has a `## Script` section at all, even an empty one. */
  hasScript: boolean;
  /** Rows of the `## Shot plan` table, keyed by lowercased column header; missing cells are "". */
  shotPlan?: Array<Record<string, string>>;
  editPlan?: string;
  notes?: string;
  /** Every `## ` section's body, keyed by its heading as written (the first of duplicate headings wins). */
  sections: Record<string, string>;
  /** What the parser had to guess or skip, for the agent to fix or ignore. */
  warnings: string[];
};

type Known = "goal" | "viewer" | "ideas" | "script" | "shotPlan" | "editPlan" | "notes";

/** Section headings, lowercased, and the field each one fills. Only an exact `Script` heading holds the script. */
const SECTIONS: Record<string, Known> = {
  goal: "goal", goals: "goal",
  viewer: "viewer", audience: "viewer",
  ideas: "ideas", "idea bank": "ideas",
  script: "script",
  "shot plan": "shotPlan", "shot list": "shotPlan",
  "edit plan": "editPlan",
  notes: "notes",
};

const BEAT_ALIASES: Record<string, BriefBeat> = {
  opener: "opener", hook: "opener", open: "opener", opening: "opener",
  doubt: "doubt", objection: "doubt",
  point: "point",
  proof: "proof", example: "proof", evidence: "proof", demo: "proof",
  turn: "turn", twist: "turn",
  payoff: "payoff", reveal: "payoff",
  close: "close", ending: "close", cta: "close", outro: "close",
};

/** The beat a label names: its first word, through the aliases; null for free-text labels. */
export function beatKind(label: string | undefined | null): BriefBeat | null {
  if (!label) return null;
  const first = label.trim().toLowerCase().split(/[\s:#-]+/)[0] ?? "";
  return BEAT_ALIASES[first] ?? null;
}

const NOTE_KEYS: Record<string, keyof BriefNotes> = {
  delivery: "delivery", tone: "delivery", read: "delivery", pace: "delivery", voice: "delivery",
  screen: "screen", "on-screen": "screen", onscreen: "screen", "on screen": "screen", visual: "screen", picture: "screen", shot: "screen", "b-roll": "screen", broll: "screen", text: "screen",
  sound: "sound", audio: "sound", music: "sound", sfx: "sound",
};
const escapeKey = (key: string) => key.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&").replace(/\s+/g, "\\s+");
const NOTE_KEY_PATTERN = Object.keys(NOTE_KEYS).sort((a, b) => b.length - a.length).map(escapeKey).join("|");
// A pipe separates note fields only when the next field starts with a known key,
// so a pipe inside a field ("rent | food | fun") stays part of it.
const NOTE_SPLIT = new RegExp(`\\s*\\|\\s*(?=(?:${NOTE_KEY_PATTERN})\\s*:)`, "i");
const NOTE_FIELD = new RegExp(`^\\s*(${NOTE_KEY_PATTERN})\\s*:\\s*(.*)$`, "i");

const GOAL_KEYS: Record<string, keyof Omit<BriefGoal, "fields" | "targetSeconds">> = {
  viewer: "viewer", audience: "viewer", for: "viewer",
  payoff: "payoff", "pay-off": "payoff", promise: "payoff",
  format: "format",
  target: "target", length: "target", duration: "target", runtime: "target", seconds: "target", "target length": "target", "target seconds": "target",
  aspect: "aspect", "aspect ratio": "aspect", ratio: "aspect",
  platform: "platform", platforms: "platform",
  language: "language", lang: "language",
};

const HEADING = /^ {0,3}##(?!#)\s*(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const NUMBERED = /^ {0,3}(\d{1,4})[.)]\s+(.*)$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NOTE = /^\s*>\s?(.*)$/;
const LABEL = /^(?:\*\*|__)?\[([^\]\n]*)\](?!\()(?:\*\*|__)?\s*(.*)$/;
const MARKER = /<!--\s*cutroom:brief\s+v(\d+)\s*-->/i;

type RawSection = { heading: string; start: number; end: number };

/** Each `## ` heading outside code fences, with the line range of its body (end exclusive). */
function splitSections(lines: string[]): RawSection[] {
  const found: RawSection[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1]!;
      if (fence === null) fence = mark[0]!.repeat(3);
      else if (mark.startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null) return;
    const heading = HEADING.exec(line);
    if (!heading) return;
    if (found.length) found[found.length - 1]!.end = index;
    found.push({ heading: heading[1]!.replace(/^\*\*|\*\*$/g, "").trim(), start: index + 1, end: lines.length });
  });
  return found;
}

/** A section body without its leading and trailing blank lines. */
function body(lines: string[], section: RawSection): string {
  const slice = lines.slice(section.start, section.end);
  while (slice.length && !slice[0]!.trim()) slice.shift();
  while (slice.length && !slice[slice.length - 1]!.trim()) slice.pop();
  return slice.join("\n");
}

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "st", "vs", "e.g", "i.e", "approx", "jr", "sr", "mt"]);

/**
 * Sentences of a passage of spoken text, split after `.`, `!`, `?` or `…`
 * when the next word starts a new sentence. Keeps decimals ("$1.5k"),
 * initials and common abbreviations ("Dr. Reyes") whole.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let current: string[] = [];
  tokens.forEach((token, index) => {
    current.push(token);
    const next = tokens[index + 1];
    if (!next) return;
    const core = token.replace(/["'”’)\]]+$/, "");
    if (!/[.!?…]$/.test(core)) return;
    if (core.endsWith(".") && !/[!?…]/.test(core)) {
      const word = core.slice(0, -1).replace(/^["'“‘(\[]+/, "");
      if (ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) return;
    }
    if (!/^["'“‘(\[¿¡]*[\p{Lu}\p{N}]/u.test(next)) return;
    out.push(current.join(" "));
    current = [];
  });
  if (current.length) out.push(current.join(" "));
  return out;
}

/** The fields of one `>` note line: `delivery: … | screen: … | sound: …`. */
export function parseNotes(text: string, into: BriefNotes = {}): BriefNotes {
  for (const part of text.split(NOTE_SPLIT)) {
    const piece = part.trim();
    if (!piece) continue;
    const field = NOTE_FIELD.exec(piece);
    const key: keyof BriefNotes = field ? NOTE_KEYS[field[1]!.toLowerCase().replace(/\s+/g, " ")] ?? "other" : "other";
    const value = field ? field[2]!.trim() : piece;
    if (!value) continue;
    into[key] = into[key] ? `${into[key]}; ${value}` : value;
  }
  return into;
}

/** Splits a `[beat · emotion]` label into its parts. */
function label(raw: string): { beat?: string; emotion?: string; extra: boolean } {
  const parts = raw.split(/\s*[·•|/;,]\s*/).map((part) => part.trim()).filter(Boolean);
  const beat = parts[0];
  const emotion = parts[1];
  return { ...(beat ? { beat } : {}), ...(emotion ? { emotion } : {}), extra: parts.length > 2 };
}

/** A line's labels and words, from what follows its number or bullet; `extra` when it has more than two labels. */
function scriptLine(n: number, rest: string): { line: BriefScriptLine; extra: boolean } {
  let text = rest.trim();
  const line: BriefScriptLine = { n, text: "" };
  let extra = false;
  const labelled = LABEL.exec(text);
  if (labelled) {
    const parts = label(labelled[1]!);
    if (parts.beat) line.beat = parts.beat;
    if (parts.emotion) line.emotion = parts.emotion;
    extra = parts.extra;
    text = labelled[2]!.trim();
  }
  line.text = text;
  return { line, extra };
}

/**
 * The lines of a script: a `## Script` section's body, or a whole text that
 * is only a script. Numbered lines (`3. [proof · relief] …`) keep the number
 * written. Unnumbered sentences, bullets and paragraphs are accepted, split
 * into sentences and numbered after the highest number written anywhere in
 * the script, with a warning, so a stray sentence never moves a written one.
 */
export function parseScript(text: string, warnings: string[] = []): BriefScriptLine[] {
  const lines = normalize(text).split("\n");
  // Read in file order first; numbers are settled once every written number is known.
  const entries: Array<{ line: BriefScriptLine; numbered: boolean; extra: boolean }> = [];
  // The line a note or an indented continuation attaches to.
  const state: { last: BriefScriptLine | null; fence: boolean; comment: boolean } = { last: null, fence: false, comment: false };
  let paragraph: string[] = [];
  const push = ({ line, extra }: { line: BriefScriptLine; extra: boolean }, numbered: boolean) => {
    if (!line.text) {
      warnings.push(numbered ? `Script line ${line.n} has no spoken words and was skipped.` : "An unnumbered script line has no spoken words and was skipped.");
      state.last = null;
      return;
    }
    entries.push({ line, numbered, extra });
    state.last = line;
  };
  /** Unnumbered text: one sentence per line, the first keeping a leading [label]. */
  const loose = (text: string) => {
    const labelled = LABEL.exec(text.trim());
    const prefix = labelled ? `[${labelled[1]}] ` : "";
    splitSentences(labelled ? labelled[2]! : text).forEach((sentence, index) => {
      push(scriptLine(0, index === 0 ? prefix + sentence : sentence), false);
    });
  };
  const flush = () => {
    if (paragraph.length) loose(paragraph.join(" "));
    paragraph = [];
  };
  for (const raw of lines) {
    if (state.comment) { if (raw.includes("-->")) state.comment = false; continue; }
    if (FENCE.test(raw)) { flush(); state.fence = !state.fence; continue; }
    if (state.fence) continue;
    const trimmed = raw.trim();
    if (!trimmed) { flush(); continue; }
    if (trimmed.startsWith("<!--")) { flush(); if (!trimmed.includes("-->")) state.comment = true; continue; }
    if (/^#{1,6}\s/.test(trimmed) || /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); continue; }
    const note = NOTE.exec(raw);
    if (note) {
      flush();
      if (state.last) state.last.notes = parseNotes(note[1]!, state.last.notes ?? {});
      else warnings.push("A note line (>) comes before any script line and was ignored.");
      continue;
    }
    const numbered = NUMBERED.exec(raw);
    if (numbered) { flush(); push(scriptLine(Number(numbered[1]), numbered[2]!), true); continue; }
    // An indented line continues the numbered line above it (a hard-wrapped sentence).
    if (!paragraph.length && /^\s{2,}\S/.test(raw) && state.last && !state.last.notes) { state.last.text = `${state.last.text} ${trimmed}`; continue; }
    const bullet = BULLET.exec(raw);
    if (bullet) { flush(); loose(bullet[1]!); continue; }
    paragraph.push(trimmed);
  }
  flush();
  // Unnumbered lines and repeated numbers take numbers after the highest one written.
  let next = entries.reduce((max, entry) => (entry.numbered ? Math.max(max, entry.line.n) : max), 0) + 1;
  let highest = 0;
  const seen = new Set<number>();
  const out: BriefScriptLine[] = [];
  for (const { line, numbered, extra } of entries) {
    if (!numbered) line.n = next++;
    else if (seen.has(line.n)) {
      warnings.push(`Script line number ${line.n} appears twice; the second one was renumbered ${next}.`);
      line.n = next++;
    } else {
      if (line.n < highest) warnings.push(`Script line ${line.n} comes after line ${highest}; lines keep their file order.`);
      highest = line.n;
      seen.add(line.n);
    }
    if (extra) warnings.push(`Script line ${line.n}: only the first two labels are read, as [beat · emotion].`);
    out.push(line);
  }
  const unnumbered = entries.filter((entry) => !entry.numbered).length;
  if (unnumbered) warnings.push(`${unnumbered} script ${unnumbered === 1 ? "sentence was" : "sentences were"} not numbered; each got a number after the highest one written, in file order. Write lines as "N. [beat · emotion] sentence".`);
  return out;
}

/** A target length in seconds from text like `30-45 s`, `0:45`, `1-2 min`, `under 60s`. */
export function parseTargetSeconds(text: string): { min: number; max: number } | undefined {
  const found: Array<{ seconds: number; minutes: boolean; bare: boolean }> = [];
  const pattern = /(\d+(?:\.\d+)?)(?::(\d{1,2}))?\s*(minutes?|mins?|m\b|seconds?|secs?|s\b)?/gi;
  for (const match of text.matchAll(pattern)) {
    const [, whole, clock, unit] = match;
    const minutes = clock === undefined && !!unit && /^m/i.test(unit);
    const seconds = clock !== undefined ? Number(whole) * 60 + Number(clock) : Number(whole) * (minutes ? 60 : 1);
    if (Number.isFinite(seconds) && seconds > 0) found.push({ seconds, minutes, bare: clock === undefined && !unit });
    if (found.length === 2) break;
  }
  if (!found.length) return undefined;
  if (found.length === 2) {
    // A unit written once ("1-2 min") applies to both numbers.
    if (found[0]!.bare && found[1]!.minutes) found[0]!.seconds *= 60;
    const [a, b] = [found[0]!.seconds, found[1]!.seconds];
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const only = found[0]!.seconds;
  if (/\b(?:under|below|less than|at most|max(?:imum)?|up to|no more than)\b|[<≤]/i.test(text)) return { min: 0, max: only };
  if (/\b(?:over|above|more than|at least|min(?:imum)?)\b|[>≥]/i.test(text)) return { min: only, max: Math.round(only * 1.5 * 10) / 10 };
  return { min: Math.round(only * 0.85 * 10) / 10, max: Math.round(only * 1.15 * 10) / 10 };
}

/** `key: value` lines (bulleted, bold or plain) of the Goal section. */
function parseGoal(text: string): BriefGoal {
  const goal: BriefGoal = { fields: {} };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*[-*+]\s+/, "").replace(/\*\*|__/g, "").trim();
    const field = /^([^:]{1,30}):\s*(.+)$/.exec(line);
    if (!field) continue;
    const key = field[1]!.trim().toLowerCase();
    const value = field[2]!.trim();
    goal.fields[key] = value;
    const known = GOAL_KEYS[key];
    if (known && goal[known] === undefined) goal[known] = value;
  }
  if (goal.target) {
    const seconds = parseTargetSeconds(goal.target);
    if (seconds) goal.targetSeconds = seconds;
  }
  return goal;
}

/** Cells of one markdown table row, split on unescaped pipes. */
function cells(row: string): string[] {
  let line = row.trim();
  if (line.startsWith("|")) line = line.slice(1);
  if (line.endsWith("|") && !line.endsWith("\\|")) line = line.slice(0, -1);
  return line.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/** The rows of the first markdown table in the Shot plan section. */
function parseShotPlan(text: string, warnings: string[]): Array<Record<string, string>> {
  const lines = text.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line, index) => line.startsWith("|") && /^\|?\s*:?-{2,}/.test(lines[index + 1] ?? ""));
  if (start < 0) {
    warnings.push("The Shot plan section has no table; write it as | # | Line | Point | Shot | Job | Source | Status | Notes |.");
    return [];
  }
  const header = cells(lines[start]!).map((cell) => cell.toLowerCase());
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const values = cells(line);
    const row: Record<string, string> = {};
    header.forEach((column, index) => { row[column] = values[index] ?? ""; });
    if (values.length < header.length) warnings.push(`Shot plan row ${rows.length + 1} has ${values.length} of ${header.length} cells; the missing ones are empty.`);
    if (values.length > header.length) warnings.push(`Shot plan row ${rows.length + 1} has ${values.length - header.length} more cells than the header; they were ignored.`);
    rows.push(row);
  }
  return rows;
}

/** LF line endings, no byte-order mark. */
function normalize(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Reads a brief.md. Never throws; what it had to guess is in `warnings`. */
export function parseBrief(text: string): Brief {
  const warnings: string[] = [];
  const source = normalize(typeof text === "string" ? text : "");
  const lines = source.split("\n");
  const brief: Brief = { script: [], hasScript: false, sections: {}, warnings };
  const marker = MARKER.exec(source);
  if (marker) {
    brief.version = Number(marker[1]);
    if (brief.version > BRIEF_VERSION) warnings.push(`This brief says it is format v${brief.version}; this app reads v${BRIEF_VERSION}, so newer parts may be skipped.`);
  }
  const filled = new Set<Known>();
  for (const section of splitSections(lines)) {
    const content = body(lines, section);
    if (section.heading in brief.sections) {
      warnings.push(`The "## ${section.heading}" heading appears more than once; only the first is read.`);
      continue;
    }
    brief.sections[section.heading] = content;
    const known = SECTIONS[section.heading.toLowerCase()];
    if (!known) continue;
    if (filled.has(known)) {
      warnings.push(`"## ${section.heading}" repeats an earlier section; only the first is read.`);
      continue;
    }
    filled.add(known);
    switch (known) {
      case "goal": brief.goal = parseGoal(content); break;
      case "script": brief.hasScript = true; brief.script = parseScript(content, warnings); break;
      case "shotPlan": brief.shotPlan = parseShotPlan(content, warnings); break;
      default: if (content) brief[known] = content;
    }
  }
  if (!brief.hasScript && /^ {0,3}#{1,6}\s*script\b/im.test(source)) {
    warnings.push('A script heading was found, but only an exact "## Script" heading holds the script.');
  }
  return brief;
}

/**
 * One script line as the brief writes it, with its note line when it has
 * notes. Note text without a key goes first: after a keyed field it would
 * read back as part of that field.
 */
export function formatScriptLine(line: BriefScriptLine): string {
  const labels = [line.beat, line.emotion].filter((part): part is string => !!part && !!part.trim()).map((part) => part.trim());
  const head = `${line.n}. ${labels.length ? `[${labels.join(" · ")}] ` : ""}${line.text.trim()}`;
  const notes = line.notes ?? {};
  const fields = (["other", "delivery", "screen", "sound"] as const)
    .filter((key) => notes[key]?.trim())
    .map((key) => (key === "other" ? notes[key]!.trim() : `${key}: ${notes[key]!.trim()}`));
  return fields.length ? `${head}\n   > ${fields.join(" | ")}` : head;
}

/** Script lines as the brief writes them, one per line. */
export function formatScriptLines(lines: readonly BriefScriptLine[]): string {
  return lines.map(formatScriptLine).join("\n");
}

/**
 * The brief with its `## Script` section rewritten from `lines`. Every byte
 * outside that section's body stays as it was, line endings included; a
 * brief without a Script section gets one appended at the end.
 */
export function replaceScript(markdown: string, lines: readonly BriefScriptLine[]): string {
  const text = typeof markdown === "string" ? markdown : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const formatted = lines.length ? formatScriptLines(lines).split("\n").map((line) => line + eol).join("") : "";
  const chunks = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const plain = chunks.map((chunk, index) => {
    const line = chunk.replace(/\r?\n$/, "");
    return index === 0 ? line.replace(/^\uFEFF/, "") : line;
  });
  const script = splitSections(plain).find((section) => section.heading.toLowerCase() === "script");
  if (!script) {
    const base = text === "" || text.endsWith("\n") ? text : text + eol;
    return `${base}${base ? eol : ""}## Script${eol}${eol}${formatted}`;
  }
  let head = chunks.slice(0, script.start).join("");
  if (!head.endsWith("\n")) head += eol;
  const rest = chunks.slice(script.end).join("");
  // Keep the section's own spacing: a blank line after the heading and before the next one when it had them.
  const old = plain.slice(script.start, script.end);
  const lead = !old.length || !old[0]!.trim() ? eol : "";
  const trail = rest && formatted && (!old.length || !old[old.length - 1]!.trim()) ? eol : "";
  return head + lead + formatted + trail + rest;
}
