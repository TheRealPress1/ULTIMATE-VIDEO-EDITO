/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the audio intelligence add-on (earshot) shares between main and the
// renderer: its status for Settings, and the `sound_effects` requests the
// renderer tool hands to main. Types only: the web app imports this file.

export type EarshotState = "not-installed" | "installing" | "ready" | "failed" | "removing";

export type EarshotStepId = "uv" | "python" | "packages" | "ffmpeg" | "models";

/** The installed versions, as the install measured them. */
export type EarshotVersions = {
  earshot: string;
  commit: string;
  uv: string;
  python: string;
  torch: string;
  ffmpeg: string;
  /** Every Python package in the environment (`uv pip freeze`), by name. */
  packages?: Record<string, string>;
};

export type EarshotStatus = {
  state: EarshotState;
  /** The step running (installing) or that failed. */
  step?: { index: number; count: number; id: EarshotStepId; label: string };
  /** Bytes fetched so far against what the whole install downloads, both estimates while installing. */
  progress?: { bytes: number; totalBytes: number };
  /** What the add-on takes on disk: when ready, the install as measured after it plus earshot's caches now; what the folder holds now otherwise. */
  sizeBytes?: number;
  /** When ready: what earshot's caches (decoded audio, embeddings, results) hold now, part of `sizeBytes`. */
  cacheBytes?: number;
  /** The size Cutroom keeps those caches under, removing the least recently used entries. */
  cacheLimitBytes?: number;
  /** Not installed, but a stopped or outdated install left files behind (`sizeBytes`), which Remove frees. */
  partial?: boolean;
  /** This Mac can't run the add-on at all (`error` says why); installing again won't change that. */
  unsupported?: boolean;
  versions?: EarshotVersions;
  /** One line: why the last install failed. */
  error?: string;
  /** When the install finished. */
  installedAt?: string;
  /** Where it lives. */
  root: string;
};

/** A `sound_effects` call the renderer hands to main. `id` names it for cancelling. */
export type SoundEffectsRequest =
  | { id: string; action: "list"; category?: string; kind?: string }
  | { id: string; action: "check"; dir: string | null; path: string; category?: string; role?: string }
  | {
      id: string;
      action: "render";
      /** The open project: the take lands in its `assets/sfx/`. */
      dir: string;
      sound: string;
      dur?: number;
      apex?: number;
      pitch?: string;
      seed?: number;
      name?: string;
    };

/**
 * `analyze`'s sound events: earshot's `timeline` over one file (or a window
 * of it), asked only once the add-on is ready, so it never waits on an
 * install. `path` is a library source (project-relative), or an absolute path.
 */
export type EarshotEventsRequest = { id: string; dir: string | null; path: string; start?: number; end?: number };

/** earshot's answer for it: its plain-language summary and its (compact) JSON. */
export type EarshotEventsReply = { version: string; summary: string; result: Record<string, unknown> };

/** The model-free audit earshot runs on every take (and on any file with `check`). */
export type SoundAudit = {
  ok: boolean;
  summary: string;
  warnings: Array<{ code: string; msg: string }>;
  notes: Array<{ code: string; msg: string }>;
};

export type SoundBankEntry = {
  id: string;
  category: string;
  member?: string;
  type?: string;
  durationSeconds?: number;
  onsetSeconds?: number;
  peakSeconds?: number;
  endSeconds?: number;
  kinds: string[];
  /** earshot's knobs in its own words: `dur shape`, `apex`, `pitch F#7 -27c (1455-11519 Hz)`. */
  knobs: string[];
  /** What the sound is for, when it says more than its category's `use`. */
  notes?: string;
};

export type SoundBankCategory = { category: string; count: number; kinds: string[]; use?: string; ids: string[] };

export type SoundEffectsReply =
  | { action: "list"; version: string; summary: string; bank: string; categories: SoundBankCategory[]; sounds?: SoundBankEntry[] }
  | { action: "check"; version: string; summary: string; path: string; audit: SoundAudit }
  | {
      action: "render";
      version: string;
      summary: string;
      /** Project-relative, `/`-separated: `assets/sfx/<name>.wav`, the library's `source`. */
      source: string;
      /** Absolute path of the take. */
      path: string;
      sound: string;
      seed: number;
      durationSeconds: number;
      onsetSeconds: number;
      peakSeconds: number;
      endSeconds: number;
      peakDb?: number;
      edits?: Record<string, unknown>;
      audit?: SoundAudit;
      /** The same take was already in the project, and that file is the one returned. */
      reused: boolean;
      creditsFile?: string;
    };
