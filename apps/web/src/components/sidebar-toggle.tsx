/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, onCleanup, onMount } from "solid-js";

import { useCommand } from "@/context/commands";
import { isSidebarShortcut, sidebarOpen, toggleSidebar } from "@/lib/sidebar-state";

/** The id of the sidebar the button controls. */
export const SIDEBAR_ID = "cutroom-sidebar";

const SHORTCUT = ["⌥", "⌘", "S"];

/** A left panel: its outline, with the part the sidebar takes up filled while it is shown. */
function SidebarPanelIcon(props: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="3.25" stroke="currentColor" stroke-width="1.5" />
      <path d="M9.5 5.5v13" stroke="currentColor" stroke-width="1.5" />
      <Show when={props.open}>
        <path d="M4.25 8.25A2.5 2.5 0 0 1 6.75 5.75H9.5v12.5H6.75a2.5 2.5 0 0 1-2.5-2.5Z" fill="currentColor" opacity=".4" />
      </Show>
    </svg>
  );
}

/**
 * Closes and opens the sidebar. One button that never leaves the page, so it
 * keeps focus and moves (see `.cutroom-sidebar-toggle`): beside the macOS
 * traffic lights, or at the sidebar's right edge, or, with the sidebar
 * closed, in the corner it leaves free.
 */
export function SidebarToggle() {
  const label = () => (sidebarOpen() ? "Hide sidebar" : "Show sidebar");

  return (
    <button
      type="button"
      class="cutroom-sidebar-toggle focus-ring"
      data-open={sidebarOpen()}
      aria-label={label()}
      aria-expanded={sidebarOpen()}
      aria-controls={SIDEBAR_ID}
      title={`${label()} (${SHORTCUT.join("")})`}
      onClick={toggleSidebar}
    >
      <SidebarPanelIcon open={sidebarOpen()} />
    </button>
  );
}

/**
 * The palette entry and the key for it. The key works wherever focus is, a
 * field included, as the other window shortcuts do: ahead of the editor.
 */
export function SidebarCommands() {
  useCommand({
    id: "toggle-sidebar",
    title: "Show/Hide sidebar",
    group: "View",
    icon: "sidebar-left",
    keywords: ["navigation", "chats", "projects", "left", "panel", "toggle sidebar"],
    shortcut: SHORTCUT,
    run: toggleSidebar,
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isSidebarShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSidebar();
  };

  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return null;
}
