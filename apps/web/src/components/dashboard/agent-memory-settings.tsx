/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createSignal, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Switch as Toggle, SwitchControl, SwitchInput, SwitchThumb } from "@/components/ui/switch";
import { DashboardSurfaceSection } from "./shared";
import { MEMORY_LISTS, historyLabel, originLabel, usageLine, usageRatio, usageTone, withheldLabel } from "./agent-memory-data";

import type { AgentMemoryApply, AgentMemoryEntryView, AgentMemoryHistoryItem, AgentMemorySnapshot, AgentMemoryTarget } from "@desktop/agent-memory-types";

const METER_TONES = { ok: "bg-emerald-500", near: "bg-amber-500", full: "bg-destructive" } as const;
const TEXTAREA = "w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Settings → What agents remember: the saved profile and setup notes, their budgets, the pause switch and earlier versions. */
export function AgentMemorySettings() {
  const [memory, setMemory] = createSignal<AgentMemorySnapshot | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<{ id: string; text: string } | null>(null);
  const [drafts, setDrafts] = createStore<Record<AgentMemoryTarget, string>>({ profile: "", setup: "" });
  const [showHistory, setShowHistory] = createSignal(false);

  const load = async () => {
    if (loading()) return;
    setLoading(true);
    setError(null);
    try {
      setMemory(await mainBridge.call(MAIN_CHANNELS.MEMORY_GET, undefined));
    } catch (thrown) {
      setError(messageOf(thrown, "Could not load what agents remember."));
    } finally { setLoading(false); }
  };
  onMount(() => { if (window.desktop) void load(); });

  /** Sends one change against the revision on screen; a refusal leaves the latest saved state on screen with the reason. */
  const apply = async (request: AgentMemoryApply, done: string): Promise<boolean> => {
    if (busy()) return false;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setMemory(await mainBridge.call(MAIN_CHANNELS.MEMORY_APPLY, request));
      setStatus(done);
      return true;
    } catch (thrown) {
      setError(messageOf(thrown, "That change was not saved."));
      try { setMemory(await mainBridge.call(MAIN_CHANNELS.MEMORY_GET, undefined)); } catch { /* keep what is on screen */ }
      return false;
    } finally { setBusy(false); }
  };

  const add = async (target: AgentMemoryTarget) => {
    const current = memory();
    const text = drafts[target].trim();
    if (!current || !text) return;
    if (await apply({ kind: "edit", expectedRevision: current.revision, operations: [{ action: "add", target, text }] }, "Saved. New chats will see it.")) setDrafts(target, "");
  };
  const save = async (target: AgentMemoryTarget) => {
    const current = memory();
    const edit = editing();
    if (!current || !edit) return;
    if (await apply({ kind: "edit", expectedRevision: current.revision, operations: [{ action: "replace", target, match: edit.id, text: edit.text }] }, "Saved. New chats will see it.")) setEditing(null);
  };
  const remove = (target: AgentMemoryTarget, entry: AgentMemoryEntryView) => {
    const current = memory();
    if (!current) return;
    void apply({ kind: "edit", expectedRevision: current.revision, operations: [{ action: "remove", target, match: entry.id }] }, "Deleted. You can bring it back from Earlier versions.");
  };
  const setEnabled = (enabled: boolean) => {
    const current = memory();
    if (!current) return;
    void apply({ kind: "enabled", expectedRevision: current.revision, enabled }, enabled ? "Agents remember again from the next chat." : "Paused. New chats start without these notes.");
  };
  const restore = (item: AgentMemoryHistoryItem) => {
    const current = memory();
    if (!current) return;
    void apply({ kind: "restore", expectedRevision: current.revision, historyId: item.id }, `Restored revision ${item.revision}. The version it replaced is kept too.`);
  };

  return (
    <section id="agent-memory" aria-label="What agents remember">
      <DashboardSurfaceSection title="What agents remember" description="Facts your agents keep about you and your setup, shared by Claude Code and Codex across chats and projects. Each new chat starts with them, and agents change them when you ask them to remember or forget something. How your edits look stays in your editing style.">
        <Show when={window.desktop} fallback={<p class="text-sm text-muted-foreground">Open the desktop app to see and edit what agents remember.</p>}>
          <Show when={memory()} fallback={
            <Show when={error()} fallback={<p class="text-sm text-muted-foreground">Loading…</p>}>
              <div role="alert" class="flex items-center gap-3 text-sm"><span>{error()}</span><Button variant="secondary" disabled={loading()} onClick={() => void load()}>Try again</Button></div>
            </Show>
          }>{(snapshot) => (
            <Show when={snapshot().available} fallback={<p class="text-sm text-muted-foreground">Memory is turned off for this session (CUTROOM_MEMORY=0): chats start without saved notes, and agents can't save any.</p>}>
              <div class="flex items-start justify-between gap-4">
                <div>
                  <p class="text-sm font-medium">Let agents remember</p>
                  <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{snapshot().enabled
                    ? "New chats start with these notes. Changes reach the next chat, not one already running."
                    : "Paused: new chats start without these notes, and agents can't change them or save new skills. Everything stays here, and skills you already saved stay available."}</p>
                </div>
                <Toggle checked={snapshot().enabled} disabled={busy()} onChange={setEnabled}>
                  <SwitchInput aria-label="Let agents remember" />
                  <SwitchControl><SwitchThumb /></SwitchControl>
                </Toggle>
              </div>

              <For each={MEMORY_LISTS}>{(list) => {
                const usage = () => snapshot().usage[list.target];
                const entries = () => snapshot()[list.target];
                return (
                  <div class="flex flex-col gap-2 border-t border-border pt-4">
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 class="text-sm font-medium">{list.title}</h3>
                      <span class="text-[11px] text-muted-foreground">{usageLine(usage())}</span>
                    </div>
                    <p class="text-xs leading-relaxed text-muted-foreground">{list.hint}</p>
                    <div role="meter" aria-label={`${list.title}: space used`} aria-valuemin={0} aria-valuemax={usage().limit} aria-valuenow={usage().chars} class="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div class={`h-full ${METER_TONES[usageTone(usage())]}`} style={{ width: `${Math.round(usageRatio(usage()) * 100)}%` }} />
                    </div>
                    <Show when={entries().length} fallback={<p class="text-xs text-muted-foreground">Nothing saved yet.</p>}>
                      <ul class="flex flex-col gap-2">
                        <For each={entries()}>{(entry) => (
                          <li class="rounded-md border border-border p-3">
                            <Show when={editing()?.id === entry.id} fallback={
                              <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                  <p class="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
                                  <p class="mt-1 text-[11px] text-muted-foreground">{originLabel(entry)}</p>
                                  <Show when={withheldLabel(entry)}>{(label) => <p class="mt-1 text-[11px] text-destructive">{label()}</p>}</Show>
                                </div>
                                <div class="flex shrink-0 gap-1">
                                  <Button variant="ghost" disabled={busy()} onClick={() => setEditing({ id: entry.id, text: entry.text })}>Edit</Button>
                                  <Button variant="ghost" disabled={busy()} onClick={() => remove(list.target, entry)}>Delete</Button>
                                </div>
                              </div>
                            }>
                              <div class="flex flex-col gap-2">
                                <textarea aria-label={`Edit ${list.title} entry`} rows={2} maxLength={snapshot().entryMax} value={editing()?.text ?? ""} disabled={busy()}
                                  onInput={(event) => setEditing({ id: entry.id, text: event.currentTarget.value })} class={TEXTAREA} />
                                <div class="flex flex-wrap items-center gap-2">
                                  <Button disabled={busy() || !editing()?.text.trim() || editing()?.text === entry.text} onClick={() => void save(list.target)}>{busy() ? "Saving…" : "Save"}</Button>
                                  <Button variant="ghost" disabled={busy()} onClick={() => setEditing(null)}>Cancel</Button>
                                  <span class="text-xs text-muted-foreground">{editing()?.text.length ?? 0}/{snapshot().entryMax}</span>
                                </div>
                              </div>
                            </Show>
                          </li>
                        )}</For>
                      </ul>
                    </Show>
                    <div class="flex items-start gap-2">
                      <textarea aria-label={`Add to ${list.title}`} rows={2} maxLength={snapshot().entryMax} value={drafts[list.target]} placeholder={list.placeholder} disabled={busy()}
                        onInput={(event) => setDrafts(list.target, event.currentTarget.value)} class={TEXTAREA} />
                      <Button variant="secondary" disabled={busy() || !drafts[list.target].trim()} onClick={() => void add(list.target)}>Add</Button>
                    </div>
                  </div>
                );
              }}</For>

              <div class="flex flex-col gap-2 border-t border-border pt-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p class="text-xs text-muted-foreground">Every change keeps the version it replaced (the last 50).</p>
                  <Button variant="ghost" aria-expanded={showHistory()} aria-controls="agent-memory-history" onClick={() => setShowHistory(!showHistory())}>
                    {showHistory() ? "Hide earlier versions" : `Earlier versions (${snapshot().history.length})`}
                  </Button>
                </div>
                <Show when={showHistory()}>
                  <div id="agent-memory-history">
                    <Show when={snapshot().history.length} fallback={<p class="text-xs text-muted-foreground">No earlier versions yet.</p>}>
                      <ul class="flex flex-col gap-1">
                        <For each={snapshot().history}>{(item) => (
                          <li class="flex items-center justify-between gap-3 text-xs">
                            <span class="text-muted-foreground">{historyLabel(item)}</span>
                            <Button variant="ghost" disabled={busy()} onClick={() => restore(item)}>Restore</Button>
                          </li>
                        )}</For>
                      </ul>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          )}</Show>
          <Show when={memory() && error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
          <Show when={status()}><p role="status" class="text-xs text-emerald-500">{status()}</p></Show>
        </Show>
      </DashboardSurfaceSection>
    </section>
  );
}
