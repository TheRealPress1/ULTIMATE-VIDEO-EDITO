/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The arithmetic of `analyze`'s evidence pack, apart from any media: where
// the sections are cut, which frames go on the contact sheets, what each
// section says, which follow-up calls to suggest. Every time here is an
// absolute source second. The prompt's words only rank and add frames.

export type Word = { text: string; start: number; end: number };
export type Span = { start: number; end: number };
export type Evidence = { text: string; confidence: number };
export type VisualSampleLike = { time: number; labels: Evidence[]; text: Evidence[]; people: number };
export type AudioEventItem = { start: number; end?: number; labels: string[]; level?: number };
export type FrameReason = "scene-change" | "coverage" | "prompt";
export type PickedFrame = { time: number; reason: FrameReason };
export type PlacedFrame = PickedFrame & { sheet: number; cell: number };
export type PromptHit = { time: number; score: number; terms: string[] };
export type Check = { tool: string; args: Record<string, unknown>; reason: string };

export type Section = {
  index: number;
  start: number;
  end: number;
  speech?: string;
  words: number;
  visual?: { labels: string[]; text: string[]; people: number };
  silent: boolean | null;
  audio?: string[];
  keyframe?: { time: number; sheet: number; cell: number };
  match?: { score: number; terms: string[] };
};

/** Cells on one contact sheet. */
export const SHEET_CELLS = 12;
/** What a section's speech excerpt is cut to. */
export const EXCERPT_CHARS = 300;
/** Sections are never longer than this unless the window needs fewer, longer ones to stay under the section limit. */
export const SECTION_BLOCK_SECONDS = 30;
/** Silence covering this share of a section makes it silent. */
const SILENT_SHARE = 0.8;
/** Frames are never sampled closer than this on average: a short clip gets fewer than its budget. */
const MIN_FRAME_SPACING = 0.5;
/** Prompt words matched within this many seconds count as one moment. */
const HIT_CLUSTER_SECONDS = 2;
const MAX_KEYWORDS = 8;
const MAX_CHECKS = 8;

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

// ── Prompt words ─────────────────────────────────────────────

const STOP = new Set(
  (
    "a an the and or but nor of on in at to for from by with without into onto over under about above below between through during before after " +
    "is are was were be been being am do does did done have has had having can could should would will shall may might must " +
    "i me my we our you your he she it its they them their this that these those there here what which who whom whose when where why how " +
    "all any each every some no not only just also very too more most much many few lot lots " +
    "video videos clip clips footage file files film scene scenes shot shots frame frames moment moments part parts section sections " +
    "find show tell give list describe summarize summary analyze analyse look see watch check please want need know like get got " +
    "happen happens happened thing things something someone anything anyone everything everyone"
  ).split(" "),
);

/** Lowercase word tokens, NFKC-normalized, with a plural `s` dropped the way the visual search does. */
export function tokens(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
}

function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

/**
 * The prompt's content words, for ranking only: lowercased, stop words
 * dropped, at most eight, in the order they first appear. Nothing else of
 * the prompt is kept or acted on.
 */
export function promptKeywords(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const raw = prompt.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const words: string[] = [];
  for (const token of raw) {
    if (STOP.has(token) || (token.length < 3 && !/^\p{N}+$/u.test(token))) continue;
    const word = stem(token);
    if (!words.includes(word)) words.push(word);
    if (words.length >= MAX_KEYWORDS) break;
  }
  return words;
}

/** Where the prompt's words are spoken (per word) or seen (per sampled frame), merged into moments. */
export function promptHits(keywords: readonly string[], words: readonly Word[], samples: readonly VisualSampleLike[] | null): PromptHit[] {
  if (!keywords.length) return [];
  const wanted = new Set(keywords);
  const raw: PromptHit[] = [];
  for (const word of words) {
    const matched = tokens(word.text).filter((token) => wanted.has(token));
    if (matched.length) raw.push({ time: word.start, score: matched.length, terms: matched });
  }
  for (const sample of samples ?? []) {
    const terms = new Set<string>();
    let score = 0;
    for (const evidence of [...sample.labels, ...sample.text]) {
      const matched = tokens(evidence.text).filter((token) => wanted.has(token));
      if (!matched.length) continue;
      for (const term of matched) terms.add(term);
      score = Math.max(score, evidence.confidence);
    }
    if (sample.people && wanted.has("person")) { terms.add("person"); score = Math.max(score, 0.65); }
    if (terms.size) raw.push({ time: sample.time, score: round(score + terms.size * 0.5), terms: [...terms] });
  }
  return clusterHits(raw);
}

