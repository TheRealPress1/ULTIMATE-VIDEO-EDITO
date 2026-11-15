/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toast } from "somoto";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/context/auth";
import { startFeedback } from "@/lib/feedback";

export function HelpMenu() {
  const auth = useAuth();

  const copyUserId = async () => {
    const id = auth.user()?.id;
    if (!id) return;

    try {
      await navigator.clipboard.writeText(id);
      toast("Copied!", { description: "The user id has been copied to your clipboard." });
    } catch (error) {
      toast("Failed to copy", { description: error instanceof Error ? error.message : "Unknown error" });
    }
  };

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem as="a" href="https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO" target="_blank">
          What’s new
        </DropdownMenuItem>
        <DropdownMenuItem as="a" href="https://github.com/diffusionstudio/editor" target="_blank">
          Diffusion Studio foundation
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        {/* The dialog when feedback is set up on this Mac, the public issues page when not; after the menu has closed. */}
        <DropdownMenuItem onSelect={() => queueMicrotask(() => void startFeedback())}>Report issue</DropdownMenuItem>
        <DropdownMenuItem onSelect={copyUserId}>Copy user id</DropdownMenuItem>
        <DropdownMenuItem as="a" href="https://github.com/diffusionstudio/editor" target="_blank">
          Upstream documentation
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}
