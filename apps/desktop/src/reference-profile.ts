import { REFERENCE_INTERVAL, REFERENCE_MAX_SECONDS } from "./reference-types";
import type {
  ReferenceAnalysis,
  ReferenceProfile,
  ReferenceText,
} from "./reference-types";
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const unit = (n: unknown): n is number => finite(n) && n >= 0 && n <= 1;
const median = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y);
  return a.length
    ? (a[Math.floor((a.length - 1) / 2)]! + a[Math.floor(a.length / 2)]!) / 2
    : 0;
};
const quantile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ] ?? 0;

export function validateReferenceAnalysis(
  value: unknown,
  duration?: number,
  sourceStart?: number,
): ReferenceAnalysis {
  const a = value as ReferenceAnalysis;
  if (
    !a ||
    !finite(a.duration) ||
    a.duration <= 0 ||
    a.duration > 86400 ||
    !finite(a.sourceStart) ||
    a.sourceStart < 0 ||
    !finite(a.analyzedDuration) ||
    Math.abs(a.analyzedDuration - Math.min(a.duration, REFERENCE_MAX_SECONDS)) >
      1e-6 ||
    !Number.isInteger(a.width) ||
    !Number.isInteger(a.height) ||
    a.width < 1 ||
    a.height < 1 ||
    a.width > 65536 ||
    a.height > 65536 ||
    a.sampleInterval !== REFERENCE_INTERVAL ||
    !Array.isArray(a.samples) ||
    a.samples.length !==
      Math.ceil(a.analyzedDuration / a.sampleInterval - 1e-9) ||
    a.samples.length > 480 ||
    (duration !== undefined && Math.abs(a.duration - duration) > 1e-6) ||
    (sourceStart !== undefined && Math.abs(a.sourceStart - sourceStart) > 1e-6)
  )
    throw new Error("Invalid reference analysis metadata.");
  for (const [i, s] of a.samples.entries()) {
    if (
      !s ||
      !finite(s.time) ||
      s.time < 0 ||
      s.time >= a.analyzedDuration ||
      (i > 0 && s.time <= a.samples[i - 1]!.time) ||
      !finite(s.mediaTime) ||
      Math.abs(s.mediaTime - a.sourceStart - s.time) > 1e-5 ||
      Math.abs(s.time - i * a.sampleInterval) > a.sampleInterval ||
      !unit(s.change) ||
      !Array.isArray(s.text) ||
      s.text.length > 40 ||
      !Array.isArray(s.palette) ||
      s.palette.length > 4 ||
      s.palette.some((c) => !/^#[0-9a-f]{6}$/i.test(c))
    )
      throw new Error("Invalid reference frame evidence.");
    for (const t of s.text)
      if (
        !t ||
        typeof t.text !== "string" ||
        !t.text.trim() ||
        t.text.length > 240 ||
        !unit(t.confidence) ||
        !unit(t.x) ||
        !unit(t.y) ||
        !unit(t.width) ||
        !unit(t.height) ||
        t.width <= 0 ||
        t.height <= 0 ||
        t.x + t.width > 1.001 ||
        t.y + t.height > 1.001
      )
        throw new Error("Invalid reference text bounds.");
  }
  return structuredClone(a);
}

/** Heuristics label observations explicitly; only consistent changing lower-screen text becomes a caption candidate. */
export function buildReferenceProfile(
  input: ReferenceAnalysis,
): ReferenceProfile {
  const a = validateReferenceAnalysis(input);
  const cuts: ReferenceProfile["cuts"] = [];
  for (let i = 1; i < a.samples.length; i++) {
    const s = a.samples[i]!;
    if (
      s.change >= 0.34 &&
      s.change >= (a.samples[i - 1]?.change ?? 0) &&
      s.change > (a.samples[i + 1]?.change ?? 0) &&
      s.time - (cuts.at(-1)?.time ?? -10) >= 0.5
    )
      cuts.push({ time: s.time, score: s.change });
  }
  const boundaries = [0, ...cuts.map((c) => c.time), a.analyzedDuration];
  const lengths = boundaries.slice(1).map((v, i) => v - boundaries[i]!);
  const frames = a.samples.filter((_, i) => i % 4 === 0);
  const bins = new Map<number, Array<{ frame: number; text: ReferenceText }>>();
  for (const [frame, s] of frames.entries())
    for (const text of s.text) {
      if (
        text.confidence < 0.55 ||
        text.text.trim().length < 5 ||
        text.width < 0.15 ||
        text.width > 0.92 ||
        text.height > 0.14 ||
        text.y < 0.4 ||
        text.y + text.height > 0.96
      )
        continue;
      const key = Math.round((text.y + text.height / 2) / 0.05);
      const bin = bins.get(key) ?? [];
      bin.push({ frame, text });
      bins.set(key, bin);
    }
  const candidates = [...bins.values()]
    .map((entries) => ({
      entries,
      coverage:
        new Set(entries.map((e) => e.frame)).size / Math.max(1, frames.length),
      distinct: new Set(entries.map((e) => e.text.text.trim().toLowerCase()))
        .size,
    }))
    .filter(
      (c) => c.coverage >= 0.2 && c.entries.length >= 3 && c.distinct >= 2,
    )
    .sort((x, y) => y.coverage - x.coverage || y.distinct - x.distinct);
  const selected = candidates[0];
  let caption: ReferenceProfile["caption"] = null;
  if (selected) {
    const text = selected.entries.map((e) => e.text);
    const width = Math.min(
      0.9,
      Math.max(
        0.35,
        quantile(
          text.map((t) => t.width),
          0.8,
        ) * 1.15,
      ),
    );
    const center = median(text.map((t) => t.x + t.width / 2));
    const height = median(text.map((t) => t.height));
    caption = {
      x: Math.max(0.05, Math.min(0.95 - width, center - width / 2)),
      y: median(text.map((t) => t.y)),
      width,
      height,
      fontSizeRatio: Math.max(0.012, Math.min(0.1, height * 1.15)),
      coverage: selected.coverage,
      observations: selected.entries.length,
      distinctTexts: selected.distinct,
      examples: [...new Set(text.map((t) => t.text))].slice(0, 4),
      suggestedPreset:
        median(text.map((t) => t.text.split(/\s+/).length)) >= 3
          ? "whisper"
          : "classic",
    };
  }
  const paletteCounts = new Map<string, number>();
  for (const s of frames)
    for (const color of s.palette)
      paletteCounts.set(color, (paletteCounts.get(color) ?? 0) + 1);
  const palette = [...paletteCounts]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([color]) => color);
  const sampleTimes = [
    ...new Set([
      ...cuts.map((c) => c.time),
      ...Array.from(
        { length: 6 },
        (_, i) => a.samples[Math.round((i * (a.samples.length - 1)) / 5)]!.time,
      ),
    ]),
  ].sort((x, y) => x - y);
  const selectedTimes =
    sampleTimes.length <= 12
      ? sampleTimes
      : Array.from(
          { length: 12 },
          (_, i) =>
            sampleTimes[Math.round((i * (sampleTimes.length - 1)) / 11)]!,
        );
  return {
    sourceDuration: a.duration,
    analyzedDuration: a.analyzedDuration,
    sourceStart: a.sourceStart,
    width: a.width,
    height: a.height,
    sampleInterval: a.sampleInterval,
    cuts,
    pacing: {
      medianShotSeconds: cuts.length ? median(lengths) : null,
      cutsPerMinute: (cuts.length / a.analyzedDuration) * 60,
      shotCount: cuts.length + 1,
    },
    caption,
    palette,
    sampleTimes: selectedTimes,
    limitations: [
      `Frames sampled every ${a.sampleInterval}s; cut times are approximate and flashes or camera motion can resemble cuts.`,
      ...(a.duration > a.analyzedDuration
        ? [
            `Only the first ${a.analyzedDuration}s of this reference were analyzed.`,
          ]
        : []),
      caption
        ? "Caption placement is an OCR-derived candidate; lower thirds can resemble subtitles."
        : "No sufficiently consistent changing caption region was found.",
      "Exact fonts, animated graphics, transitions, zoom choreography, music and color grading are not recovered from these measurements.",
      "Palette describes sampled picture colors, not a brand palette or a color-grading recipe.",
    ],
  };
}

