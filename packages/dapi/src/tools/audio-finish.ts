import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, SceneId } from "../schemas";

const Loudness = z.object({
  integratedLufs: z.number().nullable(), truePeakDb: z.number().nullable(), loudnessRangeLu: z.number().nullable(), thresholdLufs: z.number().nullable(),
  duration: z.number(), sampleRate: z.number(), channels: z.number(), frames: z.number(), samplePeakDb: z.number().nullable(), rmsDb: z.number().nullable(), fullScaleSamples: z.number(),
  silenceSpans: z.array(z.object({ start: z.number(), end: z.number() })),
});

export const audioFinish = defineTool({
  name: "audio_finish",
  title: "Measure and finish audio",
  description: "Local audio finishing: action measure reports integrated LUFS, true peak and loudness range for a local source path or a sceneId's complete lossless edited mix. Action finish on a path saves a unique PCM WAV derivative with two-pass loudness normalization, optional dialogue leveling and conservative noise reduction. Action finish on sceneId creates a new editable scene: selected top-level audio musicIds stay separate with adjustable group-volume ducking keyframes; the remaining dialogue mix is finished into a derivative. Original scene/media remain intact; one Undo removes the new scene. Ducking follows dialogue audio activity, not speaker recognition. The combined finished mix is measured separately and may need music gain adjustment. Legacy inspect/normalize remain sample-peak/RMS-only operations on path. All processing is local with bundled FFmpeg, no upload/API payment. Mono/stereo sources/scenes up to ten minutes and 256 MiB decoded PCM (legacy 128 MiB), source files 512 MiB. Review before export; cannot repair previously clipped detail.",
  input: z.object({
    path: AssetPath.optional(),
    sceneId: SceneId.optional().describe('measure/finish the complete edited scene instead of a source path'),
    action: z.enum(["inspect", "normalize", "measure", "finish"]).default("inspect"),
    targetPeakDb: z.number().min(-24).max(-0.1).default(-1).describe("normalization sample-peak target in dBFS; ignored by inspect (default -1)"),
    targetLufs: z.number().min(-36).max(-9).optional().describe('finish dialogue/source integrated loudness target; default -16 LUFS'),
    truePeakDb: z.number().min(-9).max(-0.1).optional().describe('finish dialogue/source true-peak ceiling; default -1 dBTP'),
    levelDialogue: z.boolean().optional(),
    denoise: z.boolean().optional(),
    musicIds: z.array(z.string().min(1)).max(32).optional().describe('top-level audio clip IDs to retain as background music in scene finish; other audio becomes the finished dialogue mix'),
    duckingDb: z.number().min(0).max(30).optional().describe('background attenuation during dialogue activity; default 12 dB'),
    activityThresholdDb: z.number().min(-70).max(-10).optional().describe('dialogue activity RMS threshold for ducking; default -42 dBFS'),
  }).superRefine((value, ctx) => {
    if (!!value.path === !!value.sceneId) ctx.addIssue({ code: 'custom', message: 'Provide exactly one local path or sceneId.' });
    if (value.sceneId && ['inspect', 'normalize'].includes(value.action)) ctx.addIssue({ code: 'custom', message: 'Scenes use measure or finish.' });
    if (value.musicIds?.length && (!value.sceneId || value.action !== 'finish')) ctx.addIssue({ code: 'custom', message: 'musicIds apply only to scene finishing.' });
  }),
  output: z.object({
    action: z.enum(["inspect", "normalize", "measure", "finish"]),
    source: z.string(),
    duration: z.number().nonnegative(),
    sampleRate: z.number().positive(),
    channels: z.int().min(1).max(2),
    samplePeakDb: z.number().nullable().describe("dBFS; null for digital silence"),
    rmsDb: z.number().nullable().describe("unweighted RMS in dBFS; not LUFS; null for silence"),
    fullScaleSamples: z.int().nonnegative().describe("decoded samples with absolute amplitude >= 1; a warning, not proof of clipping history"),
    outputPath: z.string().nullable().describe("normalized derivative library path; null for inspect"),
    appliedGainDb: z.number().nullable(),
    outputSamplePeakDb: z.number().nullable(),
    warnings: z.array(z.string()),
    inputLoudness: Loudness.optional(),
    outputLoudness: Loudness.optional(),
    mixLoudness: Loudness.optional().describe('actual combined dialogue/music result after scene finishing'),
    createdSceneId: z.string().optional(),
    musicKeyframeCount: z.number().optional(),
  }),
  environment: "renderer",
  annotations: { destructiveHint: false, openWorldHint: false },
});
