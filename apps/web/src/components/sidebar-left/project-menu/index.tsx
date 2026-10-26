/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { useLocation, useNavigate } from "@solidjs/router";
import { Show, onCleanup, onMount } from "solid-js";
import { isInputTarget } from "@/utils";
import { useEditorApi } from "@/dapi";
import { desktopAppPlatformLabel, downloadDesktopApp } from "@/lib/desktop-app";
import { LOCAL_MODE } from "@/lib/environment";
import type { ProjectRouteState } from "@/hooks/use-project-route";
import { FileMenu, useFileCommands } from "./file-menu";
import { EditMenu } from "./edit-menu";
import { ViewMenu } from "./view-menu";
import { ToolMenu } from "./tool-menu";
import { AiCreditsMenu } from "./ai-credits-menu";
import { HelpMenu } from "./help-menu";

export function ProjectMenu() {
  const navigate = useNavigate();
  const location = useLocation<ProjectRouteState>();
  const { isDesktop } = useEditorApi();
  const fileCommands = useFileCommands();

  const handleOpenDashboard = () => {
    (document.activeElement as HTMLElement)?.blur?.();
    navigate(location.state?.returnTo ?? "/");
  };

  const handleOpenAccount = () => {
    (document.activeElement as HTMLElement)?.blur?.();
    navigate(LOCAL_MODE ? "/?dashboard=settings" : "/?dashboard=account");
  };

  /**
   * Leaving the editor, and the File commands that open or make another
   * project, are the app's rather than the runtime's, so their keys are bound
   * here, with the menu that offers them. ⌘S is the project's own (see
   * `ProjectProvider`).
   */
  const handleShortcut = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || isInputTarget(event)) return;

    const key = event.key.toLowerCase();
    if (event.shiftKey && key === "d") {
      event.preventDefault();
      handleOpenDashboard();
    } else if (event.shiftKey && key === "s") {
      event.preventDefault();
      fileCommands.duplicate();
    } else if (!event.shiftKey && key === "n") {
      event.preventDefault();
      fileCommands.newProject();
    } else if (!event.shiftKey && key === "o") {
      event.preventDefault();
      fileCommands.openProject();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleShortcut);
    onCleanup(() => window.removeEventListener("keydown", handleShortcut));
  });

  return (
    <>
      <DropdownMenu placement="bottom-start">
        <DropdownMenuTrigger
          as="button"
          type="button"
          class="flex items-center gap-0 h-7 rounded-md text-muted-foreground outline-none focus-ring hover:text-foreground data-expanded:text-foreground"
        >
          <Icon name="diffusion-logo" />
          <div class="flex items-center justify-center overflow-clip h-6 w-4">
            <Icon name="chevron-down" />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="w-[196px]">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={handleOpenDashboard}>
                Go to dashboard
                <DropdownMenuShortcut>⇧⌘D</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>File</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent class="w-[196px]">
                    <FileMenu />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Edit</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent class="w-[196px]">
                    <EditMenu />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>View</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent class="w-[216px]">
                    <ViewMenu />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Tool</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent class="w-[172px]">
                    <ToolMenu />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <Show when={!LOCAL_MODE}>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>AI credits</DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent class="w-[188px]">
                      <AiCreditsMenu />
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              </Show>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Help</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent class="w-[188px]">
                    <HelpMenu />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>

              <DropdownMenuItem onSelect={handleOpenAccount}>{LOCAL_MODE ? "Settings" : "Account"}</DropdownMenuItem>
            </DropdownMenuGroup>

            <Show when={!isDesktop}>
              <DropdownMenuSeparator />

              <DropdownMenuGroup>
                <DropdownMenuItem
                  class="gap-1 pl-0 pr-2"
                  onSelect={() => downloadDesktopApp("main_menu")}
                >
                  <span class="grid h-7 w-6 shrink-0 place-items-center overflow-clip">
                    <Icon name="download" />
                  </span>
                  Get desktop app{desktopAppPlatformLabel() ? ` (${desktopAppPlatformLabel()})` : ""}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </Show>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </>
  );
}