/** Hits within a couple of seconds of each other become one moment at the strongest of them. */
export function clusterHits(hits: readonly PromptHit[]): PromptHit[] {
  const sorted = [...hits].sort((a, b) => a.time - b.time);
  const merged: Array<PromptHit & { best: number }> = [];
  for (const hit of sorted) {
    const last = merged.at(-1);
    if (last && hit.time - last.time <= HIT_CLUSTER_SECONDS) {
      if (hit.score > last.best) { last.best = hit.score; last.time = hit.time; }
      last.score = round(last.score + hit.score);
      last.terms = [...new Set([...last.terms, ...hit.terms])];
      continue;
    }
    merged.push({ ...hit, terms: [...hit.terms], best: hit.score });
  }
  return merged.map(({ best: _best, ...hit }) => hit);
}

// ── Sections ─────────────────────────────────────────────────

/**
 * The window cut into sections: at the visual changes (`cuts`) where there
 * are any, into blocks of up to 30 s where there are none (longer blocks when
 * the window is long, so there are at most `limit`), with the shortest
 * merged into a neighbour until the count fits.
 */
export function sectionBounds(from: number, to: number, cuts: readonly number[], limit: number): Array<[number, number]> {
  const length = to - from;
  if (!(length > 0)) return [];
  const block = Math.max(SECTION_BLOCK_SECONDS, length / Math.max(1, limit));
  const minLength = Math.min(block / 2, Math.max(1, length / (Math.max(1, limit) * 4)));
  const points: number[] = [from];
  for (const cut of [...cuts].filter(Number.isFinite).sort((a, b) => a - b)) {
    if (cut - from < minLength || to - cut < minLength) continue;
    if (cut - points.at(-1)! < minLength) continue;
    points.push(cut);
  }
  points.push(to);

  let bounds: Array<[number, number]> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!, end = points[i + 1]!;
    const parts = Math.max(1, Math.ceil((end - start) / block - 1e-9));
    for (let k = 0; k < parts; k++) bounds.push([start + ((end - start) * k) / parts, start + ((end - start) * (k + 1)) / parts]);
  }
  while (bounds.length > Math.max(1, limit)) {
    let shortest = 0;
    for (let i = 1; i < bounds.length; i++) if (span(bounds[i]!) < span(bounds[shortest]!)) shortest = i;
    const left = shortest - 1, right = shortest + 1;
    const into = left < 0 ? right : right >= bounds.length ? left : span(bounds[left]!) <= span(bounds[right]!) ? left : right;
    const [a, b] = into < shortest ? [into, shortest] : [shortest, into];
    bounds = [...bounds.slice(0, a), [bounds[a]![0], bounds[b]![1]], ...bounds.slice(b + 1)];
  }
  return bounds.map(([start, end]) => [round(start), round(end)]);
}

const span = ([start, end]: [number, number]) => end - start;

// ── Frames ───────────────────────────────────────────────────

/**
 * The frames for the contact sheets, at most `budget` (and about one per
 * half second on a short clip): the prompt's strongest moments first (up to a
 * third), then one per section so every part of the window is seen, then the
 * remaining visual changes and evenly spread fill, each as far from the
 * frames already picked as it can be.
 */
