/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createEffect, createMemo } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { toast } from "somoto";

import { Icon } from "@/components/ui/icon";
import { AnalyticsIcon } from "@/components/dashboard/analytics-view";
import { createNewProject, createProjectList, openProjectFromList } from "@/components/dashboard/shared";
import { chatState, ensureConnected, refreshChats, setActiveChat, setSidebarTab } from "@/agent-chat/store";
import { SidebarHistory } from "@/agent-chat/sidebar-history";
import { relativeTime } from "@/agent-chat/history-menu";
import { projectRoute } from "@/hooks/use-project-route";
import { projectKey, type ProjectInfo } from "@/projects";

/** The app's other pages, under Home. */
export function HomeLinks(props: { close: () => void }) {
  const navigate = useNavigate();
  const readyAgents = () => chatState.harnesses.filter((harness) => harness.status === "ready");
  const go = (to: string) => {
    props.close();
    navigate(to);
  };

  return (
    <nav class="cutroom-flyout-list" aria-label="App pages">
      <button type="button" class="cutroom-flyout-row" onClick={() => go("/")}><Icon name="home" /><span>Home</span></button>
      <button type="button" class="cutroom-flyout-row" onClick={() => go("/?dashboard=analytics")}><AnalyticsIcon /><span>Analytics</span></button>
      <button type="button" class="cutroom-flyout-row" onClick={() => go("/?dashboard=mcp")}>
        <Icon name="ai-mcp-cli" /><span>Connect agents</span>
        <Show when={readyAgents().length > 0}><span class="cutroom-connected-dot" title={`${readyAgents().length} agent${readyAgents().length === 1 ? "" : "s"} ready`} /></Show>
      </button>
      <button type="button" class="cutroom-flyout-row" onClick={() => go("/?dashboard=settings")}><Icon name="settings" /><span>Settings</span></button>
    </nav>
  );
}

/** The projects last opened, with a way to the rest and to a new one. */
export function ProjectsList(props: { close: () => void }) {
  const navigate = useNavigate();
  const [projects] = createProjectList();
  const recent = createMemo(() => [...(projects() ?? [])].sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt)).slice(0, 8));

  const open = async (project: ProjectInfo) => {
    props.close();
    try {
      const found = await openProjectFromList(project);
      if (found) navigate(projectRoute(projectKey(found)));
    } catch (error) {
      toast.error("Could not open project", { description: (error as Error).message });
    }
  };
  const create = async () => {
    props.close();
    try {
      const created = await createNewProject();
      if (created) navigate(projectRoute(projectKey(created)));
    } catch (error) {
      toast.error("Could not create project", { description: (error as Error).message });
    }
  };

  return (
    <div class="cutroom-flyout-list">
      <p class="cutroom-flyout-label">Recent</p>
      <For each={recent()} fallback={<p class="cutroom-flyout-empty">{projects() ? "No projects yet." : "Loading…"}</p>}>
        {(project) => (
          <button type="button" class="cutroom-flyout-row" onClick={() => void open(project)}>
            <span class="min-w-0 flex-1 truncate">{project.displayName || project.name}</span>
            <span class="cutroom-flyout-meta">{relativeTime(Date.parse(project.lastOpenedAt))}</span>
          </button>
        )}
      </For>
      <div class="cutroom-flyout-rule" />
      <button type="button" class="cutroom-flyout-row" onClick={() => { props.close(); navigate("/?dashboard=projects"); }}><Icon name="film-video-export" /><span>All projects</span></button>
      <button type="button" class="cutroom-flyout-row" onClick={() => void create()}><Icon name="plus-add" /><span>New project</span></button>
    </div>
  );
}

/** Every chat across the projects, with what the sidebar's list had: folders, rename, delete, the trash. */
export function ChatsList(props: { close: () => void; projectId?: string }) {
  const navigate = useNavigate();
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

  const openConversation = async (project: ProjectInfo, id: string) => {
    try {
      const found = await openProjectFromList(project);
      if (!found) return;
      props.close();
      setActiveChat(found.id, id);
      setSidebarTab("chat");
      navigate(projectRoute(projectKey(found)));
    } catch (error) {
      toast.error("Could not open conversation", { description: (error as Error).message });
    }
  };

  return (
    <div class="cutroom-flyout-chats">
      <SidebarHistory chats={chats()} projects={projects() ?? []} projectId={props.projectId} onOpen={(project, id) => void openConversation(project, id)} onNew={() => { props.close(); navigate("/"); }} />
    </div>
  );
}
