/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useNavigate } from "@solidjs/router";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { createElementSize } from "@solid-primitives/resize-observer";
import { toast } from "somoto";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  AttachmentTile,
  DropOverlay,
  ModelPicker,
  attachmentPaths,
  createDropZone,
  createPasteHandler,
  currentModel,
  mergeAttachments,
  pickAttachments,
  setStoredModel,
  startChat,
  type Attachment,
} from "@/agent-chat";
import { projectRoute, useReturnHere } from "@/hooks/use-project-route";
import { track } from "@/lib/analytics";
import { isMediaAttachment, releaseAttachment } from "@/agent-chat/attachments";
import { draftKey, setActiveChat, setDraftAttachments, setDraftText, setSidebarTab } from "@/agent-chat/store";
import { importProjectMedia, initializeImportedProject, mediaPromptContext } from "@/projects/import-media";
import {
  createProject,
  isDesktop,
  projectKey,
  type ProjectInfo,
} from "@/projects";

import { DeleteProjectDialog } from "./delete-project-dialog";
import { DashboardProjectCard } from "./project-card";
import { createProjectSelection } from "./selection";
import {
  createBackgroundClickHandler,
  createNewProject,
  createProjectList,
  openProjectFromList,
} from "./shared";
import { parseTimestamp } from "./utils";

/**
 * Where the prompt lands: a project chosen from the recents or, until one is
 * chosen, a fresh project under the application folder.
 */
type PromptTarget =
  | { kind: "new" }
  | { kind: "project"; project: ProjectInfo };

/**
 * Recents get one row, and as many cards as fit it at about this width — so a
 * wider window shows more projects rather than bigger cards.
 */
const RECENT_CARD_WIDTH_PX = 180;
const RECENT_MIN_COLUMNS = 2;
/** The grid's `gap-x-3`. */
const RECENT_GAP_PX = 12;

/** Recent projects the target menu offers before it gets unwieldy. */
const MENU_PROJECTS = 8;


const PROMPT_MAX_HEIGHT_PX = 200;

