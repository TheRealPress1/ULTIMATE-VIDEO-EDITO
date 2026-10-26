/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo } from "solid-js";
import { computeOutputSize } from "@diffusionstudio/encoder";
import { Computed } from "@diffusionstudio/runtime";
import { useCommand } from "@/context/commands";
import { useExport } from "@/context/export";
import { useActiveScene } from "@/engine/hooks";
import { useProjectConfig } from "@/engine/project-config";
import { store } from "@/init";
import {
  DEFAULT_EXPORT_TEMPLATE_ID,
  EXPORT_TEMPLATE_GROUPS,
  TEMPLATE_BY_ID,
} from "@/components/sidebar-right/inspector/export-templates";

import type { ExportConfig } from "@/components/sidebar-right/inspector/export-templates";
import type { LayerSection } from "@/context/commands";

/** The preset picked last, highlighted when the presets come up; kept across sessions. */
const LAST_PRESET_KEY = "commands.export-video.preset";

/** The scene's own settings, from the inspector's Export panel, as a pick. */
const SCENE_SETTINGS = "scene";

/** "1080p", "4K", with the container when it is not MP4: what a preset comes out as. */
function describe(config: ExportConfig): string {
  if (config.format === "ogg" || config.video?.enabled === false) return "Audio only";
  const resolution = config.video?.resolution ?? 1080;
  const size = resolution === 2160 ? "4K" : `${resolution}p`;
  return config.format && config.format !== "mp4" ? `${size} · ${config.format.toUpperCase()}` : size;
}

/** The active scene, exported as a video with the preset picked from the palette's layer. */
export function ExportVideoCommand() {
  const { exportScene } = useExport();
  const scene = useActiveScene();
  const config = useProjectConfig();
  const sceneSettings = createMemo(() => {
    const active = scene();
    return active ? config()?.exportOf(active) ?? null : null;
  });

  // Read as the layer comes up: the scene is not resized while it is.
  const sections = (): LayerSection[] => {
    const computed = scene()?.get(Computed);
    const width = computed?.width || 1920;
    const height = computed?.height || 1080;

    // The pixel size a preset makes of this scene; none for audio.
    const pixels = (config: ExportConfig) => {
      if (config.format === "ogg" || config.video?.enabled === false) {
        return undefined;
      }

      const output = computeOutputSize(width, height, config.video?.resolution ?? 1080);
      return `${output.width}×${output.height}`;
    };

    const own = sceneSettings();
    return [
      ...(own ? [{
        name: "Scene settings",
        options: [{ id: SCENE_SETTINGS, title: describe(own), detail: pixels(own) }]
      }] : []),
      ...EXPORT_TEMPLATE_GROUPS.map((group) => ({
        name: group.label,
        options: group.items.map((template) => ({
          id: template.id,
          title: template.name,
          keywords: [describe(template)],
          detail: pixels(template),
        })),
      })),
    ];
  };

  // The scene's own settings when it has them, else the last preset used.
  const current = () => {
    if (sceneSettings()) return SCENE_SETTINGS;
    const last = store.get<string>(LAST_PRESET_KEY);
    return last && TEMPLATE_BY_ID.has(last) ? last : DEFAULT_EXPORT_TEMPLATE_ID;
  };

  const pick = (id: string) => {
    const active = scene();
    const settings = id === SCENE_SETTINGS ? sceneSettings() : TEMPLATE_BY_ID.get(id);
    if (!active || !settings) return;
    if (id !== SCENE_SETTINGS) store.set(LAST_PRESET_KEY, id);
    void exportScene(active, { format: settings.format, video: settings.video, audio: settings.audio });
  };

  useCommand({
    id: "export-video",
    title: "Export video",
    group: "Export",
    icon: "film-video-export",
    keywords: ["render", "mp4", "webm", "720p", "1080p", "1440p", "4k", "youtube", "tiktok", "instagram"],
    shortcut: ["⌘", "E"],
    available: () => scene() !== null,
    layer: { placeholder: "Search for export preset", sections, current, pick },
  });

  return null;
}
