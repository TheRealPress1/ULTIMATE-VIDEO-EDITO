import { For, Show, createResource, createSignal, onMount } from "solid-js";
import { EDITING_STYLE_LIMIT } from "@diffusionstudio/dapi";
import type { EditingStyle, ToolOutput } from "@diffusionstudio/dapi";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { DashboardSurfaceSection } from "./shared";

export function EditingSkillsSettings() {
  const [catalog, { refetch }] = createResource(async () => window.desktop
    ? mainBridge.call(MAIN_CHANNELS.EDITING_SKILLS, { action: "list" }) : null);
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

  const readGuide = async (id: string) => {
    if (reading()) return;
    if (guide()?.id === id) { setGuide(undefined); return; }
    setReading(id);
    setGuideError(null);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.EDITING_SKILLS, { action: "read", id });
      setGuide(result.selected);
    } catch (error) {
      setGuideError(error instanceof Error ? error.message : "Could not open this guide.");
    } finally { setReading(null); }
  };

  return (
    <section id="editing-skills" aria-label="Editing skills">
      <DashboardSurfaceSection title="Editing skills" description="A shared editing library for Claude Code and Codex. The agent chooses the guides relevant to your request.">
        <Show when={window.desktop} fallback={<p class="text-sm text-muted-foreground">Open the desktop app to use the skill library and save your editing style.</p>}>
          <Show when={!catalog.loading} fallback={<p class="text-sm text-muted-foreground">Loading editing skills…</p>}>
            <Show when={!catalog.error} fallback={<div role="alert" class="flex items-center gap-3 text-sm"><span>Could not load the skill library.</span><Button variant="secondary" onClick={() => void refetch()}>Try again</Button></div>}>
              <div class="grid gap-3 sm:grid-cols-2">
                <For each={catalog()?.skills}>{(skill) => (
                  <div class="flex flex-col gap-2 rounded-lg border border-border p-4">
                    <div class="flex items-start justify-between gap-2">
                      <h3 class="text-sm font-medium">{skill.title}</h3>
                      <span class={`shrink-0 text-[11px] ${!skill.available ? "text-destructive" : skill.category === "editing" ? "text-emerald-500" : "text-muted-foreground"}`}>
                        {!skill.available ? "Unavailable" : skill.category === "editing" ? "Built in" : skill.category === "optional" ? "Optional API" : "Reference"}
                      </span>
                    </div>
                    <p class="text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
                    <Show when={skill.requires.length > 0}><p class="text-xs text-muted-foreground">Requires: {skill.requires.join(" · ")}</p></Show>
                    <div class="mt-auto flex items-center justify-between pt-1">
                      <span class="text-[11px] text-muted-foreground">v{skill.version}</span>
                      <Button variant="ghost" disabled={!skill.available || !!reading()} aria-expanded={guide()?.id === skill.id} aria-controls={`skill-guide-${skill.id}`} onClick={() => void readGuide(skill.id)}>{reading() === skill.id ? "Opening…" : guide()?.id === skill.id ? "Close guide" : "Read guide"}</Button>
                    </div>
                    <Show when={guide()?.id === skill.id}>
                      <div id={`skill-guide-${skill.id}`} role="region" aria-label={`${skill.title} guide`} class="mt-2 border-t border-border pt-3">
                        <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{guide()?.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()}</pre>
                      </div>
                    </Show>
                  </div>
                )}</For>
              </div>
              <p class="text-xs leading-relaxed text-muted-foreground">Local editing uses your connected agent. Web image, video and audio search uses the public Openverse and Wikimedia Commons libraries without an account; downloads are saved in the project with their credits. Optional cloud transcription and narration require their own API setup and are used only when requested. Installing a guide does not connect a service.</p>
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
