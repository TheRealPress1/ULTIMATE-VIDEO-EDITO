/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCommand } from "@/context/commands";
import { usePromptInput } from "@/context/prompt-input";
import { useMediaSelection } from "@/components/genai/selection";
import { restoreConfig } from "@/components/genai/saved-config";

/** Opens the prompt box for a video, from the selected generated images. */
export function MakeVideoCommand() {
  const { openPromptInput } = usePromptInput();
  const { imageMedia } = useMediaSelection();

  useCommand({
    id: "make-video",
    title: "Make video",
    group: "Generate",
    icon: "film-video-export",
    keywords: ["animate", "image to video"],
    available: () => imageMedia().some((entry) => entry.asset?.job !== undefined),
    run: () => openPromptInput(restoreConfig("VIDEO")),
  });

  return null;
}
