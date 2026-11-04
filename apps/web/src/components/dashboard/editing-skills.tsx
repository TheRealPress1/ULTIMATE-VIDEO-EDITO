import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { EDITING_STYLE_LIMIT } from "@diffusionstudio/dapi";
import type { EditingStyle, ToolOutput } from "@diffusionstudio/dapi";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { DashboardSurfaceSection } from "./shared";
import { groupSkills, guideText, skillBadge, skillVersionLabel, supportingFileLabel, userSkillsNotice, userSkillsState } from "./editing-skills-data";
import type { SkillBadgeTone } from "./editing-skills-data";

const BADGE_TONES: Record<SkillBadgeTone, string> = { unavailable: "text-destructive", "built-in": "text-emerald-500", user: "text-primary", muted: "text-muted-foreground" };
type ListedSkill = ToolOutput<"skills">["skills"][number];

export function EditingSkillsSettings() {
  const [catalog, { refetch }] = createResource(async () => window.desktop
    ? mainBridge.call(MAIN_CHANNELS.EDITING_SKILLS, { action: "list" }) : null);
  // Whether agents see the saved skills follows the memory switch in the panel below, so it is re-read
  // every few seconds while Settings is visible, and when the window comes back into focus.
  const [memory, { refetch: refetchMemory }] = createResource(async () => window.desktop
    ? mainBridge.call(MAIN_CHANNELS.MEMORY_GET, undefined).then(({ available, enabled }) => ({ available, enabled }), () => null) : null);
  onMount(() => {
    if (!window.desktop) return;
    const refresh = () => { if (document.visibilityState === "visible" && !memory.loading) void refetchMemory(); };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    onCleanup(() => { clearInterval(timer); window.removeEventListener("focus", refresh); });
  });
  const [guide, setGuide] = createSignal<ToolOutput<"skills">["selected"]>();
  const [reading, setReading] = createSignal<string | null>(null);
  const [guideError, setGuideError] = createSignal<string | null>(null);
  const [style, setStyle] = createSignal<EditingStyle | null>(null);
  const [notes, setNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [loadingStyle, setLoadingStyle] = createSignal(false);
  const [styleError, setStyleError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);

  const loadStyle = async () => {
    if (loadingStyle() || saving()) return;
    setLoadingStyle(true);
    setStyleError(null);
    setSaved(false);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.EDITING_STYLE_GET, undefined);
      setStyle(result);
      setNotes(result.notes);
    } catch (error) {
      setStyleError(error instanceof Error ? error.message : "Could not load your editing style.");
    } finally { setLoadingStyle(false); }
  };
  onMount(() => { if (window.desktop) void loadStyle(); });

  const saveStyle = async () => {
    const current = style();
    if (!current || saving() || loadingStyle()) return;
    setSaving(true);
    setStyleError(null);
    setSaved(false);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.EDITING_STYLE_SET, { notes: notes(), expectedRevision: current.revision });
      setStyle(result);
      setNotes(result.notes);
      setSaved(true);
    } catch (error) {
      setStyleError(error instanceof Error ? error.message : "Could not save your editing style.");
    } finally { setSaving(false); }
  };

  /** Opens a skill's guide, or one of its supporting files; asking for the open guide again closes it. */
  const readGuide = async (id: string, file?: string) => {
    if (reading()) return;
    if (file === undefined && guide()?.id === id) { setGuide(undefined); return; }
    setReading(id);
    setGuideError(null);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.EDITING_SKILLS, file === undefined ? { action: "read", id } : { action: "read", id, file });
      setGuide(result.selected);
    } catch (error) {
      setGuideError(error instanceof Error ? error.message : "Could not open this guide.");
    } finally { setReading(null); }
  };
  const groups = () => groupSkills(catalog()?.skills);
  const userNotice = () => userSkillsNotice(userSkillsState(memory.latest), groups().user.length);

  const SkillCard = (props: { skill: ListedSkill }) => {
    const open = () => guide()?.id === props.skill.id;
    const mainFile = () => props.skill.path.split("/").pop() ?? "SKILL.md";
    return (
      <div class="flex flex-col gap-2 rounded-lg border border-border p-4">
        <div class="flex items-start justify-between gap-2">
          <h3 class="text-sm font-medium">{props.skill.title}</h3>
          <span class={`shrink-0 text-[11px] ${BADGE_TONES[skillBadge(props.skill).tone]}`}>{skillBadge(props.skill).label}</span>
        </div>
        <p class="text-xs leading-relaxed text-muted-foreground">{props.skill.description}</p>
        <Show when={props.skill.requires.length > 0}><p class="text-xs text-muted-foreground">Requires: {props.skill.requires.join(" · ")}</p></Show>
        <Show when={props.skill.files.length > 0 && !open()}><p class="text-xs text-muted-foreground">{props.skill.files.length === 1 ? "1 supporting file" : `${props.skill.files.length} supporting files`}</p></Show>
        <div class="mt-auto flex items-center justify-between pt-1">
          <span class="text-[11px] text-muted-foreground">{skillVersionLabel(props.skill)}</span>
          <Button variant="ghost" disabled={!props.skill.available || !!reading()} aria-expanded={open()} aria-controls={`skill-guide-${props.skill.id}`} onClick={() => void readGuide(props.skill.id)}>{reading() === props.skill.id && !open() ? "Opening…" : open() ? "Close guide" : "Read guide"}</Button>
        </div>
        <Show when={open()}>
          <div id={`skill-guide-${props.skill.id}`} role="region" aria-label={`${props.skill.title} guide`} class="mt-2 flex flex-col gap-2 border-t border-border pt-3">
            <Show when={props.skill.files.length > 0}>
              <div role="group" aria-label={`${props.skill.title} files`} class="flex flex-wrap gap-1">
                <For each={[mainFile(), ...props.skill.files]}>{(file, index) => (
                  <Button variant={guide()?.file === file ? "secondary" : "ghost"} disabled={!!reading()} aria-pressed={guide()?.file === file}
                    title={file} onClick={() => void readGuide(props.skill.id, file)}>{index() === 0 ? "Guide" : supportingFileLabel(file)}</Button>
                )}</For>
              </div>
            </Show>
            <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{guideText(guide()?.content ?? "")}</pre>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <section id="editing-skills" aria-label="Editing skills">
      <DashboardSurfaceSection title="Editing skills" description="A shared editing library for Claude Code and Codex. The agent chooses the guides relevant to your request.">
        <Show when={window.desktop} fallback={<p class="text-sm text-muted-foreground">Open the desktop app to use the skill library and save your editing style.</p>}>
          <Show when={!catalog.loading} fallback={<p class="text-sm text-muted-foreground">Loading editing skills…</p>}>
            <Show when={!catalog.error} fallback={<div role="alert" class="flex items-center gap-3 text-sm"><span>Could not load the skill library.</span><Button variant="secondary" onClick={() => void refetch()}>Try again</Button></div>}>
              <div class="grid gap-3 sm:grid-cols-2">
                <For each={groups().bundled}>{(skill) => <SkillCard skill={skill} />}</For>
              </div>
              <p class="text-xs leading-relaxed text-muted-foreground">Local editing uses your connected agent. Web image, video and audio search uses the public Openverse and Wikimedia Commons libraries without an account; downloads are saved in the project with their credits. Local add-on guides run on this Mac with the audio add-on, which installs itself. Optional cloud transcription and narration require their own API setup and are used only when requested. Installing a guide does not connect a service.</p>
              <div class="mt-3 flex flex-col gap-3 border-t border-border pt-5">
                <div><h3 class="text-sm font-medium">Your skills</h3><p class="mt-1 text-xs leading-relaxed text-muted-foreground">Procedures you asked an agent to keep, saved on this device and shared by Claude Code and Codex. Agents follow them like the built-in guides, but they never override your current request.</p></div>
                <Show when={userNotice()}>{(notice) => <p class="text-xs leading-relaxed text-muted-foreground">{notice()}</p>}</Show>
                <Show when={groups().user.length > 0}>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <For each={groups().user}>{(skill) => <SkillCard skill={skill} />}</For>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
          <Show when={guideError()}><p role="alert" class="text-sm text-destructive">{guideError()}</p></Show>
          <div class="mt-3 flex flex-col gap-3 border-t border-border pt-5">
            <div><label for="editing-style-notes" class="text-sm font-medium">Your editing style</label><p class="mt-1 text-xs leading-relaxed text-muted-foreground">Save preferences for all your projects: fonts, caption treatment, pacing, colors, or reference edits. Each project's brief takes priority. The agent can also remember preferences when you explicitly ask.</p></div>
            <textarea id="editing-style-notes" rows={5} value={notes()} maxLength={EDITING_STYLE_LIMIT}
              disabled={!style() || saving() || loadingStyle()} onInput={(event) => { setNotes(event.currentTarget.value); setSaved(false); }}
              placeholder="For example: Keep natural pauses. Use restrained captions. Avoid zooms unless I ask."
              class="w-full resize-y rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
            <div class="flex flex-wrap items-center gap-3">
              <Button disabled={!style() || saving() || loadingStyle() || notes() === style()?.notes} onClick={() => void saveStyle()}>{saving() ? "Saving…" : "Save editing style"}</Button>
              <Button variant="ghost" disabled={saving() || loadingStyle()} onClick={() => void loadStyle()}>{loadingStyle() ? "Loading…" : "Reload saved style"}</Button>
              <span class="text-xs text-muted-foreground">{notes().length}/{EDITING_STYLE_LIMIT}</span>
              <Show when={saved()}><span role="status" class="text-xs text-emerald-500">Saved on this device</span></Show>
            </div>
            <Show when={styleError()}><p role="alert" class="text-sm text-destructive">{styleError()}</p></Show>
          </div>
        </Show>
      </DashboardSurfaceSection>
    </section>
  );
}