export function DashboardHomeView() {
  const navigate = useNavigate();
  const returnHere = useReturnHere();

  const [prompt, setPrompt] = createSignal("");
  const [target, setTarget] = createSignal<PromptTarget>({ kind: "new" });
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const freshProjects = new Set<string>();

  const attach = (added: Attachment[]) => {
    if (busy()) {
      added.forEach(releaseAttachment);
      return;
    }
    setAttachments((current) => mergeAttachments(current, added));
  };
  const drop = createDropZone(attach);
  const paste = createPasteHandler(attach);
  onCleanup(() => attachments().forEach(releaseAttachment));


  let textarea: HTMLTextAreaElement | undefined;

  createEffect(() => {
    if (!textarea) return;
    prompt();
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, PROMPT_MAX_HEIGHT_PX)}px`;
  });

  // The projects the app knows — created here, or opened from a folder —
  // refetched whenever that list changes.
  const [projects, { refetch: refetchProjects }] = createProjectList();
  // The model is shared with the chat panel and remembered across sessions;
  // the picker is fed by the agent host's probes, so what it offers is what
  // is installed and signed in.
  const model = createMemo(() => currentModel());

  const [recentGrid, setRecentGrid] = createSignal<HTMLElement>();
  const recentGridSize = createElementSize(recentGrid);
  const recentColumns = createMemo(() => {
    const width = recentGridSize.width ?? 0;
    const fit = Math.floor((width + RECENT_GAP_PX) / (RECENT_CARD_WIDTH_PX + RECENT_GAP_PX));
    return Math.max(RECENT_MIN_COLUMNS, fit);
  });

  const recentProjects = createMemo(() =>
    [...(projects() ?? [])].sort(
      (a, b) => parseTimestamp(b.modifiedAt) - parseTimestamp(a.modifiedAt),
    ),
  );
  /** The recent projects that fit the row. */
  const visibleRecents = createMemo(() => recentProjects().slice(0, recentColumns()));

  const targetLabel = () => {
    const current = target();
    if (current.kind === "project") return current.project.displayName;
    return "";
  };

  const canSubmit = () => prompt().trim().length > 0 && !busy() && model() !== null;

  /**
   * The folder the agent will work in: the chosen recent project or, with none
   * chosen, a fresh project under the application folder.
   */
  const resolveTarget = async (): Promise<ProjectInfo | null> => {
    const current = target();
    // A project off the list is its record; the folder is looked at now.
    if (current.kind === "project") return openProjectFromList(current.project);

    const project = await createProject();
    freshProjects.add(project.id);
    return project;
  };

  const handleSubmit = async (sendToAgent = true) => {
    if (busy() || (sendToAgent && !canSubmit())) return;

    if (!isDesktop()) {
      toast.error("Projects on disk are only available in the desktop app");
      return;
    }

    const selected = attachments();
    const paths = attachmentPaths(selected);
    const ref = model();
    if (sendToAgent && !ref) return;
    const text = prompt();
    setBusy(true);
    setProgress("Opening project…");

    try {
      const project = await resolveTarget();
      if (!project) return;
      // Keep a failed import attached to the project already created, so a
      // retry cannot leave a trail of new, empty drafts behind it.
      setTarget({ kind: "project", project });

      const media = selected.filter(isMediaAttachment);
      const sources = attachmentPaths(media);
      const imported = sources.length ? await importProjectMedia(project.dir, sources, (completed, total) => {
        setProgress(`Importing media ${completed + (completed < total ? 1 : 0)} of ${total}…`);
      }) : { assets: [], failed: [] };
      if (imported.failed.length) {
        toast.error(`${imported.failed.length} ${imported.failed.length === 1 ? "file could" : "files could"} not be imported`, {
          description: imported.failed.slice(0, 3).map(({ source, error }) => `${source.split(/[\\/]/).pop()}: ${error.message}`).join("\n"),
        });
        if (!imported.assets.length && media.length === selected.length) return;
      }
      const initialized = freshProjects.has(project.id) && await initializeImportedProject(project, imported.assets);
      const context = [mediaPromptContext(imported.assets), initialized ? "An initial scene named First cut is already on the timeline: visual clips play in import order and audio starts at the beginning. Edit that scene and preview it before exporting." : ""].filter(Boolean).join("\n\n");
      const message = [text.trim(), context].filter(Boolean).join("\n\n");

      // The chat starts before the page switches: the host has the turn as
      // soon as it answers, and the editor lands with the reply streaming.
      // On failure the text survives as the project's draft (see startChat).
      if (sendToAgent && ref) {
        setProgress("Starting your edit…");
        await startChat({ project, text: message, attachments: paths, model: ref });
      } else {
        setActiveChat(project.id, null);
        const key = draftKey(project.id, null);
        // The composer holds the user's draft. Imported media and measured
        // metadata already live in the project; only references still needed
        // by the agent remain attached here.
        const alreadyImported = (entry: Attachment) => {
          if (!entry.path || !isMediaAttachment(entry)) return false;
          const path = entry.path.replace(/\\/g, "/").replace(/\/+$/, "");
          const matches = (source: string) => source.replace(/\\/g, "/") === path || (entry.kind === "folder" && source.replace(/\\/g, "/").startsWith(`${path}/`));
          return imported.assets.some((asset) => matches(asset.source)) && !imported.failed.some((failure) => matches(failure.source));
        };
        setDraftText(key, text);
        setDraftAttachments(key, selected.filter((entry) => !alreadyImported(entry)).map((entry) => ({ ...entry, preview: undefined })));
        setSidebarTab(imported.assets.length ? "assets" : "chat");
      }
      setPrompt("");
      selected.forEach(releaseAttachment);
      setAttachments([]);
      setTarget({ kind: "new" });
      refetchProjects();
      navigate(projectRoute(projectKey(project)), { state: returnHere() });
    } catch (e) {
      toast.error("Could not open the project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const removeAttachment = (key: string) => {
    if (busy()) return;
    attachments().filter((entry) => entry.key === key).forEach(releaseAttachment);
    setAttachments((current) => current.filter((entry) => entry.key !== key));
  };

  // Enter sends, shift+enter breaks the line — and the dashboard's global
  // shortcuts have no business reading what is typed here.
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();

    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;

    event.preventDefault();
    void handleSubmit();
  };

  const [pendingDelete, setPendingDelete] = createSignal<ProjectInfo[]>([]);

  const selection = createProjectSelection({
    projects: visibleRecents,
    grid: recentGrid,
    onDelete: setPendingDelete,
  });

  // Anything outside a card clears the selection — the grid's gaps, the space
  // around it, and the composer above it. A click on a card is that card's.
  const clearSelection = createBackgroundClickHandler(selection.clear);

  const handleDeleted = () => {
    selection.clear();
    refetchProjects();
  };

  const openProject = async (project: ProjectInfo) => {
    const found = await openProjectFromList(project);
    if (!found) return;
    track("project_opened");
    navigate(projectRoute(projectKey(found)), { state: returnHere() });
  };

  const handleCreateProject = async () => {
    if (busy()) return;
    setBusy(true);

    try {
      const project = await createNewProject();
      if (!project) return;
      selection.clear();
      refetchProjects();
      openProject(project);
    } catch (e) {
      toast.error("Failed to create project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="cutroom-home" onClick={clearSelection}>
        <section class="cutroom-home-hero">
          <h1>What should we make?</h1>
          <p class="mb-6 -mt-3 text-center text-sm text-muted-foreground">Drop in your footage. Describe the edit. Make it yours.</p>
          <div
            class="cutroom-home-composer"
            onDragOver={drop.onDragOver}
            onDragEnter={drop.onDragEnter}
            onDragLeave={drop.onDragLeave}
            onDrop={drop.onDrop}
            onPaste={paste}
          >
            <Show when={attachments().length > 0}>
              <div class="flex w-full items-start gap-3 overflow-x-auto pt-2.5 pr-2.5">
                <For each={attachments()}>
                  {(entry) => <div class="flex min-w-36 max-w-56 shrink-0 items-center gap-2 rounded-lg bg-background/40 p-2 pr-3">
                    <AttachmentTile attachment={entry} onRemove={() => removeAttachment(entry.key)} />
                    <div class="min-w-0"><p class="truncate text-xs" title={entry.path ?? entry.name}>{entry.name}</p><p class="mt-0.5 text-[11px] text-muted-foreground">{isMediaAttachment(entry) ? "Ready to import" : "Agent reference"}</p></div>
                  </div>}
                </For>
              </div>
            </Show>
            <textarea
              ref={textarea}
              value={prompt()}
              onInput={(event) => setPrompt(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              onKeyUp={(event) => event.stopPropagation()}
              aria-label="Describe the video you want to make"
              placeholder="Make a 30-second cut, add a title, and keep the best moments…"
              disabled={busy()}
              rows={2}
              class="cutroom-home-input"
            />
            <div class="cutroom-composer-footer">
              <ModelPicker value={model()} onSelect={setStoredModel} class="min-w-0" />
              <Show when={recentProjects().length > 0}>
                <DropdownMenu placement="bottom-start">
                  <DropdownMenuTrigger as="button" type="button" aria-label="Choose the project to work in" class="cutroom-project-target">
                    <Icon name="navigation.folder" />
                    <span>{targetLabel() || "New project"}</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuContent class="w-60">
                      <DropdownMenuItem onSelect={() => setTarget({ kind: "new" })}>
                        <Icon name="plus-add" /><span>New project</span>
                      </DropdownMenuItem>
                      <DropdownMenuGroup>
                        <DropdownMenuGroupLabel>Recent projects</DropdownMenuGroupLabel>
                        <For each={recentProjects().slice(0, MENU_PROJECTS)}>
                          {(project) => <DropdownMenuItem onSelect={() => setTarget({ kind: "project", project })}><Icon name="navigation.folder" /><span class="min-w-0 flex-1 truncate">{project.displayName}</span></DropdownMenuItem>}
                        </For>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenuPortal>
                </DropdownMenu>
              </Show>
              <div class="flex-1" />
              <Button variant="ghost" size="icon-square" disabled={busy()} onClick={async () => attach(await pickAttachments())} aria-label="Add footage or reference files" title="Add footage or reference files" class="text-muted-foreground hover:bg-muted">
                <Icon name="plus-add" />
              </Button>
              <button type="button" onClick={() => handleSubmit()} disabled={!canSubmit()} aria-label="Import media and send to the coding agent" class="cutroom-send">
                <Show when={busy()} fallback={<Icon name="arrow-top" />}><Icon name="spinner-loader" class="animate-spin" /></Show>
              </button>
            </div>
            <Show when={drop.dragging()}><DropOverlay /></Show>
          </div>
          <div class="mt-3 flex min-h-7 items-center justify-between gap-3 text-xs text-muted-foreground">
            <span role="status" aria-live="polite">{progress() || (attachments().some(isMediaAttachment) ? "Media is linked from your computer. Your original files stay untouched." : "Video, audio, images, or a folder of clips.")}</span>
            <button type="button" class="shrink-0 rounded-md px-2 py-1 text-foreground hover:bg-accent disabled:opacity-50" onClick={() => handleSubmit(false)} disabled={busy()}>{attachments().some(isMediaAttachment) ? "Import and open editor" : "Open empty editor"} <span aria-hidden="true">↗</span></button>
          </div>
          <div class="cutroom-suggestions">
            <button type="button" onClick={() => { setPrompt("Help me brainstorm video ideas. Ask about my audience and what I want to share."); textarea?.focus(); }}><Icon name="ai-credits" />Give me video ideas</button>
            <button type="button" onClick={() => { setPrompt("Help me write a video script. Ask me about the topic, tone, and length."); textarea?.focus(); }}><Icon name="tool.text" />Write a script</button>
            <button type="button" onClick={async () => { attach(await pickAttachments()); setPrompt("Edit my clips into a polished video. Help me choose the best moments and pacing."); textarea?.focus(); }}><Icon name="film-video-export" />Edit my clips</button>
          </div>
          <Show when={!model()}>
            <div class="cutroom-connect-hint">
              <p>Bring the models you already use.</p>
              <button type="button" onClick={() => navigate("/?dashboard=mcp")}>Connect an agent <span aria-hidden="true">↗</span></button>
            </div>
          </Show>
        </section>
        <section class="cutroom-recents">
          <div class="cutroom-section-heading">
            <h2>Recent projects</h2>
            <button type="button" onClick={handleCreateProject} disabled={busy()}><Icon name="plus-add" />New project</button>
          </div>
          <Show when={visibleRecents().length > 0} fallback={
            <div class="cutroom-project-empty">
              <Icon name="navigation.folder" />
              <p>A little idea. A whole new video.</p>
              <span>Start a conversation above or create your first project.</span>
            </div>
          }>
            <div ref={setRecentGrid} data-slot="card-grid" class="grid items-start gap-x-3 gap-y-4" style={{ "grid-template-columns": `repeat(${recentColumns()}, minmax(0, 1fr))` }}>
              <For each={visibleRecents()}>
                {(project) => <DashboardProjectCard project={project} active={selection.isSelected(project)} targets={selection.targets(project)} onSelect={(event) => selection.click(project, event)} onContextMenu={() => selection.contextMenu(project)} onOpen={() => openProject(project)} onDelete={() => setPendingDelete(selection.targets(project))} onChanged={refetchProjects} />}
              </For>
            </div>
          </Show>
        </section>
      </div>
      <DeleteProjectDialog projects={pendingDelete()} onClose={() => setPendingDelete([])} onDeleted={handleDeleted} />
    </>
  );
}
