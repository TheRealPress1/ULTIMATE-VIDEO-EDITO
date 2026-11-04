/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `segment`: the local SAM 2.1 mask model as a tool of its own, so a mask
// does not have to be found under `generate`. The request is the model's
// (`samRequest` checks it, so both routes refuse the same things) and the job
// is the same local job `job` polls; what this tool adds is waiting for the
// track when asked, and one flat answer instead of a job to dig through.

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { NonNegativeTime, TIME_FORMS } from "../time";
import { SAM_SIZES, WEAK_IOU, samRequest } from "../local/sam";
import { GenerationResult } from "./generate";

const Unit = z.number().min(0).max(1);
const Point = z.strictObject({ x: Unit, y: Unit });
const Bounds = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Range = z.tuple([z.number(), z.number()]);

/** Longest a call waits for a track before answering with the job still running. */
export const SEGMENT_MAX_WAIT_SECONDS = 3600;
/** What a waiting call gives the track by default. */
export const SEGMENT_DEFAULT_WAIT_SECONDS = 600;

export const SEGMENT_STATES = ["previewed", "tracking", "done", "failed", "canceled"] as const;

const segmentFields = {
  path: AssetPath.describe("the video: an absolute path, or a library path like `footage/skater.mp4` (needs an open project)"),
  time: NonNegativeTime.describe(`the frame the prompts are placed on, in source time — ${TIME_FORMS}`),
  points: z.array(Point).optional().describe("points on the object, each { x, y } in 0..1 of the frame as grab draws it"),
  exclude: z.array(Point).optional().describe("points on what is not the object, to take it out of the mask"),
  box: Bounds.optional().describe("a box around the object, [x0, y0, x1, y1] in 0..1 of the frame: usually the most reliable first prompt"),
  preview: z.boolean().optional().describe("segment only the frame at `time` and make no mask: check a prompt in a second before tracking"),
  start: NonNegativeTime.optional().describe(`start of the span to track — ${TIME_FORMS} (default: 0); pass the span the clip plays`),
  end: NonNegativeTime.optional().describe(`end of the span to track — ${TIME_FORMS} (default: the file's end)`),
  size: z.enum(SAM_SIZES).optional().describe("tiny (fastest, the default), small, base-plus, or large (slowest; finest edges, best on small objects)"),
  output: z
    .string()
    .optional()
    .describe(
      "the mask file: a library path like `masks/skater.mask` (needs an open project) or an absolute path (default: the library's `masks/<video>/Tracking <n>.mask`, or a temp folder with no project open)",
    ),
  wait: z
    .boolean()
    .optional()
    .describe("wait for the track to finish before answering (default: false for a library mask, true for an absolute output, which is written when the track ends)"),
  timeoutSeconds: z
    .int()
    .min(1)
    .max(SEGMENT_MAX_WAIT_SECONDS)
    .optional()
    .describe(`with wait, answer after this long with the job still tracking (default ${SEGMENT_DEFAULT_WAIT_SECONDS}); poll it with job`),
};

/** The model's request for a segment call: what `generate` would be sent for the same mask. */
export function segmentRequest(value: {
  path: string;
  wait?: boolean | undefined;
  timeoutSeconds?: number | undefined;
  [key: string]: unknown;
}): Record<string, unknown> {
  const { path, wait: _wait, timeoutSeconds: _timeout, ...fields } = value;
  return Object.fromEntries(
    Object.entries({ model: "sam-2.1", video: { path }, ...fields }).filter(([, field]) => field !== undefined),
  );
}

const input = z.object(segmentFields).superRefine((value, ctx) => {
  if (value.preview && value.wait !== undefined) {
    ctx.addIssue({ code: "custom", path: ["wait"], message: "a preview answers at once; wait applies to tracking only" });
  }
  // The model's own schema decides, so `segment` and `generate` refuse the same requests.
  const parsed = samRequest.safeParse(segmentRequest(value));
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const path = issue.path[0] === "video" ? ["path"] : issue.path.filter((key): key is string | number => typeof key !== "symbol");
    ctx.addIssue({ code: "custom", path, message: issue.message });
  }
});

