/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";
import { assetFolder, isUrlSource } from "@diffusionstudio/assets";
import { setSidebarTab } from "@/agent-chat";
import { useMediaSelection } from "@/components/genai/selection";
import { revealInAssets } from "@/components/sidebar-left/reveal";
import { useCommand } from "@/context/commands";
import { useLayout } from "@/context/layout";
import { useLibrary } from "@/engine/library";
import { revealPath } from "@/lib/shell";
import { isWindowsDesktop } from "@/projects";

import type { Asset } from "@diffusionstudio/assets";

/** The layer option for the library's root; no folder path starts with a slash. */
const ROOT = "/";

export function MediaAssetCommands() {
  const library = useLibrary();
  const layout = useLayout();
  const { media } = useMediaSelection();

  /** The assets the selected media shows, each once. */
  const shown = createMemo(() => [
    ...new Set(media().map((entry) => entry.asset).filter((asset) => asset !== undefined)),
  ]);

  /** Those of them in the library: what the panel lists and a folder holds. */
  const listed = createMemo(() => shown().filter((asset) => !asset.transient));

  /** The first of them that is a file here, rather than a download's URL. */
  const file = () => (window.desktop ? shown().find((asset) => !isUrlSource(asset.source)) : undefined);

  const folders = () => [...(library()?.folders() ?? [])].sort();

  const moveTo = (id: string) => {
    library()?.move(listed(), id === ROOT ? "" : id);
  };

  const showInAssets = () => {
    const assets = listed();
    if (!assets.length) return;
    const folder = assetFolder(assets[0]!);
    // Only what is in the folder that opens: the panel selects what it shows.
    const ids = assets.filter((asset) => assetFolder(asset) === folder).map((asset) => asset.id);

    if (!layout.uiVisible()) layout.toggleUI();
    setSidebarTab("assets");
    revealInAssets({ folder, ids });
  };

  const showInFinder = async (asset: Asset) => {
    try {
      await revealPath(library()?.fs.absolute?.(asset.source) ?? asset.source);
    } catch (e) {
      toast.error("Failed to show the file", { description: (e as Error).message });
    }
  };

  useCommand({
    id: "set-folder",
    title: "Set folder",
    group: "Assets",
    icon: "navigation.folder",
    keywords: ["move", "folder", "asset", "organize"],
    available: () => listed().length > 0 && folders().length > 0,
    layer: {
      placeholder: "Search for folder",
      sections: () => [{
        name: "Folders",
        options: [{ id: ROOT, title: "All assets" }, ...folders().map((folder) => ({ id: folder, title: folder }))],
      }],
      current: () => {
        const asset = listed()[0];
        return asset ? assetFolder(asset) || ROOT : undefined;
      },
      pick: moveTo,
    },
  });

  useCommand({
    id: "reveal-in-assets",
    title: "Reveal in assets",
    group: "Assets",
    icon: "assets",
    keywords: ["show", "find", "library", "asset"],
    shortcut: ["⇧", "⌘", "O"],
    available: () => listed().length > 0,
    run: showInAssets,
  });

  useCommand({
    id: "reveal-in-finder",
    title: isWindowsDesktop() ? "Reveal in Explorer" : "Reveal in Finder",
    group: "Assets",
    icon: "external-link",
    keywords: ["show", "file", "finder", "explorer", "folder"],
    shortcut: ["⌥", "⌘", "O"],
    available: () => file() !== undefined,
    run: () => {
      const asset = file();
      if (asset) void showInFinder(asset);
    },
  });

  // ⇧⌘O and ⌥⌘O, ahead of the editor, which would otherwise record the key
  // as held. By code: ⌥ turns the O into another character on a Mac.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.code !== "KeyO") return;

    if (event.shiftKey && !event.altKey && listed().length > 0) {
      event.preventDefault();
      event.stopPropagation();
      showInAssets();
      return;
    }

    const asset = file();
    if (event.altKey && !event.shiftKey && asset) {
      event.preventDefault();
      event.stopPropagation();
      showInFinder(asset);
    }
  };

  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return null;
}
