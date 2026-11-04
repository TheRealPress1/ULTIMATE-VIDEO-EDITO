/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The optional Gemini connection: the user's own Google AI Studio key, kept
// encrypted in this profile's userData, and `ask_gemini`, which uses it to put
// a video or audio file (or a YouTube link) in front of Gemini. Nothing here
// runs, and nothing leaves the Mac, until the user has saved a key.

import { join } from "node:path";
import { DapiError } from "@diffusionstudio/dapi";
import { resolveSoundPath } from "../addons/earshot/paths";
import { mediaTools } from "../media-download";
import { ffmpegCutAudio } from "./audio";
import { GeminiFiles } from "./files";
import { GeminiInteractions } from "./interactions";
import { GeminiMedia } from "./media";
import { GeminiSettingsError, GeminiStore, type GeminiSecureStorage } from "./store";

import type { ToolArgs, ToolResult } from "@diffusionstudio/dapi";
import type { GeminiSettingsUpdate, GeminiStatus } from "./types";

/**
 * The model asked until Settings names another: Google's current stable Flash
 * model, the one its own video guide uses. A fixed id rather than a
 * `-latest` alias, which Google can repoint to a preview.
 */
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

export type GeminiServiceOptions = {
  /** The profile's userData folder; the key lives in `services/` inside it. */
  userData: string;
  secureStorage: GeminiSecureStorage;
  /** The bundled FFmpeg and ffprobe, or null where this build has none. */
  ffmpeg: string | null;
  ffprobe: string | null;
};

export class GeminiService {
  private readonly store: GeminiStore;
  private readonly media: GeminiMedia;
  /** The app's own stores, which `ask_gemini` never reads for an agent: chat transcripts, Instagram tokens, the key itself. */
  readonly privateDirs: readonly string[];

  constructor(options: GeminiServiceOptions) {
    this.store = new GeminiStore({ directory: join(options.userData, "services"), secureStorage: options.secureStorage, defaultModel: GEMINI_DEFAULT_MODEL });
    this.privateDirs = [join(options.userData, "agent-chat"), join(options.userData, "instagram"), join(options.userData, "services")];
    const key = () => this.store.secret();
    this.media = new GeminiMedia({
      secret: key,
      model: () => this.store.currentModel(),
      files: new GeminiFiles({ key }),
      interactions: new GeminiInteractions({ key }),
      resolve: (value, project) => resolveSoundPath(value, { project, what: "path", privateDirs: this.privateDirs }),
      probe: mediaTools({ ffprobe: options.ffprobe, ffmpeg: options.ffmpeg }).probe,
      cutAudio: ffmpegCutAudio(options.ffmpeg),
    });
  }

  /** `ask_gemini`. */
  ask(args: ToolArgs<"ask_gemini">, context: { project: string | null; signal: AbortSignal }): Promise<ToolResult<"ask_gemini">> {
    return this.media.run(args, context);
  }

  /** What Settings shows. Never the key. */
  status(): Promise<GeminiStatus> {
    return this.store.status();
  }

  /** Saves a key and/or a model from Settings. */
  async update(change: GeminiSettingsUpdate): Promise<GeminiStatus> {
    const given: GeminiSettingsUpdate = {};
    if (change && typeof change === "object") {
      if (typeof change.key === "string") given.key = change.key;
      if (typeof change.model === "string") given.model = change.model;
    }
    if (given.key === undefined && given.model === undefined) throw new GeminiSettingsError("Nothing to save.");
    return this.store.update(given);
  }

  /** Removes the key and stops anything still being asked with it. */
  async clear(): Promise<GeminiStatus> {
    this.media.cancelAll();
    return this.store.clear();
  }

  /** The app is closing: stop what is being asked, so no uploaded copy is left behind. */
  dispose(): void {
    this.media.cancelAll();
  }
}

let singleton: GeminiService | undefined;

/** Sets up the app's connection with what only main.ts has; call once, after the profile's userData is set. */
export function configureGemini(options: GeminiServiceOptions): GeminiService {
  singleton?.dispose();
  singleton = new GeminiService(options);
  return singleton;
}

/** The app's connection. */
export function gemini(): GeminiService {
  if (!singleton) throw new DapiError("unsupported", "Gemini isn't set up in this build.");
  return singleton;
}
