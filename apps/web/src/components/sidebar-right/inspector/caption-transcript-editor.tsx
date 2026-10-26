import { createEffect, createMemo, createResource, createSignal, Index, onCleanup, Show } from "solid-js";
import { useTrait } from "@diffusionstudio/koota-solid";
import { AssetId, resolveTranscript } from "@diffusionstudio/runtime";
import { authoredElement } from "@diffusionstudio/reconciler";
import { useEditor } from "@/engine/hooks";
import { useLibrary } from "@/engine/library";
import { Button } from "@/components/ui/button";
import { PanelSection } from "@/components/ui/panel-section";
import { captionDraft, saveCaptionDraft } from "./caption-transcript";

import type { Entity } from "koota";
import type { CaptionDraft, CaptionWordDraft } from "./caption-transcript";

const INPUT = "min-w-0 w-full h-7 rounded bg-input px-1.5 text-xxs outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";

export function CaptionTranscriptEditor(props: { node: Entity }) {
  const editor = useEditor();
  const library = useLibrary();
  const assetId = useTrait(() => props.node, AssetId);
  const asset = createMemo(() => {
    library()?.assets();
    return library()?.get(assetId()?.value ?? "");
  });
  // A manifest refresh can replace an Asset object without changing its bytes.
  // Key by content id so unrelated imports do not discard unsaved text edits.
  const [loaded] = createResource(() => asset()?.id, async (id) => {
    try {
      const source = library()?.get(id);
      if (!source) throw new Error("The caption transcript is no longer available.");
      return { id, transcript: await resolveTranscript(source), error: "" };
    } catch (error) {
      return { id, transcript: [], error: error instanceof Error ? error.message : "Could not read the caption transcript." };
    }
  });
  const [draft, setDraft] = createSignal<CaptionDraft>([]);
  const [segmentIndex, setSegmentIndex] = createSignal(0);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  let mounted = true;
  onCleanup(() => { mounted = false; });

  createEffect(() => {
    const result = loaded();
    setDraft(captionDraft(result?.transcript ?? []));
    setSegmentIndex(0);
    setDirty(false);
    setError(result?.error ?? "");
  });

  const segment = () => draft()[segmentIndex()];
  const wordCount = () => draft().reduce((sum, item) => sum + item.words.length, 0);
  const editWord = (wordIndex: number, field: keyof CaptionWordDraft, value: string) => {
    setDraft((current) => current.map((item, index) => index === segmentIndex()
      ? { words: item.words.map((word, at) => at === wordIndex ? { ...word, [field]: value } : word) }
      : item));
    setDirty(true);
    setSaved(false);
    setError("");
  };
  const removeWord = (wordIndex: number) => {
    setDraft((current) => current.map((item, index) => index === segmentIndex()
      ? { words: item.words.filter((_, at) => at !== wordIndex) }
      : item));
    setDirty(true);
    setSaved(false);
    setError("");
  };
  const reset = () => {
    setDraft(captionDraft(loaded()?.transcript ?? []));
    setDirty(false);
    setError("");
    setSaved(false);
  };
  const apply = async () => {
    const target = props.node;
    const assets = library();
    const originalId = loaded()?.id;
    const originalSource = authoredElement(target)?.props.src;
    if (!assets || !originalId || saving() || loaded.loading || assetId()?.value !== originalId) return;
    setSaving(true);
    setError("");
    try {
      await saveCaptionDraft(draft(), assets, {
        isCurrent: () => mounted && target.isAlive() && target.get(AssetId)?.value === originalId
          && authoredElement(target)?.props.src === originalSource,
        commit: (path) => editor.editProperty(target, "src", path),
      });
      if (mounted) {
        setDirty(false);
        setSaved(true);
      }
    } catch (reason) {
      if (mounted) setError(reason instanceof Error ? reason.message : "Could not save caption changes.");
    } finally {
      if (mounted) setSaving(false);
    }
  };

  return (
    <PanelSection title="Caption text" subtitle={<span class="ml-1 text-muted-foreground font-normal">{wordCount()} words</span>}>
      <Show when={!loaded.loading} fallback={<p class="text-xxs text-muted-foreground">Loading transcript…</p>}>
        <Show when={draft().length > 0} fallback={<p class="text-xxs text-muted-foreground">No transcript words are available for this caption.</p>}>
          <p class="text-xxs leading-relaxed text-muted-foreground">Correct words and timing, then apply to preview. Times are seconds from the start of the transcript.</p>
          <div class="flex items-center gap-2">
            <Button variant="secondary" size="small" aria-label="Previous caption segment" disabled={saving() || segmentIndex() === 0} onClick={() => setSegmentIndex((index) => index - 1)}>Previous</Button>
            <span class="flex-1 text-center text-xxs tabular-nums">Segment {segmentIndex() + 1} / {draft().length}</span>
            <Button variant="secondary" size="small" aria-label="Next caption segment" disabled={saving() || segmentIndex() === draft().length - 1} onClick={() => setSegmentIndex((index) => index + 1)}>Next</Button>
          </div>
          <p class="text-xs leading-relaxed break-words rounded bg-muted/40 p-2">{segment()?.words.map((word) => word.text).join(" ") || "This segment will be removed."}</p>
          <div class="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_1rem] gap-1 text-xxs text-muted-foreground" aria-hidden="true">
            <span>Word</span><span>Start (s)</span><span>End (s)</span><span />
          </div>
          <div class="max-h-64 overflow-y-auto space-y-1">
            <Index each={segment()?.words ?? []}>
              {(word, index) => (
                <div class="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_1rem] gap-1 items-center">
                  <input class={INPUT} aria-label={`Word ${index + 1} text`} value={word().text} disabled={saving()} onInput={(event) => editWord(index, "text", event.currentTarget.value)} />
                  <input class={`${INPUT} tabular-nums`} type="text" inputMode="decimal" aria-label={`Word ${index + 1} start in seconds`} value={word().start} disabled={saving()} onInput={(event) => editWord(index, "start", event.currentTarget.value)} />
                  <input class={`${INPUT} tabular-nums`} type="text" inputMode="decimal" aria-label={`Word ${index + 1} end in seconds`} value={word().end} disabled={saving()} onInput={(event) => editWord(index, "end", event.currentTarget.value)} />
                  <button class="h-7 text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label={`Remove word ${index + 1}`} disabled={saving()} onClick={() => removeWord(index)}>×</button>
                </div>
              )}
            </Index>
          </div>
          <div class="flex gap-2 mt-1">
            <Button class="flex-1" disabled={!dirty() || saving()} onClick={() => void apply()}>{saving() ? "Saving…" : "Apply changes"}</Button>
            <Button variant="secondary" disabled={!dirty() || saving()} onClick={reset}>Reset</Button>
          </div>
          <Show when={saved() && !dirty()}><p role="status" class="text-xxs text-muted-foreground">Caption changes applied. Undo restores the previous version.</p></Show>
        </Show>
      </Show>
      <Show when={error()}><p role="alert" class="text-xxs leading-relaxed text-destructive">{error()}</p></Show>
    </PanelSection>
  );
}
