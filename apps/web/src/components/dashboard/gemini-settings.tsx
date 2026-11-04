/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { Button } from "@/components/ui/button";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { DashboardSurfaceSection } from "./shared";
import { GEMINI_DISCLOSURE, GEMINI_KEY_URL, GEMINI_PURPOSE, canSaveGeminiKey, canSaveGeminiModel, geminiLine } from "./gemini-data";

import type { GeminiStatus } from "@desktop/gemini/types";

/**
 * Settings' card for the optional Gemini connection: the user's own Google AI
 * Studio key, the model it asks, and, before any of that, what leaves the Mac
 * once a key is saved. The key goes to main and never comes back; this card
 * only ever sees its last four characters.
 */
export function GeminiSettings() {
  const [status, setStatus] = createSignal<GeminiStatus>();
  const [key, setKey] = createSignal("");
  const [model, setModel] = createSignal("");
  const [replacing, setReplacing] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  let alive = true;
  onCleanup(() => { alive = false; });

  /** Shows what main reports; the model field mirrors the choice, empty while it is the default. */
  const adopt = (next: GeminiStatus) => {
    if (!alive) return;
    setStatus(next);
    setModel(next.model === next.defaultModel ? "" : next.model);
  };
  onMount(async () => {
    try {
      adopt(await mainBridge.call(MAIN_CHANNELS.GEMINI_STATUS, undefined));
    } catch {
      if (alive) setError("Gemini's status is unavailable in this preview.");
    }
  });

  const act = async (work: () => Promise<GeminiStatus>, after?: () => void) => {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      adopt(await work());
      after?.();
    } catch (thrown) {
      if (alive) setError(thrown instanceof Error ? thrown.message : "That didn't work. Try again.");
    } finally {
      if (alive) setPending(false);
    }
  };
  const saveKey = () => void act(() => mainBridge.call(MAIN_CHANNELS.GEMINI_UPDATE, { key: key() }), () => { setKey(""); setReplacing(false); });
  const saveModel = () => void act(() => mainBridge.call(MAIN_CHANNELS.GEMINI_UPDATE, { model: model() }));
  const remove = () => void act(() => mainBridge.call(MAIN_CHANNELS.GEMINI_CLEAR, undefined), () => { setKey(""); setReplacing(false); });
  const cancelReplace = () => { setKey(""); setReplacing(false); setError(""); };
  const openKeyPage = () => void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: GEMINI_KEY_URL }).catch(() => { if (alive) setError("The page could not open. Go to aistudio.google.com/apikey."); });

  const configured = () => !!status()?.configured;
  const keyField = () => !!status()?.encryption && (!configured() || replacing());

  return <DashboardSurfaceSection title="Gemini (optional)"><div class="space-y-3">
    <p class="text-sm text-muted-foreground">{GEMINI_PURPOSE}</p>
    <p class="text-sm text-muted-foreground">{GEMINI_DISCLOSURE}</p>
    <p role="status" class="text-sm">{status() ? geminiLine(status()!) : "Reading status…"}</p>

    <Show when={keyField()}>
      <TextField>
        <TextFieldLabel uiSize="compact" class="text-muted-foreground">Google AI Studio key</TextFieldLabel>
        <TextFieldInput
          uiSize="compact"
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder="Paste your key"
          value={key()}
          onInput={(event) => setKey(event.currentTarget.value)}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        />
      </TextField>
    </Show>
    <div class="flex flex-wrap gap-2">
      <Show when={keyField()}>
        <Button variant="outline" disabled={pending() || !canSaveGeminiKey(key(), status())} onClick={saveKey}>Save key</Button>
      </Show>
      <Show when={replacing()}>
        <Button variant="outline" disabled={pending()} onClick={cancelReplace}>Cancel</Button>
      </Show>
      <Show when={configured() && !replacing()}>
        <Button variant="outline" disabled={pending()} onClick={() => { setError(""); setReplacing(true); }}>Replace key</Button>
      </Show>
      <Show when={configured()}>
        <Button variant="outline" disabled={pending()} onClick={remove}>Remove key</Button>
      </Show>
      <Show when={!configured()}>
        <Button variant="outline" onClick={openKeyPage}>Get a key</Button>
      </Show>
    </div>

    <Show when={status()}>
      <div class="flex items-end gap-2">
        <TextField class="flex-1">
          <TextFieldLabel uiSize="compact" class="text-muted-foreground">Model (default {status()!.defaultModel})</TextFieldLabel>
          <TextFieldInput
            uiSize="compact"
            spellcheck={false}
            placeholder={status()!.defaultModel}
            value={model()}
            onInput={(event) => setModel(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
          />
        </TextField>
        <Button variant="outline" disabled={pending() || !canSaveGeminiModel(model(), status())} onClick={saveModel}>Save model</Button>
      </div>
    </Show>
    <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
  </div></DashboardSurfaceSection>;
}
