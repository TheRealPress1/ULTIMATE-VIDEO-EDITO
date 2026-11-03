/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EarshotStatus } from "@desktop/addons/earshot/types";

/** Sizes as macOS counts them (10^6 bytes to the MB), like the Finder. */
function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6).toLocaleString("en-US")} MB`;
}

/** Whether Settings offers Install now: not on a Mac that can't run it, where installing again changes nothing. */
export function canInstallAudioIntelligence(status: EarshotStatus): boolean {
  return status.state === "not-installed" || (status.state === "failed" && !status.unsupported);
}

/** Whether Settings offers Remove: whenever the add-on holds something on disk, a stopped or outdated install included. */
export function canRemoveAudioIntelligence(status: EarshotStatus): boolean {
  if (status.state === "ready" || status.state === "installing") return true;
  if (status.state === "failed") return !status.unsupported || !!status.sizeBytes;
  return status.state === "not-installed" && !!status.sizeBytes;
}

/** The one-line status Settings shows for the add-on. */
export function audioIntelligenceLine(status: EarshotStatus): string {
  switch (status.state) {
    case "not-installed":
      if (status.sizeBytes) {
        return `Partly installed (${size(status.sizeBytes)} on disk). It finishes by itself the next time an agent listens to a sound or renders a sound effect, or with Install now; Remove frees the space.`;
      }
      return "Not installed. It installs by itself (about 2.4 GB) the first time an agent listens to a sound or renders a sound effect.";
    case "installing": {
      const step = status.step ? ` — step ${status.step.index}/${status.step.count}: ${status.step.label}` : "";
      const progress = status.progress ? ` (${size(status.progress.bytes)} of ${size(status.progress.totalBytes)})` : "";
      return `Installing${step}${progress}…`;
    }
    case "ready": {
      // The cached analysis only once it is worth a mention, with the limit it is kept under.
      const cached = status.sizeBytes && status.cacheBytes && status.cacheBytes >= 1e6
        ? ` (${size(status.cacheBytes)} of it cached analysis${status.cacheLimitBytes ? `, kept under ${size(status.cacheLimitBytes)}` : ""})`
        : "";
      return `Ready${status.versions ? ` — earshot ${status.versions.earshot}` : ""}${status.sizeBytes ? `, ${size(status.sizeBytes)} on disk${cached}` : ""}. Runs on this Mac; nothing is uploaded.`;
    }
    case "failed": {
      const reason = (status.error ?? "unknown error").replace(/\.?$/, ".");
      const held = status.sizeBytes ? ` Remove frees the ${size(status.sizeBytes)} it left on disk.` : "";
      if (status.unsupported) return `Unavailable on this Mac. ${reason}${held}`;
      return `The install stopped${status.step ? ` at step ${status.step.index}/${status.step.count}` : ""}: ${reason} It resumes on the next sound tool call, or with Install now.${held}`;
    }
    case "removing":
      return "Removing…";
  }
}
