/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For } from "solid-js";
import { WORKSPACES, useLayout, type Workspace } from "@/context/layout";

const LABELS: Record<Workspace, string> = { edit: "Edit", board: "Board" };

/** Edit is the program monitor and timeline; Board is the canvas of scenes with the drawing tools. */
export function WorkspaceTabs() {
  const { workspace, setWorkspace } = useLayout();

  return (
    <div class="cutroom-workspaces" role="tablist" aria-label="Workspace">
      <For each={WORKSPACES}>
        {(id) => (
          <button
            type="button"
            role="tab"
            aria-selected={workspace() === id}
            class="cutroom-workspace-tab"
            classList={{ "is-active": workspace() === id }}
            onClick={() => setWorkspace(id)}
          >
            {LABELS[id]}
          </button>
        )}
      </For>
    </div>
  );
}
