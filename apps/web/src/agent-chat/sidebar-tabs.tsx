/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For } from "solid-js";

import { setSidebarTab, sidebarTab, type SidebarTab } from "./store";

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "assets", label: "Assets" },
  { id: "chat", label: "Chat" },
  { id: "footage", label: "Footage" },
];

/** Sidebar sections as plain text labels. The choice persists. */
export function SidebarTabs() {
  return (
    <div class="relative z-30 flex items-center gap-4" style="-webkit-app-region: no-drag;" role="tablist">
      <For each={TABS}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={sidebarTab() === tab.id}
            class="text-[12px] font-450 transition-colors focus-ring rounded-sm"
            classList={{
              "text-foreground": sidebarTab() === tab.id,
              "text-muted-foreground hover:text-foreground": sidebarTab() !== tab.id,
            }}
            onClick={() => setSidebarTab(tab.id)}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
}
