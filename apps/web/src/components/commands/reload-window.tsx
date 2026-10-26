/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCommand } from "@/context/commands";
import { flushProjectEdits } from '@/projects/edits';
import { toast } from 'somoto';

/** Loads the window again, for when it is stuck; the project reopens from disk. */
export function ReloadWindowCommand() {
  useCommand({
    id: "reload-window",
    title: "Force reload app",
    group: "View",
    icon: "reload",
    keywords: ["refresh", "restart"],
    shortcut: ["⇧", "⌘", "R"],
    order: 1,
    run: async () => {
      try {
        await flushProjectEdits();
        window.location.reload();
      } catch (error) {
        toast.error('Save your changes before reloading', { description: (error as Error).message });
      }
    },
  });

  return null;
}
