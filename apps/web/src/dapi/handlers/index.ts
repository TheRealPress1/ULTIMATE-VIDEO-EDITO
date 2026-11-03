/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { open } from "./open";
import { context } from "./context";
import { capture } from "./capture";
import { check } from "./check";
import { qualityReview } from "./quality-review";
import { exportScene } from "./export";
import { fonts } from "./fonts";
import { screenshot } from "./screenshot";
import { probe } from "./probe";
import { grab } from "./grab";
import { transcribe } from "./transcribe";
import { footageIndex, footageSearch, footageCut } from "./footage";
import { visualIndex, visualSearch, visualStatus } from './visual';
import { transcriptEditInspect,transcriptEditApply } from './transcript-edit';
import { referenceAnalyze, referenceApply } from "./reference-style";
import { reframe } from "./reframe";
import { captions } from "./captions";
import { audioFinish } from "./audio-finish";
import { filmstrip } from "./filmstrip";
import { waveform } from "./waveform";
import { listen } from "./listen";
import { soundEffects } from "./sound";
import { generate, job } from "./generate";
import { webMediaDownload } from "./web-media";
import { mediaDownload } from "./media";

import type { Handlers } from "../handler";

/** Every tool the renderer answers, keyed by its catalog name. */
export const handlers: Handlers = {
  open,
  context,
  capture,
  check,
  quality_review: qualityReview,
  export: exportScene,
  fonts,
  screenshot,
  probe,
  grab,
  transcribe,
  footage_index: footageIndex,
  footage_search: footageSearch,
  footage_cut: footageCut,
  visual_index: visualIndex,
  visual_search: visualSearch,
  visual_status: visualStatus,
  transcript_edit_inspect: transcriptEditInspect,
  transcript_edit_apply: transcriptEditApply,
  reference_analyze: referenceAnalyze,
  reference_apply: referenceApply,
  reframe,
  captions,
  audio_finish: audioFinish,
  filmstrip,
  waveform,
  listen,
  sound_effects: soundEffects,
  generate,
  job,
  web_media_download: webMediaDownload,
  media_download: mediaDownload,
};
