/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCommand } from "@/context/commands";
import { usePromptInput } from "@/context/prompt-input";
import { useMediaSelection } from "@/components/genai/selection";
import { restoreConfig } from "@/components/genai/saved-config";

/** Opens the prompt box on the selected images. */
export function EditWithPromptCommand() {
  const { openPromptInput } = usePromptInput();
  const { imageMedia } = useMediaSelection();

  useCommand({
    id: "edit-with-prompt",
    title: "Edit with prompt",
    group: "Generate",
    icon: "ai.edit-with-prompt",
    keywords: ["image", "prompt", "ai"],
    available: () => imageMedia().length > 0,
    run: () => openPromptInput(restoreConfig("IMAGE")),
  });

  return null;
}
