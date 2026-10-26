/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toast } from "somoto";
import { For, Show, createMemo, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectPortal,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DashboardCardMeta,
  DashboardCardButton,
  DashboardCardPreview,
  DashboardViewSection,
  createNewProject,
  createProjectList,
  openProjectFromList,
} from "./shared";
import { DeleteProjectDialog } from "./delete-project-dialog";
import { DashboardProjectCard } from "./project-card";
import { createProjectSelection } from "./selection";
import { parseTimestamp } from "./utils";
import { DashboardSearchPanel } from "./search-bar";
import { projectRoute, useReturnHere } from "@/hooks/use-project-route";
import { Icon } from "../ui/icon";
import { track } from "@/lib/analytics";
import { isDesktop, openProjectFolder, pickProjectFolder, projectKey, type ProjectInfo } from "@/projects";

import type { ProjectScope, ProjectSortOption } from "./types";

type DashboardProjectsViewProps = {
  scope: ProjectScope;
};

const scopeTitle = (scope: ProjectScope): string => {
  if (scope.kind === "drafts") return "Drafts";
  if (scope.kind === "collection") return scope.collection.name;
  return "All projects";
};

/** The id of the collection `scope` lists, if it lists one. */
const scopeCollectionId = (scope: ProjectScope): string | undefined =>
  scope.kind === "collection" ? scope.collection.id : undefined;

export function DashboardProjectsView(props: DashboardProjectsViewProps) {
  const navigate = useNavigate();
  const returnHere = useReturnHere();
  const [search, setSearch] = createSignal("");
  const [sort, setSort] = createSignal<ProjectSortOption>("last-viewed");
  const [projects, { refetch: refetchProjects }] = createProjectList();
  const [creating, setCreating] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<ProjectInfo[]>([]);
  const [grid, setGrid] = createSignal<HTMLDivElement>();

  const selectedSortOption = () =>
    SORT_OPTIONS.find((option) => option.id === sort()) ?? SORT_OPTIONS[0];

  const normalizedSearch = createMemo(() => search().trim().toLowerCase());

  const scopedProjects = createMemo(() => {
    const scope = props.scope;
    const entries = projects() ?? [];
    if (scope.kind === "drafts") return entries.filter((project) => project.draft);
    if (scope.kind === "collection") return entries.filter((project) => project.collectionId === scope.collection.id);
    return entries;
  });

  const filteredProjects = createMemo(() => {
    const query = normalizedSearch();
    const entries = scopedProjects();
    if (!query) return entries;

    return entries.filter((project) => project.displayName.toLowerCase().includes(query));
  });

  const sortedProjects = createMemo(() => {
    const sortMode = sort();
    const entries = [...filteredProjects()];

    if (sortMode === "alphabetical") {
      entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return entries;
    }

    if (sortMode === "date-created") {
      entries.sort((a, b) => parseTimestamp(b.createdAt) - parseTimestamp(a.createdAt));
      return entries;
    }

    entries.sort((a, b) => parseTimestamp(b.modifiedAt) - parseTimestamp(a.modifiedAt));
    return entries;
  });

  const selection = createProjectSelection({
    projects: sortedProjects,
    grid,
    onDelete: setPendingDelete,
  });

  const openProject = async (project: ProjectInfo) => {
    const found = await openProjectFromList(project);
    if (!found) return;
    track('project_opened');
    navigate(projectRoute(projectKey(found)), { state: returnHere() });
  };

  const handleDeleted = () => {
    selection.clear();
    refetchProjects();
  };

  // New project is the one card a single click still acts on, so a double
  // click lands on it as two clicks — the guard keeps that from creating two
  // projects.
  const handleCreateProject = async () => {
    if (creating()) return;
    setCreating(true);

    try {
      const project = await createNewProject(scopeCollectionId(props.scope));
      if (!project) return;
      refetchProjects();
      openProject(project);
    } catch (e) {
      toast.error("Failed to create project", { description: (e as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const handleOpenFolder = async () => {
    if (picking()) return;
    setPicking(true);

    try {
      const dir = await pickProjectFolder();
      if (!dir) return;
      await openProjectFolder(dir, scopeCollectionId(props.scope));
    } catch (e) {
      toast.error("Failed to open project", { description: (e as Error).message });
    } finally {
      setPicking(false);
    }
  };

  return (
    <DashboardSearchPanel
      value={search}
      onChange={setSearch}
      placeholder={props.scope.kind === "all" ? "Search in projects" : `Search in ${scopeTitle(props.scope)}`}
    >
      <DashboardViewSection
        class="pb-4"
        title={scopeTitle(props.scope)}
        onBackgroundClick={selection.clear}
        gridRef={setGrid}
        controls={
          <div class="flex items-center gap-2">
            <Show when={isDesktop() && props.scope.kind !== "drafts"}>
              <Button variant="secondary" disabled={picking()} onClick={handleOpenFolder}>
                Open project...
              </Button>
            </Show>
            <Select<(typeof SORT_OPTIONS)[number]>
              options={SORT_OPTIONS}
              value={selectedSortOption()}
              onChange={(option) => option && setSort(option.id)}
              optionValue="id"
              optionTextValue="label"
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>
                  {itemProps.item.rawValue.label}
                </SelectItem>
              )}
            >
              <SelectTrigger aria-label="Sort projects">
                <SelectValue<(typeof SORT_OPTIONS)[number]>>
                  {(state) => state.selectedOption()?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPortal>
                <SelectContent />
              </SelectPortal>
            </Select>
          </div>
        }
      >
        <DashboardCardButton onClick={handleCreateProject}>
          <DashboardCardPreview class="bg-overlay-soft group-hover:bg-overlay">
            <Icon
              name="plus-add"
              class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </DashboardCardPreview>
          <DashboardCardMeta title="New project" />
        </DashboardCardButton>
        <For each={sortedProjects()}>
          {(project) => (
            <DashboardProjectCard
              project={project}
              active={selection.isSelected(project)}
              targets={selection.targets(project)}
              onSelect={(event) => selection.click(project, event)}
              onContextMenu={() => selection.contextMenu(project)}
              onOpen={() => openProject(project)}
              onDelete={() => setPendingDelete(selection.targets(project))}
              onChanged={refetchProjects}
            />
          )}
        </For>
      </DashboardViewSection>

      <DeleteProjectDialog
        projects={pendingDelete()}
        onClose={() => setPendingDelete([])}
        onDeleted={handleDeleted}
      />
    </DashboardSearchPanel>
  );
}

const SORT_OPTIONS: Array<{ id: ProjectSortOption; label: string }> = [
  { id: "last-viewed", label: "Last modified" },
  { id: "alphabetical", label: "Alphabetical" },
  { id: "date-created", label: "Date created" },
];
