/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { Button } from "@/components/ui/button";
import { DashboardSurfaceSection } from "./shared";
import { downloaderActions, downloaderDetails } from "./downloader-settings-data";

import type { DownloaderStatus } from "@desktop/downloader/types";

/** Settings → Downloads: the managed yt-dlp behind media_search and media_download, with Check for update and Reinstall. */
export function DownloaderSettings() {
  const [status, setStatus] = createSignal<DownloaderStatus>();
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [running, setRunning] = createSignal<"check" | "reinstall" | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let alive = true;
  const actions = () => downloaderActions(status(), pending());
  const refresh = async () => {
    try {
      const value = await mainBridge.call(MAIN_CHANNELS.DOWNLOADER_STATUS, undefined);
      if (alive) setStatus(value);
    } catch {
      if (alive) setError("The downloader's status is unavailable in this preview.");
    }
  };
  onMount(() => {
    void refresh();
    timer = setInterval(() => { if (actions().busy) void refresh(); }, 2000);
  });
  onCleanup(() => { alive = false; clearInterval(timer); });

  const act = async (channel: typeof MAIN_CHANNELS.DOWNLOADER_CHECK | typeof MAIN_CHANNELS.DOWNLOADER_REINSTALL) => {
    if (actions().busy) return;
    setPending(true);
    setRunning(channel === MAIN_CHANNELS.DOWNLOADER_CHECK ? "check" : "reinstall");
    setError("");
    // The work is long (a download from GitHub): show its state meanwhile.
    void refresh();
    try {
      const value = await mainBridge.call(channel, undefined);
      if (alive) setStatus(value);
    } catch (thrown) {
      if (alive) setError(thrown instanceof Error ? thrown.message : "That didn't work. Try again.");
      await refresh();
    } finally {
      if (alive) { setPending(false); setRunning(null); }
    }
  };

  return <DashboardSurfaceSection title="Downloads"><div class="space-y-3">
    <p class="text-sm text-muted-foreground">Agents download songs, clips and sound effects from YouTube, SoundCloud, TikTok and similar sites with yt-dlp, which Blackout installs from yt-dlp's GitHub releases and verifies before use.</p>
    <p role="status" class="text-sm text-muted-foreground">{status()?.message ?? "Reading the downloader's status…"}</p>
    <Show when={status()}>{(current) => <For each={downloaderDetails(current())}>{(line) => <p class="text-xs text-muted-foreground">{line}</p>}</For>}</Show>
    <Show when={status()?.supported}>
      <div class="flex gap-2">
        <Button variant="outline" disabled={!actions().check} onClick={() => void act(MAIN_CHANNELS.DOWNLOADER_CHECK)}>
          {running() === "check" ? "Checking…" : "Check for update"}
        </Button>
        <Button variant="outline" disabled={!actions().reinstall} onClick={() => void act(MAIN_CHANNELS.DOWNLOADER_REINSTALL)}>
          {running() === "reinstall" || (!running() && status()?.state === "installing") ? "Installing…" : actions().reinstallLabel}
        </Button>
      </div>
    </Show>
    <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
  </div></DashboardSurfaceSection>;
}