export function validateReferenceProfile(
  value: unknown,
  duration?: number,
  sourceStart?: number,
): ReferenceProfile {
  const p = value as ReferenceProfile;
  if (
    !p ||
    !finite(p.sourceDuration) ||
    p.sourceDuration <= 0 ||
    p.sourceDuration > 86400 ||
    !finite(p.sourceStart) ||
    p.sourceStart < 0 ||
    !finite(p.analyzedDuration) ||
    p.analyzedDuration !== Math.min(p.sourceDuration, REFERENCE_MAX_SECONDS) ||
    p.sampleInterval !== REFERENCE_INTERVAL ||
    !Number.isInteger(p.width) ||
    !Number.isInteger(p.height) ||
    p.width < 1 ||
    p.height < 1 ||
    p.width > 65536 ||
    p.height > 65536 ||
    (duration !== undefined && Math.abs(duration - p.sourceDuration) > 1e-6) ||
    (sourceStart !== undefined &&
      Math.abs(sourceStart - p.sourceStart) > 1e-6) ||
    !Array.isArray(p.cuts) ||
    p.cuts.length > 240 ||
    !p.pacing ||
    !finite(p.pacing.cutsPerMinute) ||
    !Number.isInteger(p.pacing.shotCount) ||
    p.pacing.shotCount !== p.cuts.length + 1 ||
    Math.abs(
      p.pacing.cutsPerMinute - (p.cuts.length / p.analyzedDuration) * 60,
    ) > 1e-6 ||
    !(
      p.pacing.medianShotSeconds === null ||
      (finite(p.pacing.medianShotSeconds) &&
        p.pacing.medianShotSeconds > 0 &&
        p.pacing.medianShotSeconds <= p.analyzedDuration)
    )
  )
    throw new Error("Invalid saved reference profile.");
  for (const [i, c] of p.cuts.entries())
    if (
      !finite(c.time) ||
      c.time <= 0 ||
      c.time >= p.analyzedDuration ||
      !unit(c.score) ||
      (i > 0 && c.time <= p.cuts[i - 1]!.time)
    )
      throw new Error("Invalid saved cut evidence.");
  const c = p.caption;
  if (
    c !== null &&
    (!c ||
      !unit(c.x) ||
      !unit(c.y) ||
      !unit(c.width) ||
      !unit(c.height) ||
      c.width <= 0 ||
      c.height <= 0 ||
      c.x + c.width > 1.001 ||
      c.y + c.height > 1.001 ||
      !unit(c.fontSizeRatio) ||
      c.fontSizeRatio < 0.012 ||
      c.fontSizeRatio > 0.1 ||
      !unit(c.coverage) ||
      !Number.isInteger(c.observations) ||
      c.observations < 3 ||
      !Number.isInteger(c.distinctTexts) ||
      c.distinctTexts < 2 ||
      !Array.isArray(c.examples) ||
      c.examples.length > 4 ||
      c.examples.some((s) => typeof s !== "string" || s.length > 240) ||
      !["classic", "whisper"].includes(c.suggestedPreset))
  )
    throw new Error("Invalid saved caption evidence.");
  if (
    !Array.isArray(p.palette) ||
    p.palette.length > 5 ||
    p.palette.some((c) => !/^#[0-9a-f]{6}$/i.test(c)) ||
    !Array.isArray(p.sampleTimes) ||
    p.sampleTimes.length < 1 ||
    p.sampleTimes.length > 12 ||
    p.sampleTimes.some((t) => !finite(t) || t < 0 || t >= p.analyzedDuration) ||
    !Array.isArray(p.limitations) ||
    p.limitations.length > 10 ||
    p.limitations.some((s) => typeof s !== "string" || s.length > 500)
  )
    throw new Error("Invalid saved reference metadata.");
  return structuredClone(p);
}
