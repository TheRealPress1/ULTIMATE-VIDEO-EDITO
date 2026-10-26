/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCommand } from "@/context/commands";
import { usePromptInput } from "@/context/prompt-input";
import { PROMPT_INPUT_MODE_OPTIONS } from "@/components/genai/config";
import { restoreConfig } from "@/components/genai/saved-config";

import type { PromptMode } from "@/components/genai/config";

const KEYWORDS: Record<PromptMode, string[]> = {
  IMAGE: ["picture", "photo", "text to image"],
  VIDEO: ["clip", "animate", "text to video"],
  VOICE: ["speech", "narration", "voiceover", "text to speech", "tts"],
  AUDIO: ["sound", "music", "sound effect", "sfx"],
};

/** Opens the prompt box in `mode`, as it was last left in that mode. */
export function GenerateCommand(props: { mode: PromptMode }) {
  const { openPromptInput } = usePromptInput();
  const option = PROMPT_INPUT_MODE_OPTIONS.find((entry) => entry.value === props.mode)!;

  useCommand({
    id: `generate:${props.mode}`,
    title: `Generate ${option.label.toLowerCase()}`,
    group: "Generate",
    icon: option.icon,
    keywords: ["ai", "prompt", "create", ...KEYWORDS[props.mode]],
    run: () => openPromptInput(restoreConfig(props.mode)),
  });

  return null;
}
