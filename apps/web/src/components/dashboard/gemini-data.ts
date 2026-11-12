/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { GeminiStatus } from "@desktop/gemini/types";

/** Where a free Google AI Studio key comes from. */
export const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";

/** What Settings says before anything else: what the connection is for. */
export const GEMINI_PURPOSE =
  "Lets agents ask Google's Gemini about a video, a sound or a YouTube link: what happens in the picture, how a voice sounds, what music plays. Off until you add your own key.";

/**
 * What the user agrees to by adding a key. It is the one place Cutroom sends
 * footage off the Mac, so it says so plainly: what is sent, that it is deleted,
 * and the difference between Google's free and paid keys.
 */
export const GEMINI_DISCLOSURE =
  "When an agent asks, the file in question is uploaded to Google under your key (only its sound, when the question is about sound) and deleted again afterwards; a YouTube link sends just the link. Blackout asks Google not to store the question or the answer. On Google's free tier, though, what you send is used to improve its products; with a paid key (a Google project with billing turned on) it isn't. For private footage, use a paid key.";

/** The one-line status Settings shows. */
export function geminiLine(status: GeminiStatus): string {
  if (status.error) return status.error;
  if (!status.encryption) return "This Mac can't store a key encrypted, so Blackout won't save one. Nothing is sent to Google.";
  if (!status.configured) return "No key saved. Nothing is sent to Google.";
  return `Ready${status.hint ? `, key ending ${status.hint}` : ""}. Questions go to ${status.model}.`;
}

/** Whether Save key is offered for what has been typed: something long enough to be a key; main checks the rest. */
export function canSaveGeminiKey(typed: string, status: GeminiStatus | undefined): boolean {
  return !!status?.encryption && typed.trim().length >= 20;
}

/** Whether Save is offered for the model field: a different name than the one in use (empty goes back to the default). */
export function canSaveGeminiModel(typed: string, status: GeminiStatus | undefined): boolean {
  if (!status) return false;
  const wanted = typed.trim() === "" ? status.defaultModel : typed.trim().replace(/^models\//i, "");
  return wanted !== status.model;
}
