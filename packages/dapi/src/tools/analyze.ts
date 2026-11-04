/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `analyze`: one bounded, timestamped evidence pack for a whole video, built
// on this Mac from what the other inspection tools measure (speech, silences,
// sampled frames, visual index labels and text, audio events when the audio
// add-on is ready). The calling agent reads it and draws the conclusions:
// nothing here watches the video the way a person would, and the prompt only
// decides which sections and frames come first.

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, Bytes, checkWindow, windowFields } from "../schemas";

export const ANALYZE_DEPTHS = ["quick", "standard", "thorough"] as const;
export type AnalyzeDepth = (typeof ANALYZE_DEPTHS)[number];

export const ANALYZE_FOCUS = ["speech", "visual", "text", "audio"] as const;
export type AnalyzeFocus = (typeof ANALYZE_FOCUS)[number];

/** Frames sampled per depth: at most four contact sheets of twelve. */
export const ANALYZE_FRAME_BUDGET: Record<AnalyzeDepth, number> = { quick: 12, standard: 24, thorough: 48 };

/** Sections the timeline is cut into at most, per depth. */
export const ANALYZE_SECTION_LIMIT: Record<AnalyzeDepth, number> = { quick: 12, standard: 24, thorough: 48 };

/** Windows longer than this run as a background job: start answers with a jobId, status follows it. */
export const ANALYZE_JOB_SECONDS = 600;

/** The longest window one call analyzes. */
export const ANALYZE_MAX_SECONDS = 7200;

/** How long `status` waits for a running job to end before answering with its progress. */
export const ANALYZE_STATUS_WAIT_SECONDS = 20;

export const ANALYZE_PROMPT_MAX = 2000;

export const ANALYZE_STATES = ["queued", "running", "done", "failed", "canceled"] as const;

const Span = z.object({ start: z.number(), end: z.number() });

const Section = z.object({
  index: z.int().describe("position in the timeline, from 0"),
  start: z.number().describe("absolute source seconds"),
  end: z.number().describe("absolute source seconds"),
  speech: z.string().optional().describe("what was said, up to 300 characters, cut at a word"),
  words: z.int().describe("words spoken in the section"),
  visual: z
    .object({
      labels: z.array(z.string()).describe("image categories seen in sampled frames, strongest first"),
      text: z.array(z.string()).describe("on-screen text read by OCR"),
      people: z.int().describe("most people counted in one sampled frame"),
    })
    .optional()
    .describe("present when the source is visually indexed"),
  silent: z.boolean().nullable().describe("true when silence covers most of it; null when the audio was not measured"),
  audio: z.array(z.string()).optional().describe("sound events heard in it, when audio events are included"),
  keyframe: z
    .object({ time: z.number(), sheet: z.int(), cell: z.int() })
    .optional()
    .describe("the sampled frame that stands for the section: its source time and where it sits on the contact sheets (from 0)"),
  match: z.object({ score: z.number(), terms: z.array(z.string()) }).optional().describe("how the prompt's words matched here; ranking only"),
});

const Frame = z.object({
  time: z.number().describe("absolute source seconds"),
  timecode: z.string().describe("the label printed on its cell"),
  sheet: z.int(),
  cell: z.int(),
  reason: z.enum(["scene-change", "coverage", "prompt"]).describe("why it was picked"),
});

const SheetInfo = {
  index: z.int(),
  timecode: z.string().describe("the span its cells cover"),
  start: z.number().describe("source second of its first cell"),
  end: z.number().describe("source second of its last cell"),
  cells: z.int(),
};

const Check = z.object({
  tool: z.string().describe("the tool to call"),
  args: z.record(z.string(), z.unknown()).describe("its arguments, ready to send"),
  reason: z.string(),
});

const AudioEvent = z.object({ start: z.number(), end: z.number().optional(), labels: z.array(z.string()), level: z.number().optional() });

