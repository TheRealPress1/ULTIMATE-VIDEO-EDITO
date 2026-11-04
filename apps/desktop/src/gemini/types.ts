/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the optional Gemini connection shares between main and the renderer:
// the status Settings shows, and the two things it can change. Types only: the
// web app imports this file. The key itself goes one way, from the Settings
// field into main, and never comes back.

export type GeminiStatus = {
  /** A key is saved and main can read it back. */
  configured: boolean;
  /** Whether this Mac can encrypt a key at rest. When it can't, no key is saved: there is no plain-text fallback. */
  encryption: boolean;
  /** The last four characters of the saved key, so it can be told apart from another. */
  hint?: string;
  /** The model questions go to. */
  model: string;
  /** The model Cutroom uses until another is chosen. */
  defaultModel: string;
  /** One line: why the saved key can't be used (unreadable, or this Mac can't decrypt it). */
  error?: string;
};

/** What Settings can change: a new key, a model, or both. An empty model goes back to the default. */
export type GeminiSettingsUpdate = { key?: string; model?: string };
