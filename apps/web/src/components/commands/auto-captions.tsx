/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCommand } from "@/context/commands";
import { useAutoCaptions } from "@/components/genai/use-auto-captions";

export function AutoCaptionsCommand() {
  const { scene, generate } = useAutoCaptions();

  useCommand({
    id: "auto-captions",
    title: "Generate captions",
    group: "Media",
    icon: "captions",
    keywords: ["auto-captions", "subtitles", "transcribe"],
    available: () => !!scene(),
    run: generate,
  });

  return null;
}
