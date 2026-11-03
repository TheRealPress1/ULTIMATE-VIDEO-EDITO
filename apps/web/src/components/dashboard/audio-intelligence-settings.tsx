/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { Button } from "@/components/ui/button";
import { DashboardSurfaceSection } from "./shared";
import { audioIntelligenceLine, canInstallAudioIntelligence, canRemoveAudioIntelligence } from "./audio-intelligence-data";

import type { EarshotStatus } from "@desktop/addons/earshot/types";

/** Settings' line for audio intelligence (earshot): what it is doing, Install now, and Remove to free the space. */
export function AudioIntelligenceSettings() {
  const [status, setStatus] = createSignal<EarshotStatus>();
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let alive = true;
  const busy = () => pending() || status()?.state === "installing" || status()?.state === "removing";
  const refresh = async () => {
    try {
      const value = await mainBridge.call(MAIN_CHANNELS.EARSHOT_STATUS, undefined);
      if (alive) setStatus(value);
    } catch {
      if (alive) setError("Audio intelligence status is unavailable in this preview.");
    }
  };
  // Every 2 s while busy, every 6 s otherwise: an agent's first sound tool call starts the install without Settings.
  let ticks = 0;
  onMount(() => {
    void refresh();
    timer = setInterval(() => { if (busy() || ++ticks % 3 === 0) void refresh(); }, 2000);
  });
  onCleanup(() => { alive = false; clearInterval(timer); });

  const act = async (channel: typeof MAIN_CHANNELS.EARSHOT_INSTALL | typeof MAIN_CHANNELS.EARSHOT_REMOVE) => {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      const value = await mainBridge.call(channel, undefined);
      if (alive) setStatus(value);
    } catch (thrown) {
      if (alive) setError(thrown instanceof Error ? thrown.message : "That didn't work. Try again.");
      await refresh();
    } finally {
      if (alive) setPending(false);
    }
  };
  const canInstall = () => { const value = status(); return !!value && canInstallAudioIntelligence(value); };
  const canRemove = () => { const value = status(); return !!value && canRemoveAudioIntelligence(value); };

  return <DashboardSurfaceSection title="Audio intelligence"><div class="space-y-3">
    <p class="text-sm text-muted-foreground">Lets agents hear sound effects and music (earshot, MIT) and render sound effects from its bank.</p>
    <p role="status" class="text-sm text-muted-foreground">{status() ? audioIntelligenceLine(status()!) : "Reading status…"}</p>
    <div class="flex gap-2">
      <Show when={canInstall()}>
        <Button variant="outline" disabled={pending()} onClick={() => void act(MAIN_CHANNELS.EARSHOT_INSTALL)}>Install now</Button>
      </Show>
      <Show when={canRemove()}>
        <Button variant="outline" disabled={pending() || status()?.state === "removing"} onClick={() => void act(MAIN_CHANNELS.EARSHOT_REMOVE)}>Remove</Button>
      </Show>
    </div>
    <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
  </div></DashboardSurfaceSection>;
}
