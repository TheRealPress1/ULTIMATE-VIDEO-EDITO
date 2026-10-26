/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSearchParams } from "@solidjs/router";
import { Match, Switch, createMemo, createResource } from "solid-js";

import { AppSidebar } from "@/components/app-sidebar";
import { DashboardHomeView } from "@/components/dashboard/home-view";
import { DashboardMcpView } from "@/components/dashboard/mcp-view";
import { DashboardProjectsView } from "@/components/dashboard/projects-view";
import { DashboardSettingsView } from "@/components/dashboard/settings-view";
import { DashboardHelpView } from "@/components/dashboard/help-view";
import { DashboardAnalyticsView } from "@/components/dashboard/analytics-view";
import { listCollections, projectsRevision } from "@/projects";
import type { ProjectScope } from "@/components/dashboard/types";

export function DashboardPage() {
  const [params] = useSearchParams();
  const [collections] = createResource(projectsRevision, () => listCollections(), { initialValue: [] });
  const view = () => typeof params.dashboard === "string" ? params.dashboard : "home";
  const projectScope = createMemo((): ProjectScope => {
    if (view() === "drafts") return { kind: "drafts" };
    const collection = collections().find((entry) => entry.id === params.collection);
    return collection ? { kind: "collection", collection } : { kind: "all" };
  });

  return (
    <div class="cutroom-app flex h-screen w-full min-h-0 overflow-hidden">
      <AppSidebar />
      <main class="cutroom-main flex min-h-0 min-w-0 flex-1 flex-col">
        <Switch fallback={<DashboardHomeView />}>
          <Match when={view() === "projects" || view() === "drafts"}>
            <DashboardProjectsView scope={projectScope()} />
          </Match>
          <Match when={view() === "settings" || view() === "preferences" || view() === "account"}>
            <DashboardSettingsView />
          </Match>
          <Match when={view() === "mcp"}>
            <DashboardMcpView />
          </Match>
          <Match when={view() === "analytics"}>
            <DashboardAnalyticsView />
          </Match>
          <Match when={view() === "help"}>
            <DashboardHelpView />
          </Match>
        </Switch>
      </main>
    </div>
  );
}
