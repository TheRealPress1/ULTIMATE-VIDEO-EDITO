/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { audioIntelligenceLine, canInstallAudioIntelligence, canRemoveAudioIntelligence } from "./audio-intelligence-data";

import type { EarshotStatus } from "@desktop/addons/earshot/types";

const MB = 1024 * 1024;
const root = "/Users/me/Library/Application Support/Cutroom/addons/earshot";

describe("audioIntelligenceLine", () => {
  it("says what the add-on is doing in one line", () => {
    expect(audioIntelligenceLine({ root, state: "not-installed" })).toMatch(/^Not installed\. It installs by itself \(about 2\.4 GB\)/);
    expect(audioIntelligenceLine({ root, state: "installing", step: { index: 3, count: 5, id: "packages", label: "Installing earshot and PyTorch" }, progress: { bytes: 410 * MB, totalBytes: 2077 * MB } }))
      .toBe("Installing — step 3/5: Installing earshot and PyTorch (430 MB of 2.2 GB)…");
    expect(audioIntelligenceLine({ root, state: "ready", sizeBytes: 2155 * MB, versions: { earshot: "0.4.0", commit: "591fa3e", uv: "0.13.7", python: "3.12.16", torch: "2.11.0", ffmpeg: "9.0.2" } }))
      .toBe("Ready — earshot 0.4.0, 2.3 GB on disk. Runs on this Mac; nothing is uploaded.");
    expect(audioIntelligenceLine({ root, state: "failed", step: { index: 5, count: 5, id: "models", label: "Downloading the sound models" }, error: "The sound model download stopped making progress. Check the network and try again." }))
      .toBe("The install stopped at step 5/5: The sound model download stopped making progress. Check the network and try again. It resumes on the next sound tool call, or with Install now.");
    expect(audioIntelligenceLine({ root, state: "failed", error: "uv reported version nothing, not 0.13.7" })).toBe("The install stopped: uv reported version nothing, not 0.13.7. It resumes on the next sound tool call, or with Install now.");
    expect(audioIntelligenceLine({ root, state: "removing" })).toBe("Removing…");
  });

  it("counts earshot's cached analysis in the size once there is some, with the limit it is kept under", () => {
    const versions = { earshot: "0.4.0", commit: "591fa3e", uv: "0.13.7", python: "3.12.16", torch: "2.11.0", ffmpeg: "9.0.2" };
    expect(audioIntelligenceLine({ root, state: "ready", versions, sizeBytes: 2_380_000_000, cacheBytes: 120_000_000, cacheLimitBytes: 500_000_000 }))
      .toBe("Ready — earshot 0.4.0, 2.4 GB on disk (120 MB of it cached analysis, kept under 500 MB). Runs on this Mac; nothing is uploaded.");
    // A few kilobytes of embeddings aren't worth a mention.
    expect(audioIntelligenceLine({ root, state: "ready", versions, sizeBytes: 2_260_004_096, cacheBytes: 4096, cacheLimitBytes: 500_000_000 }))
      .toBe("Ready — earshot 0.4.0, 2.3 GB on disk. Runs on this Mac; nothing is uploaded.");
  });

  it("shows what a stopped or outdated install left, and an install that failed partway", () => {
    expect(audioIntelligenceLine({ root, state: "not-installed", partial: true, sizeBytes: 1024 * MB }))
      .toBe("Partly installed (1.1 GB on disk). It finishes by itself the next time an agent listens to a sound or renders a sound effect, or with Install now; Remove frees the space.");
    expect(audioIntelligenceLine({ root, state: "failed", step: { index: 3, count: 5, id: "packages", label: "Installing earshot and PyTorch" }, error: "Installing earshot failed: dns error", sizeBytes: 98 * MB }))
      .toBe("The install stopped at step 3/5: Installing earshot failed: dns error. It resumes on the next sound tool call, or with Install now. Remove frees the 103 MB it left on disk.");
  });

  it("says plainly when this Mac can't run it, without offering an install that can't work", () => {
    const intel: EarshotStatus = { root, state: "failed", unsupported: true, error: "Audio intelligence needs a Mac with Apple silicon: PyTorch, which earshot's sound models run on, has no current build for Intel Macs." };
    expect(audioIntelligenceLine(intel)).toBe("Unavailable on this Mac. Audio intelligence needs a Mac with Apple silicon: PyTorch, which earshot's sound models run on, has no current build for Intel Macs.");
    expect(canInstallAudioIntelligence(intel)).toBe(false);
    expect(canRemoveAudioIntelligence(intel)).toBe(false);
    expect(canRemoveAudioIntelligence({ ...intel, sizeBytes: 4096 })).toBe(true);
  });
});

describe("Settings' buttons", () => {
  it("offers Remove whenever something is on disk, and Install now while it isn't ready", () => {
    const at = (status: Partial<EarshotStatus>) => ({ root, state: "not-installed", ...status }) as EarshotStatus;
    expect([canInstallAudioIntelligence(at({})), canRemoveAudioIntelligence(at({}))]).toEqual([true, false]);
    expect([canInstallAudioIntelligence(at({ partial: true, sizeBytes: 900 * MB })), canRemoveAudioIntelligence(at({ partial: true, sizeBytes: 900 * MB }))]).toEqual([true, true]);
    expect([canInstallAudioIntelligence(at({ state: "failed", error: "x" })), canRemoveAudioIntelligence(at({ state: "failed", error: "x" }))]).toEqual([true, true]);
    expect([canInstallAudioIntelligence(at({ state: "installing" })), canRemoveAudioIntelligence(at({ state: "installing" }))]).toEqual([false, true]);
    expect([canInstallAudioIntelligence(at({ state: "ready" })), canRemoveAudioIntelligence(at({ state: "ready" }))]).toEqual([false, true]);
    expect([canInstallAudioIntelligence(at({ state: "removing" })), canRemoveAudioIntelligence(at({ state: "removing" }))]).toEqual([false, false]);
  });
});
