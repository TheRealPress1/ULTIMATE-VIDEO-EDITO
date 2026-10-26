/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const REFRAME_MAX_SECONDS = 7200;
export const REFRAME_CHUNK_SECONDS = 120;
export const REFRAME_NATIVE_MAX_SECONDS = 600;
export const REFRAME_MAX_SAMPLES = 28800;
export const REFRAME_NATIVE_MAX_SAMPLES = 1200;
export const REFRAME_DEFAULT_INTERVAL = 0.5;

/** Coordinates use the displayed, orientation-corrected source, top left = (0, 0). */
export interface ReframeFace {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface ReframeFaceSample {
  /** Source seconds, before timeline trim/speed mapping. */
  time: number;
  faces: ReframeFace[];
  /** A sampled visual discontinuity; a conservative hint, not exact shot detection. */
  cut: boolean;
}

export interface ReframeAnalysisRequest {
  id: string;
  path: string;
  start: number;
  end: number;
  sampleInterval?: number;
  /** First source video PTS; times in this API remain relative to actual content. */
  sourceStart?: number;
}

export interface ReframeAnalysisResult {
  duration: number;
  width: number;
  height: number;
  sampleInterval: number;
  samples: ReframeFaceSample[];
}

export interface ReframeAnalysisProgress {
  id: string;
  completed: number;
  total: number;
}
