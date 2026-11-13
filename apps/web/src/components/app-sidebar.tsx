/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocation, useNavigate } from "@solidjs/router";
import { Show, createEffect, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { toast } from "somoto";

import { Icon } from "@/components/ui/icon";
import { AnalyticsIcon } from "@/components/dashboard/analytics-view";
import { CutroomMark } from "@/components/cutroom-mark";
import { createProjectList, openProjectFromList } from "@/components/dashboard/shared";
import { SIDEBAR_ID, SidebarCommands, SidebarToggle } from "@/components/sidebar-toggle";
import { chatState, ensureConnected, refreshChats, setActiveChat, setSidebarTab } from "@/agent-chat/store";
import { SidebarHistory } from "@/agent-chat/sidebar-history";
import { projectRoute } from "@/hooks/use-project-route";
import { sidebarCanClose, sidebarShown } from "@/lib/sidebar-state";
import { projectKey, type ProjectInfo } from "@/projects";

type AppSidebarProps = { projectId?: string };

/** Shared navigation. Every history row comes from the local agent host. */
export function AppSidebar(props: AppSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [projects] = createProjectList();
  ensureConnected();

  createEffect(() => {
    if (chatState.connection !== "open") return;
    for (const project of projects() ?? []) void refreshChats(project.id);
  });

  const chats = createMemo(() => {
    const known = new Map((projects() ?? []).map((project) => [project.id, project]));
    return Object.values(chatState.lists)
      .flat()
      .filter((chat) => known.has(chat.projectId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((chat) => ({ chat, project: known.get(chat.projectId)! }));
  });
  const readyAgents = () => chatState.harnesses.filter((harness) => harness.status === "ready");
  const onHome = () => location.pathname === "/" && [null, "home"].includes(new URLSearchParams(location.search).get("dashboard"));
  const onProjects = () => location.pathname === "/" && new URLSearchParams(location.search).get("dashboard") === "projects";
  const onAnalytics = () => location.pathname === "/" && new URLSearchParams(location.search).get("dashboard") === "analytics";

  const openConversation = async (project: ProjectInfo, id: string) => {
    try {
      const found = await openProjectFromList(project);
      if (!found) return;
      setActiveChat(found.id, id);
      setSidebarTab("chat");
      navigate(projectRoute(projectKey(found)));
    } catch (error) {
      toast.error("Could not open conversation", { description: (error as Error).message });
    }
  };

  return (
    <>
      {/* Closed, it is hidden from the keyboard and screen readers as well as the eye. */}
      <aside id={SIDEBAR_ID} class="cutroom-sidebar" data-open={sidebarShown()} inert={!sidebarShown()} aria-label="Main navigation">
        <div class="cutroom-sidebar-inner">
          <div class="cutroom-brand">
            <CutroomMark class="cutroom-brand-mark" />
          </div>
          <nav class="cutroom-primary-nav">
            <button type="button" class="cutroom-nav-item" classList={{ "is-active": onHome() }} onClick={() => navigate("/")}>
              <Icon name="home" /><span>Home</span>
            </button>
            <button type="button" class="cutroom-nav-item" classList={{ "is-active": onProjects() }} onClick={() => navigate("/?dashboard=projects")}>
              <Icon name="film-video-export" /><span>Projects</span>
            </button>
            <button type="button" class="cutroom-nav-item" classList={{ "is-active": onAnalytics() }} onClick={() => navigate("/?dashboard=analytics")}>
              <AnalyticsIcon /><span>Analytics</span>
            </button>
          </nav>
          <SidebarHistory chats={chats()} projects={projects() ?? []} projectId={props.projectId} onOpen={(project, id) => void openConversation(project, id)} onNew={() => navigate("/")} />
          <div class="cutroom-sidebar-footer">
            <button type="button" class="cutroom-nav-item" onClick={() => navigate("/?dashboard=mcp")}>
              <Icon name="ai-mcp-cli" /><span>Connect agents</span>
              <Show when={readyAgents().length > 0}><span class="cutroom-connected-dot" title={`${readyAgents().length} agent${readyAgents().length === 1 ? "" : "s"} ready`} /></Show>
            </button>
            <button type="button" class="cutroom-nav-item" onClick={() => navigate("/?dashboard=settings")}>
              <Icon name="settings" /><span>Settings</span>
            </button>
            <div class="cutroom-workspace">
              <div class="cutroom-workspace-avatar"><CutroomMark class="size-4" /></div>
              <div><strong>Local workspace</strong><span>Your files, your models</span></div>
            </div>
          </div>
        </div>
      </aside>
      <Show when={sidebarCanClose()}>
        {/* Last in the document, so the window's drag regions (the strip a closed sidebar leaves, the headers) never cover it: a later drag region wins over an earlier no-drag one. */}
        <Portal><SidebarToggle /></Portal>
        <SidebarCommands />
      </Show>
    </>
  );
}
