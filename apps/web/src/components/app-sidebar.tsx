/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocation, useNavigate } from "@solidjs/router";
import { For, Show, createEffect, createMemo } from "solid-js";
import { toast } from "somoto";

import { Icon } from "@/components/ui/icon";
import { AnalyticsIcon } from "@/components/dashboard/analytics-view";
import { createProjectList, openProjectFromList } from "@/components/dashboard/shared";
import { activeChatId, chatState, ensureConnected, refreshChats, setActiveChat, setSidebarTab } from "@/agent-chat/store";
import { projectRoute } from "@/hooks/use-project-route";
import { projectKey, type ProjectInfo } from "@/projects";

/** Original mark: two offset film frames, joined by a single cut. */
export function CutroomMark(props: { class?: string }) {
  return (
    <svg class={props.class} width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <path d="M5 4h10a3 3 0 0 1 3 3v1H9a4 4 0 0 0-4 4v9a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" fill="currentColor" opacity=".48" />
      <path d="M11 10h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Z" stroke="currentColor" stroke-width="2" />
      <path d="m13 13 6 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

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
    <aside class="cutroom-sidebar" aria-label="Main navigation">
      <div class="cutroom-brand">
        <CutroomMark />
        <span>Cutroom</span>
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
      <div class="cutroom-chats-heading">
        <span>Chats</span>
        <button type="button" aria-label="New conversation" title="New conversation" onClick={() => navigate("/")}>
          <Icon name="plus-add" />
        </button>
      </div>
      <div class="cutroom-chat-history">
        <Show when={chats().length > 0} fallback={<p class="cutroom-chat-empty">Your conversations will appear here.</p>}>
          <For each={chats()}>
            {({ chat, project }) => (
              <button type="button" class="cutroom-chat-row" title={chat.title} classList={{ "is-active": props.projectId === project.id && activeChatId(project.id) === chat.id }} onClick={() => void openConversation(project, chat.id)}>
                <span>{chat.title}</span>
                <Show when={chat.status === "running"}><Icon name="spinner-loader" class="size-3.5 shrink-0 animate-spin text-muted-foreground" /></Show>
                <Show when={chat.status === "waiting"}><span class="cutroom-unread-dot" title="Waiting for your reply" /></Show>
              </button>
            )}
          </For>
        </Show>
      </div>
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
    </aside>
  );
}
