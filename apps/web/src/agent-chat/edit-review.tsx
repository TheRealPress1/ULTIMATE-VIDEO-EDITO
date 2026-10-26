/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createResource, createSignal } from "solid-js";
import { toast } from "somoto";
import { Button } from "@/components/ui/button";
import { chatState, reviewEdit, restoreEdit } from "./store";

/** A durable project-level review; it survives navigation and app restarts. */
export function EditReview(props: { projectId: string; cwd: string; running: boolean; updatedAt?: number }) {
  const [restoring, setRestoring] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [review, { mutate, refetch }] = createResource(
    () => chatState.connection === "open" && !props.running ? [props.projectId, props.updatedAt] as const : false,
    ([projectId]) => reviewEdit(projectId),
  );
  const restore = async () => {
    const current = review();
    if (!current || restoring()) return;
    setRestoring(true);
    try {
      mutate(await restoreEdit(props.projectId, current.id, props.cwd, current.undone ? "redo" : "undo"));
      toast.success(current.undone ? "Agent edit restored" : "Agent edit undone", { description: "Composition restored. Imported media is preserved." });
    } catch (error) {
      toast.error("Could not restore this edit", { description: (error as Error).message });
    } finally { setRestoring(false); }
  };

  return (
    <>
    <Show when={!props.running && review.error}>
      <div role="alert" class="mx-4 mb-3 shrink-0 rounded-lg border border-red-400/30 p-3 text-xs">
        <p class="font-medium">Edit recovery needs attention</p>
        <p class="mt-1 break-words text-muted-foreground">{review.error instanceof Error ? review.error.message : String(review.error)}</p>
        <Button class="mt-2" variant="outline" disabled={review.loading} onClick={() => void Promise.resolve(refetch()).catch(() => {})}>Retry review</Button>
      </div>
    </Show>
    <Show when={!props.running && !review.error && review()}>
      {(edit) => (
        <div class="mx-4 mb-3 shrink-0 rounded-lg border border-border bg-secondary/30 p-3 text-xs">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="font-medium">{edit().undone ? "Agent edit undone" : edit().recovered ? "Recovered interrupted edit" : "Review agent edit"}</p>
              <p class="mt-1 text-xxs text-muted-foreground">{edit().changes.length} composition {edit().changes.length === 1 ? "file" : "files"} changed · Media preserved</p>
            </div>
            <Button variant="outline" disabled={restoring() || review.loading} onClick={() => void restore()}>
              {restoring() ? "Restoring…" : edit().undone ? "Redo edit" : "Undo edit"}
            </Button>
          </div>
          <Show when={edit().recovered && !edit().undone}>
            <p class="mt-2 text-xxs text-muted-foreground">Includes changes present when the app restarted. Review the changes before undoing.</p>
          </Show>
          <button class="mt-2 text-xxs text-muted-foreground hover:text-foreground" onClick={() => setExpanded(!expanded())} aria-expanded={expanded()}>
            {expanded() ? "Hide changes" : "View changes"}
          </button>
          <Show when={expanded()}>
            <div class="mt-2 max-h-64 space-y-2 overflow-y-auto">
              <p class="line-clamp-2 text-xxs text-muted-foreground" title={edit().prompt}>{edit().prompt}</p>
              <For each={edit().changes}>
                {(file) => (
                  <details class="rounded border border-border p-2">
                    <summary class="cursor-pointer break-all text-xxs">{file.path} <span class="text-muted-foreground">· {file.kind}</span></summary>
                    <div class="mt-2 space-y-2 text-xxs">
                      <Show when={file.kind !== "added"}>
                        <div><p class="mb-1 text-muted-foreground">Before</p><pre class="overflow-x-auto whitespace-pre rounded bg-background p-2">{file.before}</pre></div>
                      </Show>
                      <Show when={file.kind !== "removed"}>
                        <div><p class="mb-1 text-muted-foreground">After</p><pre class="overflow-x-auto whitespace-pre rounded bg-background p-2">{file.after}</pre></div>
                      </Show>
                      <Show when={file.truncated}><p class="text-muted-foreground">Preview shortened. Undo restores the complete source.</p></Show>
                    </div>
                  </details>
                )}
              </For>
              <p class="text-xxs text-muted-foreground">Tracks JS/TS, CSS, JSON/YAML and subtitle source. Media and the asset library are preserved. Newer composition edits are protected.</p>
            </div>
          </Show>
        </div>
      )}
    </Show>
    </>
  );
}