export function chooseFrames(input: {
  from: number;
  to: number;
  budget: number;
  scenes: readonly number[];
  prompt: readonly PromptHit[];
  bounds: ReadonlyArray<[number, number]>;
}): PickedFrame[] {
  const { from, to, bounds } = input;
  const length = to - from;
  if (!(length > 0) || input.budget <= 0) return [];
  const cap = Math.max(1, Math.min(input.budget, Math.floor(length / MIN_FRAME_SPACING)));
  const minGap = Math.min(2, length / (cap * 3));
  const last = Math.max(from, to - Math.min(0.05, length / 2));
  const clamp = (time: number) => Math.min(last, Math.max(from, time));
  const scenes = [...new Set(input.scenes.filter((time) => time >= from && time < to))].sort((a, b) => a - b);
  const picks: PickedFrame[] = [];
  const distance = (time: number) => picks.reduce((best, pick) => Math.min(best, Math.abs(pick.time - time)), Infinity);
  const add = (time: number, reason: FrameReason) => {
    const at = clamp(time);
    if (picks.length >= cap || distance(at) < minGap) return false;
    picks.push({ time: round(at), reason });
    return true;
  };

  for (const hit of [...input.prompt].sort((a, b) => b.score - a.score)) {
    if (picks.filter((pick) => pick.reason === "prompt").length >= Math.ceil(cap / 3)) break;
    if (hit.time >= from && hit.time < to) add(hit.time, "prompt");
  }

  const room = cap - picks.length;
  const stride = bounds.length > room && room > 0 ? bounds.length / room : 1;
  for (let i = 0; i < bounds.length && picks.length < cap; i += stride) {
    const [start, end] = bounds[Math.floor(i)]!;
    const middle = (start + end) / 2;
    const inside = scenes.filter((time) => time >= start && time < end);
    const scene = inside.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
    if (scene !== undefined) add(scene, "scene-change");
    else add(middle, "coverage");
  }

  const grid = Array.from({ length: cap * 2 }, (_, i) => from + ((i + 0.5) * length) / (cap * 2));
  const candidates: PickedFrame[] = [...scenes.map((time) => ({ time, reason: "scene-change" as const })), ...grid.map((time) => ({ time, reason: "coverage" as const }))];
  while (picks.length < cap && candidates.length) {
    let best = -1, bestScore = -Infinity;
    for (const [i, candidate] of candidates.entries()) {
      const score = distance(clamp(candidate.time)) * (candidate.reason === "scene-change" ? 1.25 : 1);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    const [candidate] = candidates.splice(best, 1);
    // Nothing left is far enough from what is picked: the window is covered.
    if (!add(candidate!.time, candidate!.reason) && bestScore < minGap) break;
  }
  return picks.sort((a, b) => a.time - b.time);
}

/** Sheet sizes for `count` frames: balanced, at most twelve each (13 frames become 7 + 6). */
export function sheetSizes(count: number): number[] {
  if (count <= 0) return [];
  const sheets = Math.ceil(count / SHEET_CELLS);
  const base = Math.floor(count / sheets), extra = count % sheets;
  return Array.from({ length: sheets }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Each frame, in time order, with the sheet and the cell it lands in. */
export function placeFrames(frames: readonly PickedFrame[]): PlacedFrame[] {
  const placed: PlacedFrame[] = [];
  let index = 0;
  for (const [sheet, size] of sheetSizes(frames.length).entries()) {
    for (let cell = 0; cell < size; cell++) placed.push({ ...frames[index++]!, sheet, cell });
  }
  return placed;
}

// ── Section contents ─────────────────────────────────────────

/** Words joined as read, cut at a word to `max` characters. */
export function excerpt(words: readonly Word[], max = EXCERPT_CHARS): string {
  const text = words.map((word) => word.text.trim()).filter(Boolean).join(" ").replace(/\s+([,.!?;:])/g, "$1");
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The share of [start, end) that the spans cover. */
export function coverage(spans: readonly Span[], start: number, end: number): number {
  if (!(end > start)) return 0;
  let covered = 0;
  for (const item of spans) covered += Math.max(0, Math.min(end, item.end) - Math.max(start, item.start));
  return Math.min(1, covered / (end - start));
}

function strongest(evidence: readonly Evidence[], count: number, floor: number, maxLength: number): string[] {
  const best = new Map<string, number>();
  for (const item of evidence) {
    const text = item.text.trim().replace(/\s+/g, " ").slice(0, maxLength);
    if (!text || item.confidence < floor) continue;
    best.set(text, Math.max(best.get(text) ?? 0, item.confidence));
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([text]) => text);
}

export function assembleSections(input: {
  bounds: ReadonlyArray<[number, number]>;
  words: readonly Word[] | null;
  silences: readonly Span[] | null;
  samples: readonly VisualSampleLike[] | null;
  events: readonly AudioEventItem[] | null;
  frames: readonly PlacedFrame[];
  keywords: readonly string[];
}): Section[] {
  const wanted = new Set(input.keywords);
  const lastIndex = input.bounds.length - 1;
  return input.bounds.map(([start, end], index) => {
    const inside = (time: number) => time >= start && (time < end || (index === lastIndex && time <= end));
    const words = (input.words ?? []).filter((word) => inside(word.start));
    const samples = input.samples?.filter((sample) => inside(sample.time));
    const frames = input.frames.filter((frame) => inside(frame.time));
    const middle = (start + end) / 2;
    const key = [...frames].sort((a, b) => Math.abs(a.time - middle) - Math.abs(b.time - middle))[0];
    const terms = new Set<string>();
    let score = 0;
    if (wanted.size) {
      for (const word of words) for (const token of tokens(word.text)) if (wanted.has(token)) { terms.add(token); score += 1; }
      for (const sample of samples ?? []) {
        for (const item of [...sample.labels, ...sample.text]) {
          for (const token of tokens(item.text)) if (wanted.has(token)) { terms.add(token); score += 0.5 + item.confidence / 2; }
        }
      }
    }
    const heard = (input.events ?? []).filter((event) => inside(event.start)).flatMap((event) => event.labels);
    const section: Section = {
      index,
      start,
      end,
      ...(words.length ? { speech: excerpt(words) } : {}),
      words: words.length,
      ...(samples
        ? {
            visual: {
              labels: strongest(samples.flatMap((sample) => sample.labels), 5, 0.3, 60),
              text: strongest(samples.flatMap((sample) => sample.text), 3, 0.3, 80),
              people: samples.reduce((most, sample) => Math.max(most, sample.people), 0),
            },
          }
        : {}),
      silent: input.silences ? coverage(input.silences, start, end) >= SILENT_SHARE : null,
      ...(input.events ? { audio: [...new Set(heard)].slice(0, 4) } : {}),
      ...(key ? { keyframe: { time: key.time, sheet: key.sheet, cell: key.cell } } : {}),
      ...(terms.size ? { match: { score: round(score, 2), terms: [...terms] } } : {}),
    };
    return section;
  });
}

// ── Audio events ─────────────────────────────────────────────

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function labelsOf(value: unknown): string[] {
  const one = (item: unknown): string | undefined => {
    if (typeof item === "string") return item;
    if (Array.isArray(item) && typeof item[0] === "string") return item[0];
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of ["label", "name", "tag", "text", "kind"]) if (typeof record[key] === "string") return record[key] as string;
    }
    return undefined;
  };
  const list = Array.isArray(value) && !(value.length === 2 && typeof value[0] === "string" && finite(value[1])) ? value : [value];
  return list.map(one).filter((label): label is string => !!label?.trim()).map((label) => label.trim().slice(0, 60));
}

/**
 * earshot's timeline events, read tolerantly (its JSON is compacted and may
 * name fields differently between versions): each item's time, end, tags and
 * level, at most 200, in source seconds. Times that only make sense relative
 * to the window's start are shifted by it.
 */
export function readAudioEvents(result: Record<string, unknown>, from: number, to: number): AudioEventItem[] {
  const list = ["events", "timeline", "segments", "items"].map((key) => result[key]).find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];
  const items: AudioEventItem[] = [];
  for (const raw of list.slice(0, 2000)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const start = [item.t, item.time, item.start, item.at, item.s].find(finite);
    if (start === undefined) continue;
    const end = [item.end, item.e].find(finite) ?? (finite(item.dur) ? start + item.dur : finite(item.duration) ? start + item.duration : undefined);
    const labels = labelsOf(item.tags ?? item.labels ?? item.label ?? item.name ?? item.kind ?? item.type ?? item.event);
    const level = [item.db, item.level, item.lufs, item.peak_db, item.dbfs].find(finite);
    items.push({ start, ...(end !== undefined && end > start ? { end } : {}), labels: [...new Set(labels)].slice(0, 5), ...(level !== undefined ? { level: round(level, 1) } : {}) });
  }
  const relative = from > 0 && items.length > 0 && items.every((item) => item.start <= to - from + 1) && items.some((item) => item.start < from);
  return items
    .map((item) => (relative ? { ...item, start: item.start + from, ...(item.end !== undefined ? { end: item.end + from } : {}) } : item))
    .filter((item) => item.start >= from - 0.5 && item.start <= to + 0.5)
    .sort((a, b) => a.start - b.start)
    .slice(0, 200)
    .map((item) => ({ ...item, start: round(item.start), ...(item.end !== undefined ? { end: round(item.end) } : {}) }));
}

// ── Follow-ups and limits ────────────────────────────────────

export function suggestChecks(input: {
  path: string;
  from: number;
  to: number;
  video: boolean;
  sections: readonly Section[];
  frames: readonly PlacedFrame[];
  speech: "footage-index" | "transcribed" | "none" | "skipped" | "failed";
  visual: "visual-index" | "frames-only" | "none" | "skipped";
  library: boolean;
  events: "included" | "installing" | "unavailable" | "skipped" | "failed";
}): Check[] {
  const { path, sections } = input;
  const checks: Check[] = [];
  const window = (start: number, end: number) => ({ start: round(start, 2), end: round(end, 2) });
  const matched = [...sections].filter((section) => section.match).sort((a, b) => b.match!.score - a.match!.score).slice(0, 3);
  for (const section of matched) {
    const terms = section.match!.terms.join(", ");
    if (input.video) checks.push({ tool: "grab", args: { path, ...window(section.start, section.end), count: 6 }, reason: `The prompt's words (${terms}) match here; look at it frame by frame.` });
    if (section.words) checks.push({ tool: "listen", args: { path, ...window(section.start, section.end) }, reason: `The exact words and timings around ${terms}.` });
  }
  if (input.video && !matched.length) {
    const busy = sections
      .map((section) => ({ section, changes: input.frames.filter((frame) => frame.reason === "scene-change" && frame.time >= section.start && frame.time < section.end).length }))
      .filter((item) => item.changes >= 2)
      .sort((a, b) => b.changes - a.changes)
      .slice(0, 2);
    for (const { section } of busy) {
      checks.push({ tool: "grab", args: { path, ...window(section.start, section.end), auto: true, count: 8 }, reason: "Several visual changes here; brief shots between the sampled frames may be missing." });
    }
  }
  const quiet = sections.filter((section) => section.silent && section.end - section.start >= 5).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (quiet) checks.push({ tool: "waveform", args: { path, ...window(quiet.start, quiet.end) }, reason: "A silent stretch: dead air, or sound too quiet to register." });
  if (input.visual === "frames-only" && input.library) {
    checks.push({ tool: "visual_index", args: { paths: [path] }, reason: "Adds labels, on-screen text and people counts to sampled frames for a later analyze." });
  }
  if (input.events === "installing") {
    checks.push({ tool: "analyze", args: { path, ...window(input.from, input.to), focus: ["audio"] }, reason: "Once the audio add-on finishes installing, adds sound events to these sections." });
  }
  if (input.speech === "failed") {
    checks.push({ tool: "transcribe", args: { path, ...window(input.from, input.to) }, reason: "Speech could not be gathered here; transcribe reports why." });
  }
  return checks.slice(0, MAX_CHECKS);
}

export function limitationsFor(input: {
  video: boolean;
  frames: number;
  length: number;
  frameSelection: "scene-change" | "even" | "none";
  speech: "footage-index" | "transcribed" | "none" | "skipped" | "failed";
  visual: "visual-index" | "frames-only" | "none" | "skipped";
  events: "included" | "installing" | "unavailable" | "skipped" | "failed";
  eventsNote?: string;
  keywords: number;
}): string[] {
  const notes: string[] = [];
  if (input.video && input.frames) {
    const every = input.length / input.frames;
    notes.push(`Frames are sampled: ${input.frames} across ${round(input.length, 1)} s (about one every ${round(every, 1)} s). Anything brief between them can be missing.`);
  }
  notes.push("This is sampled, timestamped evidence for you to interpret, not real watching: actions, identities, emotions and music are not recognized.");
  if (input.frameSelection === "even") notes.push("Visual changes were not detected for this window, so frames are evenly spaced and sections follow fixed blocks rather than cuts.");
  else if (input.frameSelection === "scene-change") notes.push("Section boundaries follow sampled visual changes, close to cuts but not exact cut points.");
  if (input.speech === "footage-index" || input.speech === "transcribed") notes.push("Speech comes from local Whisper: words and times are approximate, and no speakers are labeled.");
  if (input.visual === "frames-only") notes.push("This file is not visually indexed, so sections carry no labels or on-screen text: read the contact sheets, or run visual_index first.");
  if (input.eventsNote && input.events !== "included" && input.events !== "skipped") notes.push(input.eventsNote);
  if (input.keywords) notes.push("The prompt's words only ranked sections and added frames; nothing in the pack answers it.");
  return notes;
}
