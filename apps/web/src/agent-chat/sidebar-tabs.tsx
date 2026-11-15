/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, onCleanup } from "solid-js";

import { MEDIA_PATHS_DRAG_TYPE } from "@/components/sidebar-left/media-browser-data";

import { projectTab, setSidebarTab, type SidebarTab } from "./store";

type Group = "agent" | "project";

/** The agent has a panel of its own; the project's media and the footage search share the one below it. */
const GROUPS: Record<Group, { id: SidebarTab; label: string }[]> = {
  agent: [{ id: "chat", label: "Agent" }],
  project: [
    { id: "assets", label: "Project" },
    { id: "media", label: "Media" },
    { id: "footage", label: "Footage" },
  ],
};

/**
 * One panel's tabs, as plain text labels with an underline under the open one.
 * The choice persists.
 */
export function SidebarTabs(props: { group: Group }) {
  const tabs = () => GROUPS[props.group];
  // The agent and the project panel are on screen together; only the project panel's tabs take turns.
  const isOpen = (id: SidebarTab) => props.group === "agent" || projectTab() === id;

  // A clip dragged from the Media tab over another tab opens it after a
  // moment, as Finder's folders spring open, so it can be dropped on Project.
  let springTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSpring = () => clearTimeout(springTimer);
  onCleanup(cancelSpring);
  const handleDragEnter = (id: SidebarTab, event: DragEvent) => {
    if (isOpen(id) || !event.dataTransfer?.types.includes(MEDIA_PATHS_DRAG_TYPE)) return;
    cancelSpring();
    springTimer = setTimeout(() => setSidebarTab(id), 500);
  };

  return (
    <div class="relative z-30 flex h-full items-stretch gap-4" style="-webkit-app-region: no-drag;" role="tablist">
      <For each={tabs()}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={isOpen(tab.id)}
            class="relative flex items-center text-[12px] font-450 transition-colors focus-ring rounded-sm after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:rounded-full"
            classList={{
              "text-foreground after:bg-foreground/55": isOpen(tab.id),
              "text-muted-foreground hover:text-foreground after:bg-transparent": !isOpen(tab.id),
            }}
            onClick={() => setSidebarTab(tab.id)}
            onDragEnter={(event) => handleDragEnter(tab.id, event)}
            onDragLeave={cancelSpring}
            onDrop={cancelSpring}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
}
