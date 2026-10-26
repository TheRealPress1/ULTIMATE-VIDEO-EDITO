import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, SceneId } from "../schemas";
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Caption = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fontSizeRatio: z.number(),
  coverage: z.number(),
  observations: z.int(),
  distinctTexts: z.int(),
  examples: z.array(z.string()),
  suggestedPreset: z.enum(["classic", "whisper"]),
});
const Profile = z.object({
  sourceDuration: z.number(),
  analyzedDuration: z.number(),
  sourceStart: z.number(),
  width: z.number(),
  height: z.number(),
  sampleInterval: z.number(),
  cuts: z.array(z.object({ time: z.number(), score: z.number() })),
  pacing: z.object({
    medianShotSeconds: z.number().nullable(),
    cutsPerMinute: z.number(),
    shotCount: z.int(),
  }),
  caption: Caption.nullable(),
  palette: z.array(z.string()),
  sampleTimes: z.array(z.number()),
  limitations: z.array(z.string()),
});
export const referenceAnalyze = defineTool({
  name: "reference_analyze",
  title: "Analyze a reference video",
  description:
    "Measure an imported reference video locally with AVFoundation and Vision. Samples its first 120 seconds at 4 fps for approximate hard cuts and shot cadence, and once per second for changing lower-screen text layout and observed frame colors. Returns full-source-SHA-256-bound reusable evidence, aspect ratio, and source-relative sampleTimes to inspect with grab. A cut candidate may be a flash or motion; short cuts and dissolves can be missed. Caption layout is an OCR estimate, not recovered typography. Palette is observed footage color, not brand color or a grading recipe. No exact font, zoom choreography, transitions, audio or emotion inference. Read the limitations and inspect reference frames before editing. Does not alter the timeline or download anything.",
  input: z.object({ path: AssetPath }),
  output: z.object({
    fingerprint: Fingerprint,
    engine: z.string(),
    analyzedAt: z.string().nullable(),
    profile: Profile.nullable(),
  }),
  environment: "renderer",
  annotations: { destructiveHint: false, openWorldHint: false },
});
export const referenceApply = defineTool({
  name: "reference_apply",
  title: "Apply reference layout to a new scene",
  description:
    "Create an editable scene copy with the measured reference aspect ratio and estimated caption region/size. Requires the fingerprint returned by reference_analyze; changed media is rejected. Keeps the original scene, transcript words, clip timing and source files, creates a recovery version, and inserts the copy as one undoable change. Supports full-frame video, sequences, captions, audio and static overlays; animated custom spatial layouts need preparation. Center-crops video when the frame changes. This is the first layout pass, not the full reference edit: use the returned new scene ID, inspect reference sampleTimes with grab, then use regular editing tools to reproduce observed pacing/graphics where appropriate, preserving speech and story. Never discard dialogue just to match the reference median shot length, or invent exact font/zoom/music claims.",
  input: z.object({
    id: SceneId,
    path: AssetPath,
    fingerprint: Fingerprint,
    matchFormat: z.boolean().default(true),
    matchCaptions: z.boolean().default(true),
    name: z.string().trim().min(1).max(100).optional(),
  }),
  output: z.object({
    sceneId: z.string(),
    name: z.string(),
    width: z.number(),
    height: z.number(),
    captionLayers: z.int().nonnegative(),
    changes: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  environment: "renderer",
  annotations: { destructiveHint: false, openWorldHint: false },
});
