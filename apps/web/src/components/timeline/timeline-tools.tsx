/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, type JSX } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";

import { RULER_HEIGHT } from "@/engine/timeline/config";
import { TimelineTool, setTimelineTool, type TimelineToolType } from "@/engine/timeline/tool";

const TOOLS: { id: TimelineToolType; label: string; key: string; icon: JSX.Element }[] = [
  {
    id: "select",
    label: "Selection tool",
    key: "V",
    icon: <svg viewBox="0 0 16 16" class="size-4" fill="currentColor"><path d="M4.5 2.5V12.6L7.3 10 9.3 14 10.7 13.3 8.7 9.5 12.4 9.3Z" /></svg>,
  },
  {
    id: "razor",
    label: "Razor tool",
    key: "C",
    icon: <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.6 11.4 10.8 3.2 12.8 5.2 4.6 13.4Z" /><path d="M9.2 6.4 11 8.2" /></svg>,
  },
];

/**
 * The timeline's tools, down the left of it as an editing timeline has them.
 * What is picked decides what a press on a clip does; the keys are the ones a
 * Premiere editor has under their fingers.
 */
export function TimelineTools() {
  const world = useWorld();
  const tool = useTrait(world, TimelineTool);
  const current = () => tool()?.value ?? "select";

  return (
    <div class="cutroom-timeline-tools" role="toolbar" aria-orientation="vertical" aria-label="Timeline tools" style={{ "padding-top": `${RULER_HEIGHT + 6}px` }}>
      <For each={TOOLS}>
        {(entry) => (
          <button
            type="button"
            class="cutroom-timeline-tool"
            classList={{ "is-active": current() === entry.id }}
            aria-pressed={current() === entry.id}
            aria-label={entry.label}
            title={`${entry.label} (${entry.key})`}
            onClick={() => setTimelineTool(world, entry.id)}
          >
            {entry.icon}
            <span class="cutroom-timeline-tool-key" aria-hidden="true">{entry.key}</span>
          </button>
        )}
      </For>
    </div>
  );
}
