/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { computeOutputSize } from "@diffusionstudio/encoder";
import { Computed } from "@diffusionstudio/runtime";
import { useCommand } from "@/context/commands";
import { useExport } from "@/context/export";
import { useActiveScene } from "@/engine/hooks";
import { store } from "@/init";

import type { LayerSection } from "@/context/commands";

/** The size picked last, highlighted when the sizes come up; kept across sessions. */
const LAST_PRESET_KEY = "commands.export-current-frame.preset";

/** The sizes an image is offered at, named as the video presets name them; each is the shorter side. */
const PRESETS = [
  { id: "1080p", name: "Full HD", resolution: 1080 },
  { id: "1440p", name: "2k Quad HD", resolution: 1440 },
  { id: "2160p", name: "4K Ultra HD", resolution: 2160 },
];

/** The frame at the active scene's playhead, exported as a PNG at the size picked from the palette's layer. */
export function ExportCurrentFrameCommand() {
  const { exportFrame } = useExport();
  const scene = useActiveScene();

  const sections = (): LayerSection[] => {
    const computed = scene()?.get(Computed);
    const width = computed?.width || 1920;
    const height = computed?.height || 1080;

    return [
      {
        name: "Size",
        options: PRESETS.map((entry) => {
          const output = computeOutputSize(width, height, entry.resolution);
          return { id: entry.id, title: entry.name, detail: `${output.width}×${output.height}` };
        }),
      },
    ];
  };

  const pick = (id: string) => {
    const active = scene();
    const preset = PRESETS.find((entry) => entry.id === id);
    if (!active || !preset) return;
    store.set(LAST_PRESET_KEY, id);
    exportFrame(active, preset.resolution);
  };

  useCommand({
    id: "export-current-frame",
    title: "Export current frame",
    group: "Export",
    icon: "image",
    keywords: ["image", "still", "png", "screenshot", "1080p", "1440p", "4k"],
    shortcut: ["⇧", "⌘", "E"],
    available: () => scene() !== null,
    layer: {
      placeholder: "Search for image size",
      sections,
      current: () => store.get<string>(LAST_PRESET_KEY) ?? PRESETS[0]!.id,
      pick,
    },
  });

  return null;
}
