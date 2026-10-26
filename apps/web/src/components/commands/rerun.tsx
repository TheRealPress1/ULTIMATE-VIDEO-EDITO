/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo } from "solid-js";
import { Separator } from "@/components/ui/separator";
import { useCommand, useCommands } from "@/context/commands";
import { useGenerate } from "@/components/genai/use-generate";
import { useGenerationRecords } from "@/components/genai/use-generation-records";
import { useMediaSelection } from "@/components/genai/selection";
import {
  ActionBar,
  ActionBarCancel,
  ActionBarConfirm,
  ActionBarCredits,
  ActionBarTarget,
} from "@/components/canvas/action-bar";

export function RerunCommand() {
  const { media } = useMediaSelection();

  useCommand({
    id: "rerun",
    title: "Rerun generation",
    group: "Generate",
    icon: "rerun",
    keywords: ["regenerate", "again", "retry"],
    available: () => media().some((entry) => entry.asset?.job !== undefined),
    bar: RerunBar,
  });

  return null;
}

/** The first generated node of the selection, generated again from the same request on Confirm. */
function RerunBar() {
  const { close } = useCommands();
  const { media } = useMediaSelection();
  const { firstJob } = useGenerationRecords();
  const { rerun } = useGenerate();

  // The node whose job `firstJob` is, once that is fetched.
  const generated = createMemo(() => media().find((entry) => entry.asset?.job !== undefined)?.node);

  const confirm = () => {
    const job = firstJob();
    if (!job) return;
    rerun(job.request);
    close();
  };

  return (
    <ActionBar>
      <ActionBarTarget
        nodes={generated() ? [generated()!] : []}
        verb="Rerun"
        empty="Select a generated image or video"
      />
      <ActionBarCredits credits={firstJob()?.credits} />
      <Separator orientation="vertical" class="min-h-5" />
      <ActionBarCancel onCancel={close} />
      <ActionBarConfirm disabled={!firstJob()} onConfirm={confirm} hint="Rerun" />
    </ActionBar>
  );
}