/** What every answer carries; a finished job adds the evidence. */
const answer = {
  state: z.enum(ANALYZE_STATES).describe("done: the evidence is below; queued or running: call again with action status and the jobId; failed or canceled: see error"),
  jobId: z.string().optional().describe("the job, for status and cancel; present for every call that became a job"),
  method: z.literal("local-evidence"),
  progress: z.object({ phase: z.string(), fraction: z.number().nullable() }).optional().describe("while queued or running"),
  error: z.string().optional(),
  source: z
    .object({
      path: z.string(),
      duration: z.number(),
      start: z.number().describe("window start, absolute source seconds"),
      end: z.number().describe("window end, absolute source seconds"),
      video: z.boolean(),
      audio: z.boolean(),
      width: z.int().optional(),
      height: z.int().optional(),
      frameRate: z.number().optional(),
    })
    .optional(),
  depth: z.enum(ANALYZE_DEPTHS).optional(),
  focus: z.array(z.enum(ANALYZE_FOCUS)).optional(),
  promptKeywords: z.array(z.string()).optional().describe("the prompt's words used to rank sections; the prompt itself is never run or answered"),
  speech: z
    .object({
      origin: z.enum(["footage-index", "transcribed", "none", "skipped", "failed"]),
      words: z.int(),
      note: z.string().optional(),
    })
    .optional(),
  visual: z
    .object({
      origin: z.enum(["visual-index", "frames-only", "none", "skipped"]),
      samples: z.int().describe("visual index samples inside the window"),
      sampleInterval: z.number().optional(),
      frameSelection: z.enum(["scene-change", "even", "none"]).describe("how sampled frames were chosen"),
    })
    .optional(),
  audio: z
    .object({
      silences: z.array(Span).describe("silent spans, absolute source seconds (up to 100)"),
      events: z.object({
        state: z.enum(["included", "installing", "unavailable", "skipped", "failed"]),
        note: z.string().optional(),
        summary: z.string().optional().describe("the audio add-on's listening summary, shortened"),
        items: z.array(AudioEvent).optional(),
      }),
    })
    .optional(),
  sections: z.array(Section).optional().describe("the window cut at visual changes or regular blocks, in order"),
  frames: z.array(Frame).optional().describe("every sampled frame on the contact sheets, in time order"),
  suggestedChecks: z.array(Check).optional().describe("follow-up calls that verify or deepen the evidence"),
  limitations: z.array(z.string()).optional(),
  cached: z.boolean().optional().describe("some evidence came from this source's analysis cache"),
};

const input = z
  .object({
    action: z
      .enum(["start", "status", "cancel"])
      .optional()
      .describe("start (default) analyzes `path`; status follows a job; cancel stops one"),
    jobId: z.string().min(1).max(200).optional().describe("the job to follow or stop, as start returned it"),
    path: AssetPath.optional().describe("the local video or audio file: an absolute path or a library path (needs an open project); required for start"),
    prompt: z
      .string()
      .max(ANALYZE_PROMPT_MAX)
      .optional()
      .describe("what you want to find out, used only to rank sections and pick extra frames for its words; it is never run or answered"),
    start: windowFields.start.describe("window start, source seconds (default 0)"),
    end: windowFields.end.describe("window end, source seconds (default the file's end); at most two hours after start"),
    depth: z
      .enum(ANALYZE_DEPTHS)
      .optional()
      .describe("quick (12 frames, 1 sheet), standard (24 frames, 2 sheets; the default) or thorough (48 frames, 4 sheets)"),
    focus: z
      .array(z.enum(ANALYZE_FOCUS))
      .min(1)
      .max(ANALYZE_FOCUS.length)
      .optional()
      .describe("which evidence to gather: speech, visual (frames and labels), text (on-screen text) and audio (silences and sound events); default all"),
  })
  .superRefine((value, ctx) => {
    const action = value.action ?? "start";
    if (action === "start" && value.path === undefined) ctx.addIssue({ code: "custom", path: ["path"], message: "start needs the `path` to analyze" });
    if (action === "start" && value.jobId !== undefined) ctx.addIssue({ code: "custom", path: ["jobId"], message: "jobId is for status and cancel; start makes its own" });
    if (action !== "start" && value.jobId === undefined) ctx.addIssue({ code: "custom", path: ["jobId"], message: `${action} needs the \`jobId\` start returned` });
    checkWindow(value, ctx);
  });

export const analyze = defineTool({
  name: "analyze",
  title: "Analyze a video",
  description:
    "Build one timestamped evidence pack for a whole video or audio file (or a start/end window) on this Mac, for whole-video questions: what happens, how it is structured, where something is said or shown. It gathers the speech transcript (the footage index when the file is indexed, else local Whisper), silences, frames picked at visual changes within a fixed budget (quick 12, standard 24, thorough 48) shown inline as up to 4 timecoded contact sheets, the visual index's labels, on-screen text and people counts when the file is visually indexed, and sound events when the audio add-on is ready (it starts that add-on's install in the background otherwise and carries on without them). The answer is a sections timeline (start/end in absolute source seconds, what was said, what was seen, silent or not, a keyframe), the frames, suggestedChecks to verify with grab/listen, and limitations. You interpret it: this is sampled evidence, not real watching; it misses brief events between frames and recognizes no actions, identities, emotions or music. `prompt` only ranks sections and adds frames where its words are spoken or seen; it is never run or answered. Windows over 10 minutes run as a job: start answers with a jobId, then call with action status (waits up to 20 s) until done, or cancel. Completed steps are cached per source fingerprint in the project's analysis cache, so a repeat call or a restarted job picks up where it was. After analyze, confirm the moments you will act on with grab or listen.",
  input,
  output: z.object({ ...answer, sheets: z.array(z.object({ ...SheetInfo, path: z.string().describe("absolute path of the JPEG") })).optional() }),
  result: z.object({ ...answer, sheets: z.array(z.object({ ...SheetInfo, bytes: Bytes, mimeType: z.string() })).optional() }),
  environment: "renderer",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});
