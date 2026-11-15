/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, type JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";

import { CutroomMark } from "@/components/cutroom-mark";
import { ProjectMenu } from "@/components/sidebar-left/project-menu";
import { isWindowsDesktop } from "@/projects";

import { ChatsList, HomeLinks, ProjectsList } from "./flyouts";
import { NavFlyout } from "./nav-flyout";

type TopBarProps = {
  /** In a project: the mark opens its menu, and the chats list marks this project's open chat. */
  projectId?: string;
  /** Right after the navigation: what the page is about (a project's name). */
  children?: JSX.Element;
  /** In the middle of the bar. */
  center?: JSX.Element;
  /** At the right-hand end. */
  end?: JSX.Element;
};

/**
 * The bar across the top of every page. The mark and the three labels at its
 * left are the app's navigation: Home, Projects and Chats each open a flyout
 * when the pointer rests on them, so no column is kept for it. What the page
 * itself has to offer follows them, in the middle and at the end.
 */
export function TopBar(props: TopBarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const view = () => (location.pathname === "/" ? (new URLSearchParams(location.search).get("dashboard") ?? "home") : null);

  return (
    <header class="cutroom-topbar" data-topbar>
      <div class="cutroom-topbar-start">
        {/* In a project the mark opens the project menu; the Windows title bar carries that menu itself. */}
        <Show when={props.projectId && !isWindowsDesktop()} fallback={
          <button type="button" class="cutroom-brand-menu outline-none focus-ring" aria-label="Home" title="Home" onClick={() => navigate("/")}><CutroomMark class="cutroom-brand-mark" /></button>
        }>
          <ProjectMenu class="cutroom-brand-menu outline-none focus-ring" label="Menu">
            <CutroomMark class="cutroom-brand-mark" />
          </ProjectMenu>
        </Show>
        <nav class="cutroom-topnav" aria-label="Main navigation">
          <NavFlyout label="Home" active={view() === "home" || view() === "settings" || view() === "mcp" || view() === "analytics"} width={232} onSelect={() => navigate("/")}>
            {(close) => <HomeLinks close={close} />}
          </NavFlyout>
          <NavFlyout label="Projects" active={view() === "projects" || view() === "drafts"} width={300} onSelect={() => navigate("/?dashboard=projects")}>
            {(close) => <ProjectsList close={close} />}
          </NavFlyout>
          <NavFlyout label="Chats" pinned width={340}>
            {(close) => <ChatsList close={close} projectId={props.projectId} />}
          </NavFlyout>
        </nav>
        {props.children}
      </div>
      <div class="cutroom-topbar-center">{props.center}</div>
      <div class="cutroom-topbar-end">{props.end}</div>
    </header>
  );
}
