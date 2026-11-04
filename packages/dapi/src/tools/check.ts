/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { NodeId } from "../schemas";

export const CheckIssueCode = z.enum([
  "black-frames",
  "no-visuals",
  "never-visible",
  "zero-duration",
  "transparent",
  "source-error",
  "short-visible-stretch",
]);

/**
 * One structural finding. `ranges` (where present) are seconds relative to
 * the checked node's start — the same clock `capture` positions use.
 */
export const CheckIssue = z.object({
  code: CheckIssueCode,
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  node: z
    .string()
    .optional()
    .describe("source stamp of the offending node; absent when the issue is about the subtree as a whole"),
  ranges: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
});

export const check = defineTool({
  name: "check",
  title: "Check structure",
  description:
    "Check a node's subtree for obvious structural mistakes, without rendering (local analysis, no credits): spans where no visual is scheduled (likely black frames), children that never become visible, zero-duration or fully transparent nodes, assets that failed to load, and full-frame shots on screen for less than minVisibleSeconds between two others (a flash, often a B-roll edge just after a talking-head cut) — plus subtree stats (node count by kind, nesting depth, played duration, what the visible-stretch pass could not judge). Times in issue ranges are seconds relative to the node's start — for a scene whose workarea starts at 0, the same clock capture uses. Structural only: a scheduled clip can still render black (dark footage, content smaller than the canvas), so confirm suspicious spans visually with capture.",
  input: z.object({
    id: NodeId,
    minVisibleSeconds: z
      .number()
      .min(0)
      .max(2)
      .default(0.4)
      .describe("shortest time a full-frame shot may stay on screen between two others, in seconds (default 0.4; 0 turns the rule off)"),
  }),
  output: z.object({
    stats: z.object({
      nodes: z.int().describe("nodes in the subtree, the checked node included"),
      byKind: z.record(z.string(), z.int()),
      depth: z.int().describe("deepest nesting level below the checked node (0 = no children)"),
      duration: z.number().describe("seconds the checked node plays (its workarea, when one is set)"),
      visibility: z
        .object({
          minVisibleSeconds: z.number(),
          stretches: z.int().describe("full-frame stretches found, in order of play"),
          shortStretches: z.int(),
          evaluatedLayers: z.int().describe("videos, images and filled rectangles judged for coverage"),
          skippedLayers: z.int().describe("layers that could not be judged statically (masked, keyframed, animated, blended, rotated, fitted)"),
          skipped: z.array(z.object({ node: z.string().optional(), reason: z.string() })).describe("up to 20 of the skipped layers"),
        })
        .optional()
        .describe("the visible-stretch pass; absent when it is off or the node has no scene canvas"),
    }),
    issues: z.array(CheckIssue),
  }),
  environment: "renderer",
});
