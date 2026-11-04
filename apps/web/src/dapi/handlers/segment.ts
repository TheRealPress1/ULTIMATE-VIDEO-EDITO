/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SEGMENT_DEFAULT_WAIT_SECONDS, segmentRequest } from "@diffusionstudio/dapi";

import { destination } from "../lib/outputs";
import { localJob, startLocalJob } from "../local/jobs";

import type { GenerateRequest, GenerationResult } from "@diffusionstudio/dapi";
import type { ToolHandler } from "../handler";

/** How often a waiting call looks at its job. */
export const SEGMENT_POLL_MS = 500;

const ended = (status: string) => status === "succeeded" || status === "failed" || status === "canceled";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * SAM 2.1 as its own tool: the request `generate` would send for the same
 * mask, started as the same local job (so `job` polls and cancels it), and,
 * when the call waits, followed until it ends or the wait runs out. A caller
 * that goes away while waiting leaves the job running. The server writes the
 * job's picture and any file bound for disk, then flattens the job.
 */
export const segment: ToolHandler<"segment"> = async (args, ctx) => {
  const request = segmentRequest(args) as GenerateRequest;
  const target = destination(args.output, ctx.session());
  const started = (await startLocalJob(request, target, ctx)) as GenerationResult;
  if (args.preview || ended(started.job.status)) return started;
  // A mask bound for disk is written when a poll sees it done, so by default this call is that poll.
  if (!(args.wait ?? target.kind === "disk")) return started;

  const deadline = Date.now() + (args.timeoutSeconds ?? SEGMENT_DEFAULT_WAIT_SECONDS) * 1000;
  let latest = started;
  while (!ended(latest.job.status) && Date.now() < deadline && !ctx.signal.aborted) {
    await sleep(Math.min(SEGMENT_POLL_MS, Math.max(0, deadline - Date.now())), ctx.signal);
    latest = localJob(started.job.id, false);
  }
  return latest;
};
