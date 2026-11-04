/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Computed, Fonts, FrameRate, getActiveEntity } from "@diffusionstudio/runtime";
import { CONTEXT_JOB_LIMIT } from "@diffusionstudio/dapi";
import { saveFolder } from "@/projects";
import { localJobRows } from "../local/jobs";
import { analyzeJobRows } from "./analyze";

import type { ToolHandler } from "../handler";

/**
 * What the project's source cannot say. The JSX is the composition — its
 * scenes, what is selected, which scene is active, the work area are all in
 * the file, and a caller that wants them reads it. What is left over is which
 * folder projects are saved to, which project folder the app has open, where its
 * playhead sits, and which font families are actually registered in the
 * world drawing it — and the background jobs the app holds (mask tracks,
 * analyses), which no file records.
 * With no project open only the root and the jobs are left to report.
 */
export const context: ToolHandler<"context"> = async (_, ctx) => {
  const rootDir = saveFolder();
  const running = (job: { state: string }) => job.state === "queued" || job.state === "running";
  const rows = [...localJobRows(), ...analyzeJobRows()];
  const jobs = [...rows.filter(running), ...rows.filter((job) => !running(job))].slice(0, CONTEXT_JOB_LIMIT);

  const open = ctx.session();
  if (!open) return { rootDir, projectDir: null, currentTime: null, fontFamilies: [], jobs };

  const { world, project } = open;
  const frameRate = world.get(FrameRate)?.value || 30;
  const active = getActiveEntity(world);

  return {
    rootDir,
    projectDir: project.dir(),
    // Seconds, the unit the source places clips in; null when no scene is
    // active, which is when there is no playhead to report.
    currentTime: active ? (active.get(Computed)?.localTime ?? 0) / frameRate : null,
    // What text can be drawn with right now: registered in the world, not
    // merely named in the source. The editor default is always among them.
    fontFamilies: [...new Set(["Inter", ...(world.get(Fonts)?.list ?? []).map((f) => f.family)])],
    jobs,
  };
};
