/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { onCleanup, onMount } from "solid-js";
import { setActiveChat, setSidebarTab, sidebarTab } from "@/agent-chat/store";
import { useCommand, useCommands } from "@/context/commands";
import { useLayout } from "@/context/layout";
import { useProject } from "@/context/project";

/** Showing and hiding the panels around the canvas, the chat, and the palette itself. */
export function WindowCommands() {
  const layout = useLayout();
  const project = useProject();
  const { setPaletteOpen } = useCommands();

  useCommand({
    id: "toggle-ui",
    title: "Show/Hide UI",
    group: "View",
    icon: "sidebar",
    keywords: ["panels", "sidebar", "focus", "fullscreen", "toggle ui"],
    shortcut: ["⌘", "\\"],
    run: layout.toggleUI,
  });

  const timelineShown = () => layout.uiVisible() && !layout.timelineMinimized();

  // With the UI hidden the timeline is too, so showing it brings the UI back.
  const toggleTimeline = () => {
    if (timelineShown()) {
      layout.toggleTimeline();
      return;
    }

    if (!layout.uiVisible()) layout.toggleUI();
    if (layout.timelineMinimized()) layout.toggleTimeline();
  };

  useCommand({
    id: "toggle-timeline",
    title: "Show/Hide timeline",
    group: "View",
    icon: "sidebar-timeline",
    keywords: ["panel", "tracks", "layers", "minimize", "toggle timeline"],
    shortcut: ["⌘", "J"],
    run: toggleTimeline,
  });

  const chatShown = () => layout.uiVisible() && sidebarTab() === "chat";

  const showChat = () => {
    if (!layout.uiVisible()) layout.toggleUI();
    setSidebarTab("chat");
    // A composer that mounts with the tab focuses itself; one that was up
    // already is focused here, once the menu that ran this has let go.
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-chat-composer]")?.focus());
  };

  const toggleChat = () => {
    if (chatShown()) setSidebarTab("assets");
    else showChat();
  };

  // What the chat header's plus does, from wherever the chat is.
  const newChat = () => {
    setActiveChat(project.id(), null);
    showChat();
  };

  useCommand({
    id: "toggle-chat",
    title: "Show/Hide chat",
    group: "View",
    icon: "ask-chat",
    keywords: ["open chat", "agent", "assistant", "message", "claude"],
    shortcut: ["⌘", "L"],
    run: toggleChat,
  });

  useCommand({
    id: "new-chat",
    title: "New chat thread",
    group: "View",
    icon: "plus-add",
    keywords: ["new thread", "conversation", "agent", "assistant", "claude"],
    shortcut: ["⇧", "⌘", "L"],
    palette: false,
    run: newChat,
  });

  useCommand({
    id: "actions",
    title: "Actions…",
    group: "View",
    icon: "tool.actions-spotlight",
    shortcut: ["⌘", "K"],
    palette: false,
    run: () => setPaletteOpen(true),
  });

  // ⌘\, ⌘J, ⌘L and ⇧⌘L wherever focus is, a field included, as ⌘K is:
  // ahead of the editor, which would otherwise record the key as held.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

    if (event.shiftKey) {
      if (event.key.toLowerCase() !== "l" && event.code !== "KeyL") return;

      event.preventDefault();
      event.stopPropagation();
      newChat();
      return;
    }

    if (event.key === "\\" || event.code === "Backslash") {
      event.preventDefault();
      event.stopPropagation();
      layout.toggleUI();
      return;
    }

    if (event.key.toLowerCase() === "j" || event.code === "KeyJ") {
      event.preventDefault();
      event.stopPropagation();
      toggleTimeline();
      return;
    }

    if (event.key.toLowerCase() === "l" || event.code === "KeyL") {
      event.preventDefault();
      event.stopPropagation();
      toggleChat();
    }
  };

  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return null;
}
