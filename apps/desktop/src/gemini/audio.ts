/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The sound of a file, cut to a window, in the one form Google reads without
// question: 16 kHz mono 16-bit WAV. Gemini folds sound down to a single channel
// at about that rate anyway, so nothing it could use is lost, and a cut done
// here is exact to the sample, which is what lets an answer's times be moved
// onto the source's own clock afterwards.

import { DapiError } from "@diffusionstudio/dapi";
import { runAudioTool } from "../audio-tools";

import type { GeminiMediaDeps } from "./media";

/** How long a cut may take: a two-hour window decodes in a minute or two. */
const CUT_TIMEOUT_MS = 15 * 60_000;

/** ffmpeg's arguments for the first sound of `input`, from `start` for `duration` seconds (to the end when null), written to `output`. */
export function cutAudioArgs(input: string, output: string, window: { start: number; duration: number | null }): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error",
    // Before the input and with decoding, so the cut is exact rather than the nearest packet.
    ...(window.start > 0 ? ["-ss", window.start.toFixed(3)] : []),
    ...(window.duration !== null ? ["-t", window.duration.toFixed(3)] : []),
    "-i", input,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-y", output,
  ];
}

/** The cut as the service takes it, run with the bundled FFmpeg; without one, a clear refusal. */
export function ffmpegCutAudio(ffmpeg: string | null): GeminiMediaDeps["cutAudio"] {
  if (!ffmpeg) {
    return async () => {
      throw new DapiError("unsupported", "This build has no audio tools, so a sound can't be cut out of a file. Ask about the video instead (send=video).");
    };
  }
  return async (input, output, window, signal) => {
    await runAudioTool(ffmpeg, cutAudioArgs(input, output, window), { signal, timeoutMs: CUT_TIMEOUT_MS });
  };
}
