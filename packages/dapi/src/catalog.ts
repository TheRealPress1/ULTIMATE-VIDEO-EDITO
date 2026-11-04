/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { z } from "zod";
import type { GenericTool } from "./tool";

import { open } from "./tools/open";
import { skills, editingStyle } from "./tools/skills";
import { memory } from "./tools/memory";
import { skillWrite } from "./tools/skill-write";
import { scriptLint, scriptReadCompare } from "./tools/script";
import { audioCatalog } from "./tools/audio-catalog";
import { context } from "./tools/context";
import { capture } from "./tools/capture";
import { check } from "./tools/check";
import { qualityReview } from "./tools/quality-review";
import { exportScene } from "./tools/export";
import { logs } from "./tools/logs";
import { screenshot } from "./tools/screenshot";
import { probe } from "./tools/probe";
import { grab } from "./tools/grab";
import { transcribe } from "./tools/transcribe";
import { analyze } from "./tools/analyze";
import { segment } from "./tools/segment";
import { footageIndex, footageSearch, footageCut } from "./tools/footage";
import { visualIndex, visualSearch, visualStatus } from './tools/visual';
import { transcriptEditInspect,transcriptEditApply } from './tools/transcript-edit';
import { referenceAnalyze, referenceApply } from "./tools/reference-style";
import { reframe } from "./tools/reframe";
import { captions } from "./tools/captions";
import { audioFinish } from "./tools/audio-finish";
import { filmstrip } from "./tools/filmstrip";
import { waveform } from "./tools/waveform";
import { listen } from "./tools/listen";
import { soundAnalyze, soundEffects } from "./tools/sound";
import { generate, job } from "./tools/generate";
import { webMediaSearch, webMediaDownload } from "./tools/web-media";
import { mediaSearch, mediaDownload } from "./tools/media";
import { fonts } from "./tools/fonts";
import { report } from "./tools/report";
import { appWindow } from "./tools/window";
import { instagramAccounts, instagramPosts, instagramPostAnalytics, instagramAccountInsights } from "./tools/instagram";

/**
 * Every tool, in the order a listing shows them: the project loop first
 * (open, look, capture, check, export), then media inspection, then
 * generation and web media, then the app and machine utilities.
 */
export const catalog = [
  skills,
  editingStyle,
  audioCatalog,
  memory,
  skillWrite,
  scriptLint,
  scriptReadCompare,
  open,
  context,
  capture,
  check,
  qualityReview,
  exportScene,
  probe,
  grab,
  transcribe,
  analyze,
  footageIndex,
  footageSearch,
  footageCut,
  visualIndex,
  visualSearch,
  visualStatus,
  transcriptEditInspect,
  transcriptEditApply,
  referenceAnalyze,
  referenceApply,
  reframe,
  captions,
  audioFinish,
  filmstrip,
  waveform,
  listen,
  soundAnalyze,
  soundEffects,
  segment,
  generate,
  job,
  webMediaSearch,
  webMediaDownload,
  mediaSearch,
  mediaDownload,
  logs,
  screenshot,
  appWindow,
  fonts,
  report,
  instagramAccounts,
  instagramPosts,
  instagramPostAnalytics,
  instagramAccountInsights,
] as const;

export type AnyTool = (typeof catalog)[number];
export type ToolName = AnyTool["name"];
export type ToolByName<N extends ToolName> = Extract<AnyTool, { name: N }>;

/** What a caller sends: times as strings or numbers, defaults omitted. */
export type ToolInput<N extends ToolName> = z.input<ToolByName<N>["input"]>;
/** What a handler receives: parsed, defaults applied. */
export type ToolArgs<N extends ToolName> = z.output<ToolByName<N>["input"]>;
/** What a caller receives: the tool's structured content. */
export type ToolOutput<N extends ToolName> = z.output<ToolByName<N>["output"]>;
/** What a handler returns; the output, unless the tool declares a `result`. */
export type ToolResult<N extends ToolName> = ToolByName<N> extends { result?: infer R }
  ? R extends z.ZodType
    ? z.output<R>
    : ToolOutput<N>
  : ToolOutput<N>;

const byName = new Map<string, AnyTool>(catalog.map((tool) => [tool.name, tool]));

export function toolByName<N extends ToolName>(name: N): ToolByName<N> {
  return byName.get(name) as ToolByName<N>;
}

export function isToolName(name: string): name is ToolName {
  return byName.has(name);
}

/** The catalog with each tool's specifics erased, for code that iterates it. */
export const tools: readonly GenericTool[] = catalog;