export const SegmentOutput = z.object({
  state: z
    .enum(SEGMENT_STATES)
    .describe("previewed: the prompt's picture is ready; tracking: the job is still running (poll job with jobId); done: the mask is saved; failed or canceled: see error"),
  jobId: z.string().describe("the local job, for job (poll or cancel); jobs live until the app restarts"),
  model: z.string().describe("sam-2.1-<size>"),
  path: z.string().optional().describe("absolute path of the mask file, once done"),
  src: z.string().optional().describe("the mask's library path, for `<mask src>`, when it went into the project's library"),
  image: z
    .string()
    .optional()
    .describe("absolute path of a PNG: the prompted frame with its mask on a preview, a contact sheet of tracked frames once done; inline the first time"),
  frameRate: z.number().optional().describe("frames per second the mask holds"),
  start: z.number().optional().describe("source second of the first masked frame: the `sourceIn` of a `<mask>` naming the file"),
  end: z.number().optional().describe("source second just past the last masked frame"),
  frames: z.int().optional().describe("frames masked (1 on a preview)"),
  bbox: Bounds.nullable().optional().describe("on the prompted frame, the object's bounds as [x0, y0, x1, y1] in 0..1; null when nothing was segmented"),
  area: z.number().optional().describe("on the prompted frame, the share of the frame the object covers, 0..1"),
  score: z.number().optional().describe("on the prompted frame, the object score: at or below 0 the model sees no object"),
  iou: z.number().optional().describe("on the prompted frame, the model's estimate of the mask's quality, 0..1"),
  lost: z.array(Range).optional().describe("[start, end) source-second spans where no object was found: check them with grab"),
  weak: z.array(Range).optional().describe(`[start, end) source-second spans where the mask rated below ${WEAK_IOU}`),
  phase: z.string().optional().describe("while tracking: queued, downloading (first use of a size) or tracking"),
  progress: z.number().nullable().optional().describe("while tracking: 0..1 through the phase"),
  etaRemainingSeconds: z.number().nullable().optional().describe("while tracking: seconds left, measured from the frames done so far"),
  error: z.string().optional().describe("why the job failed or was canceled"),
});

export type SegmentAnswer = z.output<typeof SegmentOutput>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const ranges = (value: unknown): Array<[number, number]> | undefined =>
  Array.isArray(value) ? value.filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length === 2 && finite(pair[0]) && finite(pair[1])) : undefined;

/**
 * A local SAM job, as `job` would answer for it, flattened into the tool's
 * answer. `preview` is whether the call asked for one; the job's `details`
 * hold the span and, once it has ended, what was found.
 */
export function flattenSegmentJob(job: z.output<typeof GenerationResult>["job"], preview: boolean): SegmentAnswer {
  const details = (job.details ?? {}) as Record<string, unknown>;
  const request = (job.request ?? {}) as Record<string, unknown>;
  const size = typeof request.size === "string" ? request.size : "tiny";
  const status = job.status;
  const state: SegmentAnswer["state"] =
    status === "succeeded" ? (preview ? "previewed" : "done") : status === "failed" ? "failed" : status === "canceled" ? "canceled" : "tracking";
  const file = job.assets[0] as { path?: unknown; src?: unknown } | undefined;
  const error = (job.error as { message?: unknown } | null | undefined)?.message;
  const bbox = details.bbox;
  return {
    state,
    jobId: job.id,
    model: `sam-2.1-${size}`,
    ...(typeof file?.path === "string" ? { path: file.path } : {}),
    ...(typeof file?.src === "string" ? { src: file.src } : {}),
    ...(typeof details.image === "string" ? { image: details.image } : {}),
    ...(finite(details.frameRate) ? { frameRate: details.frameRate } : {}),
    ...(finite(details.start) ? { start: details.start } : {}),
    ...(finite(details.end) ? { end: details.end } : {}),
    ...(finite(details.frames) ? { frames: Math.round(details.frames) } : {}),
    ...(bbox === null || (Array.isArray(bbox) && bbox.length === 4 && bbox.every(finite)) ? { bbox: bbox as [number, number, number, number] | null } : {}),
    ...(finite(details.area) ? { area: details.area } : {}),
    ...(finite(details.score) ? { score: details.score } : {}),
    ...(finite(details.iou) ? { iou: details.iou } : {}),
    ...(ranges(details.lost) ? { lost: ranges(details.lost) } : {}),
    ...(ranges(details.weak) ? { weak: ranges(details.weak) } : {}),
    ...(state === "tracking" && typeof job.phase === "string" ? { phase: job.phase } : {}),
    ...(state === "tracking" && (finite(job.progress) || job.progress === null) ? { progress: job.progress as number | null } : {}),
    ...(state === "tracking" && (finite(job.etaRemainingSeconds) || job.etaRemainingSeconds === null) ? { etaRemainingSeconds: job.etaRemainingSeconds as number | null } : {}),
    ...(typeof error === "string" && (state === "failed" || state === "canceled") ? { error } : {}),
  };
}

export const segment = defineTool({
  name: "segment",
  title: "Segment and track an object",
  description:
    "Mask an object in a video with SAM 2.1 on this Mac (GPU, free, no account) and track it through a span, making the `.mask` file a `<mask src>` names: text behind a person, a color grade on one subject, an object cut out. Prompt it with a box around the object (most reliable) and/or points on it, plus `exclude` points to take spill away; coordinates are 0..1 of the frame as grab draws it. Start with `preview: true` on a grabbed frame: it answers in a second or two with a picture of the mask and its `bbox`, `score` and `iou`, and no file. Then track the span the clip plays (`start`/`end`, with `time` inside it). A library mask answers at once with `state: tracking` and a `jobId` (poll job, or watch context's `jobs`); `wait: true` (the default for an absolute `output`) holds the call until the mask is saved. The answer gives the mask's `src`, its `start` (the `<mask sourceIn>`), and the `lost` and `weak` spans to check with grab. The same model also runs as generate's `sam-2.1`; prefer this tool.",
  input,
  output: SegmentOutput,
  result: GenerationResult,
  environment: "renderer",
  annotations: { destructiveHint: false, openWorldHint: false },
});
