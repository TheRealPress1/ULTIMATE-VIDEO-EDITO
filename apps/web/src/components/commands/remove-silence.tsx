/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo } from "solid-js";
import { toast } from "somoto";
import { useWorld } from "@diffusionstudio/koota-solid";
import { Separator } from "@/components/ui/separator";
import { useCommand, useCommands } from "@/context/commands";
import { useSelection } from "@/engine/hooks";
import { detectClipSilences, removeSilences, silenceTargets } from "@/engine/silence/remove";
import { ActionBar, ActionBarCancel, ActionBarConfirm, ActionBarTarget } from "@/components/canvas/action-bar";

import type { Entity } from "koota";
import type { ClipSilences } from "@/engine/silence/remove";

/** Cuts the silent parts out of the selected video and audio clips and closes the gaps. */
export function RemoveSilenceCommand() {
  const { targets, run } = useRemoveSilence();

  useCommand({
    id: "remove-silence",
    title: "Remove silence",
    group: "Media",
    icon: "ai.remove-silences",
    keywords: ["silent parts", "pauses", "gaps", "jump cut", "trim", "dead air", "audio"],
    ready: () => targets().length > 0,
    run: () => void run(),
    bar: RemoveSilenceBar,
  });

  return null;
}

/** The selected clips with sound, cut on Confirm. */
function RemoveSilenceBar() {
  const { close } = useCommands();
  const { targets, run } = useRemoveSilence();

  const confirm = () => {
    void run();
    close();
  };

  return (
    <ActionBar>
      <ActionBarTarget nodes={targets()} verb="Remove silence from" plural="clips" empty="Select a video or audio clip" />
      <Separator orientation="vertical" class="min-h-5" />
      <ActionBarCancel onCancel={close} />
      <ActionBarConfirm disabled={targets().length === 0} onConfirm={confirm} hint="Remove" />
    </ActionBar>
  );
}

function useRemoveSilence() {
  const world = useWorld();
  const { nodes } = useSelection();

  // Tracks the selection; which of it has sound is read off the world.
  const targets = createMemo(() => (nodes(), silenceTargets(world)), [], { equals: sameEntities });

  const run = async () => {
    const clips = targets();
    if (clips.length === 0) return;

    const found: ClipSilences[] = [];
    try {
      for (const clip of clips) {
        found.push({ clip, silences: await detectClipSilences(world, clip) });
      }
    } catch (e) {
      console.error("Silence detection failed:", e);
      toast.error("Failed to remove silence", { description: (e as Error).message });
      return;
    }

    removeSilences(world, found);
  };

  return { targets, run };
}

function sameEntities(a: Entity[], b: Entity[]): boolean {
  return a.length === b.length && a.every((entity, i) => entity === b[i]);
}
