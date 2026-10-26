/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toast } from "somoto";
import { api } from "@/lib/api";
import { useCommand } from "@/context/commands";
import { usePromptInput } from "@/context/prompt-input";
import { useMediaSelection } from "@/components/genai/selection";
import { toConfig } from "@/components/genai/requests";

/**
 * Opens the prompt box with the settings the first selected generated image
 * was made with. The job is fetched on pick rather than kept up with the
 * selection, which this command is mounted for the whole time.
 */
export function ReuseSettingsCommand() {
  const { openPromptInput } = usePromptInput();
  const { imageMedia } = useMediaSelection();

  const jobId = () => imageMedia().find((entry) => entry.asset?.job !== undefined)?.asset?.job;

  const reuse = async () => {
    const id = jobId();
    if (!id) return;

    try {
      const config = toConfig((await api.jobs.get.query({ id })).request);
      if (!config) {
        toast("No generation config found", { description: "This asset wasn't generated with a prompt." });
        return;
      }
      openPromptInput(config);
    } catch (error) {
      toast("Failed to load the generation", { description: error instanceof Error ? error.message : "Unknown error" });
    }
  };

  useCommand({
    id: "reuse-settings",
    title: "Reuse generation settings",
    group: "Generate",
    icon: "reuse-settings",
    keywords: ["prompt", "config"],
    available: () => jobId() !== undefined,
    run: () => void reuse(),
  });

  return null;
}
