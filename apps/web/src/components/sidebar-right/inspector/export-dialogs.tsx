/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createMemo, createSignal } from "solid-js";
import { computeOutputSize } from "@diffusionstudio/encoder";
import { toast } from "somoto";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { revealPath } from "@/lib/shell";
import { formatDuration } from "@/utils/formatters";
import type { CompletedExport, ExportConfig } from "@/context/render";

type ExportSetupProps = {
  config: ExportConfig;
  width: number;
  height: number;
  duration: number;
  fps: number;
  onClose: () => void;
  onExport: (config: ExportConfig) => void;
};

/** The final review before choosing a file, shared by header, menu and shortcuts. */
export function ExportSetup(props: ExportSetupProps) {
  const [resolution, setResolution] = createSignal(props.config.video?.resolution ?? 1080);
  const [audio, setAudio] = createSignal(props.config.audio?.enabled !== false);
  const audioOnly = () => props.config.format === "ogg" || props.config.video?.enabled === false;
  const resolutions = createMemo(() => [...new Set([720, 1080, 1440, 2160, Math.min(props.width, props.height), resolution()])].sort((a, b) => a - b));
  const size = () => computeOutputSize(props.width, props.height, resolution());
  const format = () => (props.config.format ?? "mp4").toUpperCase();
  const exportFile = () => props.onExport({
    ...props.config,
    video: { ...props.config.video, resolution: resolution() },
    audio: { ...props.config.audio, enabled: audio() },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPortal>
        <DialogContent class="sm:max-w-md">
          <DialogHeader>
            <DialogTitle class="text-base">Export {audioOnly() ? "audio" : "video"}</DialogTitle>
            <DialogDescription>Review your output, then choose where to save it.</DialogDescription>
          </DialogHeader>
          <div class="space-y-4 py-2 text-sm">
            <div class="flex justify-between"><span class="text-muted-foreground">Duration</span><span>{formatDuration(props.duration)}</span></div>
            <div class="flex justify-between"><span class="text-muted-foreground">Format</span><span>{format()}{audioOnly() ? " · Audio only" : ` · ${(props.config.video?.codec ?? "avc") === "avc" ? "H.264" : (props.config.video?.codec ?? "avc").toUpperCase()}`}</span></div>
            <Show when={!audioOnly()}>
              <label class="flex items-center justify-between gap-4">
                <span class="text-muted-foreground">Resolution</span>
                <select aria-label="Export resolution" class="rounded-md border bg-background px-3 py-2 text-sm" value={resolution()} onChange={(event) => setResolution(Number(event.currentTarget.value))}>
                  <For each={resolutions()}>{(value) => {
                    const output = () => computeOutputSize(props.width, props.height, value);
                    return <option value={value}>{output().width} × {output().height}{value === Math.min(props.width, props.height) ? " · Original" : value === 2160 ? " · 4K" : ""}</option>;
                  }}</For>
                </select>
              </label>
              <div class="flex justify-between"><span class="text-muted-foreground">Frame rate</span><span>{props.config.video?.fps ?? props.fps} fps</span></div>
              <Show when={size().width > props.width || size().height > props.height}>
                <p class="text-xs text-muted-foreground">This enlarges your {props.width} × {props.height} scene. Choose Original to keep its current size.</p>
              </Show>
            </Show>
            <label class="flex items-center justify-between"><span class="text-muted-foreground">Include audio</span><input type="checkbox" class="size-4 accent-primary" checked={audio()} onChange={(event) => setAudio(event.currentTarget.checked)} /></label>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
            <Button onClick={exportFile} disabled={props.duration <= 0 || (audioOnly() && !audio())}>Choose location &amp; export</Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

export function ExportComplete(props: { result: CompletedExport; onClose: () => void }) {
  const showFile = async () => {
    try {
      await revealPath(props.result.path!);
    } catch (error) {
      toast.error("Could not show the exported file", { description: (error as Error).message });
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPortal>
        <DialogContent class="sm:max-w-md">
          <DialogHeader>
            <DialogTitle class="text-base">Export complete</DialogTitle>
            <DialogDescription>Your file is saved and ready to share.</DialogDescription>
          </DialogHeader>
          <div class="rounded-lg border bg-muted/30 p-4">
            <p class="break-all text-sm font-medium">{props.result.name}</p>
            <p class="mt-1 text-xs text-muted-foreground">{props.result.format.toUpperCase()} · {props.result.width ? `${props.result.width} × ${props.result.height} · ` : ""}{formatDuration(props.result.duration)}</p>
            <Show when={props.result.path}><p class="mt-3 select-text break-all text-xs text-muted-foreground">{props.result.path}</p></Show>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={props.onClose}>Back to editor</Button>
            <Show when={window.desktop && props.result.path}><Button onClick={showFile}>Show in {navigator.platform.includes("Mac") ? "Finder" : "folder"}</Button></Show>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
