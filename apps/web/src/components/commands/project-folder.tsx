/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, createResource } from "solid-js";
import { toast } from "somoto";
import { useCommand } from "@/context/commands";
import { useProject } from "@/context/project";
import { listEditors, openInEditor, revealPath } from "@/lib/shell";
import { isWindowsDesktop } from "@/projects";

import type { EditorId, EditorInfo } from "@/lib/shell";

/** Each editor's logo. */
const EDITOR_ICONS: Record<EditorId, string> = {
  vscode: "editor.vscode",
  cursor: "agent.cursor",
  zed: "editor.zed",
};

/**
 * The project folder's commands, as the File menu has them: showing it in
 * Finder (Explorer on Windows), and opening it in each code editor installed
 * here. Desktop only; off it there is no folder to show.
 */
export function ProjectFolderCommands() {
  const project = useProject();
  const [editors] = createResource(listEditors, { initialValue: [] });

  const handleReveal = async () => {
    try {
      await revealPath(project.dir());
    } catch (e) {
      toast.error("Failed to show the folder", { description: (e as Error).message });
    }
  };

  useCommand({
    id: "show-project-folder",
    title: isWindowsDesktop() ? "Show in Explorer" : "Show in Finder",
    group: "File",
    icon: "navigation.folder",
    keywords: ["reveal", "project folder", "files", "finder", "explorer"],
    available: () => Boolean(window.desktop && project.dir()),
    run: () => void handleReveal(),
  });

  return <For each={editors()}>{(editor) => <OpenInEditorCommand editor={editor} />}</For>;
}

function OpenInEditorCommand(props: { editor: EditorInfo }) {
  const project = useProject();
  const { editor } = props;

  const handleOpen = async () => {
    try {
      await openInEditor(editor.id, project.dir());
    } catch (e) {
      toast.error(`Failed to open in ${editor.label}`, { description: (e as Error).message });
    }
  };

  useCommand({
    id: `open-in-editor:${editor.id}`,
    title: `Open in ${editor.label}`,
    group: "File",
    icon: EDITOR_ICONS[editor.id],
    keywords: ["code editor", "project folder", "jsx", "source", editor.id],
    available: () => Boolean(project.dir()),
    run: () => void handleOpen(),
  });

  return null;
}
