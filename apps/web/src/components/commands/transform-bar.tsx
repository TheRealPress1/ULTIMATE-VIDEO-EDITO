/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo } from "solid-js";
import { Separator } from "@/components/ui/separator";
import { useCommands } from "@/context/commands";
import { useTransforms } from "@/components/genai/use-transforms";
import {
  ActionBar,
  ActionBarCancel,
  ActionBarConfirm,
  ActionBarCredits,
  ActionBarTarget,
} from "@/components/canvas/action-bar";

import type { Entity } from "koota";
import type { TransformType } from "@/components/genai/types";

type TransformBarProps = {
  type: TransformType;
  /** What the transform does: "Upscale". */
  verb: string;
  /** What to select, while nothing it runs over is. */
  empty: string;
};

/** A transform's bar: the selected media it runs over and what that costs, run on Confirm. */
export function TransformBar(props: TransformBarProps) {
  const { close } = useCommands();
  const { targets, run, price } = useTransforms();

  const nodes = createMemo(() => targets(props.type).map((entry) => entry.node), [], { equals: sameEntities });

  const confirm = () => {
    run(props.type);
    close();
  };

  return (
    <ActionBar>
      <ActionBarTarget nodes={nodes()} verb={props.verb} empty={props.empty} />
      <ActionBarCredits credits={price(props.type)} />
      <Separator orientation="vertical" class="min-h-5" />
      <ActionBarCancel onCancel={close} />
      <ActionBarConfirm disabled={nodes().length === 0} onConfirm={confirm} hint={props.verb} />
    </ActionBar>
  );
}

function sameEntities(a: Entity[], b: Entity[]): boolean {
  return a.length === b.length && a.every((entity, i) => entity === b[i]);
}
