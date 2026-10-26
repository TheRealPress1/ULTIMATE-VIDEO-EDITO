/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createComponent, createRoot, onCleanup, runWithOwner } from "solid-js";
import { useCommands } from "@/context/commands";
import { useBarKey } from "@/components/canvas/action-bar";

import type { RegisteredCommand } from "@/context/commands";

/** Where the bar of the command that is up goes; Esc takes it down. */
export function CommandBar() {
  const commands = useCommands();

  return (
    <Show when={commands.active()} keyed>
      {(command) => <BarOf command={command} />}
    </Show>
  );
}

/**
 * `command`'s bar, rendered under the component that registered the
 * command, so it sees that component's context rather than this one's; it
 * goes when this does.
 */
function BarOf(props: { command: RegisteredCommand }) {
  const { close } = useCommands();
  useBarKey((event) => event.key === "Escape", close);

  const { command } = props;
  let dispose!: () => void;
  const bar = runWithOwner(command.owner, () =>
    createRoot((disposeBar) => {
      dispose = disposeBar;
      return createComponent(command.bar!, {});
    }),
  );
  onCleanup(() => dispose());

  return <>{bar}</>;
}
