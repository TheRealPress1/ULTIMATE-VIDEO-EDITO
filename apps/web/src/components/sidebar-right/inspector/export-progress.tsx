/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createMemo, createSignal, on } from "solid-js";
import { Show, Portal } from "solid-js/web";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type ExportProgressProps = {
  open: boolean;
  audioOnly: boolean;
  progress: number;
  phase: "preparing" | "rendering" | "canceling";
  name?: string;
  remaining?: { minutes: number; seconds: number };
  onCancel: () => void;
};

export function ExportProgress(props: ExportProgressProps) {
  const [confirming, setConfirming] = createSignal(false);
  const open = createMemo(() => props.open);
  createEffect(on(open, () => setConfirming(false)));

  const confirmCancel = () => {
    setConfirming(false);
    props.onCancel();
  };

  const remaining = () => {
    const r = props.remaining;
    if (!r) return;
    return r.minutes > 0
      ? `~${r.minutes}m ${r.seconds}s remaining`
      : `~${r.seconds}s remaining`;
  };

  return (
    <Show when={props.open}>
      <Portal>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-background">
          <div class="flex w-full max-w-md flex-col items-center px-6">
            <h4 class="text-[14px] mb-2">
              {props.phase === "preparing" ? "Preparing your export..." : props.phase === "canceling" ? "Canceling export..." : props.audioOnly ? "Exporting audio..." : "Exporting video..."}
            </h4>
            <Show when={props.name}><p class="max-w-full truncate text-sm text-muted-foreground">{props.name}</p></Show>

            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={props.progress}
              aria-label="Export progress"
              class="mt-8 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
            >
              <div
                class="h-full rounded-full bg-primary transition-all"
                style={{ width: `${props.progress}%` }}
              />
            </div>
            <div class="mt-3 flex w-full justify-between text-xs tabular-nums">
              <span class="text-muted-foreground">{remaining()}</span>
              <span>{props.progress}%</span>
            </div>

            <Button
              variant="secondary"
              class="mt-8 px-3"
              onClick={() => setConfirming(true)}
              disabled={props.phase === "canceling"}
            >
              Cancel Export
            </Button>
          </div>
        </div>
      </Portal>

      <AlertDialog open={confirming()} onOpenChange={setConfirming}>
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop exporting?</AlertDialogTitle>
              <AlertDialogDescription>
                The export is still in progress. You'll need to start over if you stop now.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Continue
              </Button>
              <Button variant="destructive" onClick={confirmCancel}>
                Stop export
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </Show>
  );
}

/**
 * A draft an agent renders to check its own work. The editor keeps running and
 * stays usable, so this is a corner indicator that covers nothing else, not
 * the window-wide screen; a draft is a throwaway, so cancelling asks nothing.
 */
export function BackgroundExportProgress(props: ExportProgressProps) {
  return (
    <Show when={props.open}>
      <Portal>
        <div
          role="status"
          aria-live="polite"
          class="fixed bottom-4 right-4 z-40 flex w-64 flex-col gap-2 rounded-lg border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg"
        >
          <div class="flex items-center justify-between gap-3 text-xs">
            <span class="truncate">{props.phase === "canceling" ? "Canceling the draft..." : "Rendering a draft for review..."}</span>
            <span class="tabular-nums text-muted-foreground">{props.progress}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={props.progress}
            aria-label="Draft progress"
            class="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
          >
            <div class="h-full rounded-full bg-primary transition-all" style={{ width: `${props.progress}%` }} />
          </div>
          <div class="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span class="truncate">{props.name}</span>
            <button
              type="button"
              class="shrink-0 hover:text-foreground disabled:opacity-50"
              onClick={() => props.onCancel()}
              disabled={props.phase === "canceling"}
            >
              Cancel
            </button>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
