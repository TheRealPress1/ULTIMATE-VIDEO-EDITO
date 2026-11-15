/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { Button } from "@/components/ui/button";
import { TextField, TextFieldInput, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";
import { adoptFeedbackStatus, feedbackStatus, refreshFeedbackStatus, startFeedback } from "@/lib/feedback";
import {
  DEFAULT_FEEDBACK_REPO,
  FEEDBACK_DISCLOSURE,
  FEEDBACK_PURPOSE,
  TEXT_MAX,
  canReply,
  canSaveConfig,
  commentAuthor,
  connectionLine,
  readableBody,
  reportMeta,
  statusLine,
  toConfigInput,
  when,
} from "@/lib/feedback-data";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { DashboardSurfaceSection } from "./shared";

import type {
  FeedbackComment,
  FeedbackConnection,
  FeedbackListItem,
  FeedbackStatus,
  FeedbackThread,
} from "@desktop/feedback-types";

const fail = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : "That didn't work. Try again.");

/** Typing in a field belongs to the field: the editor's shortcuts must not hear it. */
const keepKeys = (event: KeyboardEvent) => event.stopPropagation();

/** One report opened: what was written, and the replies, with a box to answer in. */
function ReportThread(props: { number: number }) {
  const [thread, setThread] = createSignal<FeedbackThread>();
  const [replies, setReplies] = createSignal<FeedbackComment[]>([]);
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  onMount(async () => {
    try {
      const loaded = await mainBridge.call(MAIN_CHANNELS.FEEDBACK_THREAD, { number: props.number });
      if (!alive) return;
      setThread(loaded);
      setReplies(loaded.comments);
    } catch (thrown) {
      if (alive) setError(fail(thrown));
    }
  });

  const reply = async () => {
    if (pending() || !canReply(text())) return;
    setPending(true);
    setError("");
    try {
      const comment = await mainBridge.call(MAIN_CHANNELS.FEEDBACK_REPLY, { number: props.number, text: text() });
      if (!alive) return;
      setReplies((list) => [...list, comment]);
      setText("");
    } catch (thrown) {
      if (alive) setError(fail(thrown));
    } finally {
      if (alive) setPending(false);
    }
  };

  return (
    <div class="grid gap-3 border-t pt-3">
      <Show when={thread()} fallback={<p class="text-xs text-muted-foreground">{error() || "Reading the report…"}</p>}>
        {(loaded) => (
          <>
            <pre class="whitespace-pre-wrap break-words font-sans text-xs">{readableBody(loaded().body)}</pre>
            <For each={replies()}>
              {(comment) => (
                <div class="grid gap-1 rounded-md bg-input px-3 py-2">
                  <p class="text-xxs text-muted-foreground">
                    {commentAuthor(comment)} · {when(comment.createdAt)}
                  </p>
                  <p class="whitespace-pre-wrap break-words text-xs">{comment.body}</p>
                </div>
              )}
            </For>
            <TextField>
              <TextFieldLabel uiSize="compact" class="text-muted-foreground">
                Reply
              </TextFieldLabel>
              <TextFieldTextArea
                class="text-xs"
                rows={2}
                maxLength={TEXT_MAX}
                spellcheck
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={keepKeys}
                onKeyUp={keepKeys}
              />
            </TextField>
            <div class="flex items-center gap-2">
              <Button variant="outline" disabled={pending() || !canReply(text())} onClick={() => void reply()}>
                {pending() ? "Sending…" : "Send reply"}
              </Button>
              <Show when={error()}>
                <p role="alert" class="text-xs text-destructive">
                  {error()}
                </p>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

/** The reports sent from this Mac and the others in the repository, newest activity first. */
function FeedbackReports(props: { repo: string }) {
  const [items, setItems] = createSignal<FeedbackListItem[]>();
  const [open, setOpen] = createSignal<number>();
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  const load = async () => {
    if (loading()) return;
    setLoading(true);
    setError("");
    try {
      const list = await mainBridge.call(MAIN_CHANNELS.FEEDBACK_LIST, undefined);
      if (alive) setItems(list);
    } catch (thrown) {
      if (alive) setError(fail(thrown));
    } finally {
      if (alive) setLoading(false);
    }
  };
  onMount(() => void load());

  return (
    <div class="grid gap-2">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm">
          Reports <span class="text-xs text-muted-foreground">in {props.repo}</span>
        </p>
        <Button variant="outline" disabled={loading()} onClick={() => void load()}>
          {loading() ? "Reading…" : "Refresh"}
        </Button>
      </div>
      <Show when={error()}>
        <p role="alert" class="text-sm text-destructive">
          {error()}
        </p>
      </Show>
      <Show when={items()}>
        {(list) => (
          <Show when={list().length} fallback={<p class="text-xs text-muted-foreground">No reports yet.</p>}>
            <div class="grid gap-1">
              <For each={list()}>
                {(item) => (
                  <div class="rounded-md border px-3 py-2">
                    <button
                      type="button"
                      class="flex w-full flex-col items-start gap-1 text-left outline-none focus-ring"
                      aria-expanded={open() === item.number}
                      onClick={() => setOpen((current) => (current === item.number ? undefined : item.number))}
                    >
                      <span class="text-xs">
                        #{item.number} {item.title}
                      </span>
                      <span class="text-xxs text-muted-foreground">{reportMeta(item)}</span>
                    </button>
                    <Show when={open() === item.number}>
                      <ReportThread number={item.number} />
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}

/**
 * Settings' card for feedback: whose reports these are, which repository they go to and the access key that lets them
 * in, then the reports themselves with their replies. The key goes to main and never comes back; this card only
 * learns whether one is saved. "Report issue" anywhere in the app opens the dialog once this is filled in.
 */
export function FeedbackSettings() {
  const [reporter, setReporter] = createSignal("");
  const [repo, setRepo] = createSignal(DEFAULT_FEEDBACK_REPO);
  const [key, setKey] = createSignal("");
  const [replacing, setReplacing] = createSignal(false);
  const [connection, setConnection] = createSignal<FeedbackConnection>();
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  /** The fields mirror what is saved; the repository starts from the usual one while nothing is. */
  const seed = (next: FeedbackStatus) => {
    setReporter(next.reporter ?? "");
    setRepo(next.repo ?? DEFAULT_FEEDBACK_REPO);
  };

  onMount(async () => {
    const next = await refreshFeedbackStatus();
    if (!alive) return;
    if (next) seed(next);
    else setError("Feedback is unavailable in this preview.");
  });

  const form = () => ({ reporter: reporter(), repo: repo(), key: key() });
  const status = feedbackStatus;
  const configured = () => !!status()?.configured;
  const keyField = () => !!status()?.secureStorage && (!status()?.hasKey || replacing());

  /** Runs a change main answers with the new status; the dialog and the menus adopt it too. */
  const act = async (work: () => Promise<FeedbackStatus>, after?: () => void) => {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      const next = await work();
      adoptFeedbackStatus(next);
      if (alive) {
        seed(next);
        after?.();
      }
    } catch (thrown) {
      if (alive) setError(fail(thrown));
    } finally {
      if (alive) setPending(false);
    }
  };

  const clearTyped = () => {
    setKey("");
    setReplacing(false);
    setConnection(undefined);
  };
  const save = () => void act(() => mainBridge.call(MAIN_CHANNELS.FEEDBACK_SAVE, toConfigInput(form())), clearTyped);
  const removeKey = () => void act(() => mainBridge.call(MAIN_CHANNELS.FEEDBACK_CLEAR_KEY, undefined), clearTyped);
  const cancelReplace = () => {
    setKey("");
    setReplacing(false);
    setError("");
  };

  const test = async () => {
    if (pending()) return;
    setPending(true);
    setError("");
    setConnection(undefined);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.FEEDBACK_TEST, undefined);
      if (alive) setConnection(result);
    } catch (thrown) {
      if (alive) setError(fail(thrown));
    } finally {
      if (alive) setPending(false);
    }
  };

  return (
    <DashboardSurfaceSection title="Feedback">
      <div class="space-y-3">
        <p class="text-sm text-muted-foreground">{FEEDBACK_PURPOSE}</p>
        <p class="text-sm text-muted-foreground">{FEEDBACK_DISCLOSURE}</p>
        <p role="status" class="text-sm">
          {statusLine(status())}
        </p>

        <Show when={status()}>
          <TextField>
            <TextFieldLabel uiSize="compact" class="text-muted-foreground">
              Your name
            </TextFieldLabel>
            <TextFieldInput
              uiSize="compact"
              autocomplete="off"
              maxLength={40}
              placeholder="So the replies know who they are for"
              value={reporter()}
              onInput={(event) => setReporter(event.currentTarget.value)}
              onKeyDown={keepKeys}
              onKeyUp={keepKeys}
            />
          </TextField>
          <TextField>
            <TextFieldLabel uiSize="compact" class="text-muted-foreground">
              Repository
            </TextFieldLabel>
            <TextFieldInput
              uiSize="compact"
              autocomplete="off"
              spellcheck={false}
              placeholder={DEFAULT_FEEDBACK_REPO}
              value={repo()}
              onInput={(event) => setRepo(event.currentTarget.value)}
              onKeyDown={keepKeys}
              onKeyUp={keepKeys}
            />
          </TextField>
          <Show when={keyField()}>
            <TextField>
              <TextFieldLabel uiSize="compact" class="text-muted-foreground">
                Access key
              </TextFieldLabel>
              <TextFieldInput
                uiSize="compact"
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="Paste the key you were given"
                value={key()}
                onInput={(event) => setKey(event.currentTarget.value)}
                onKeyDown={keepKeys}
                onKeyUp={keepKeys}
              />
            </TextField>
          </Show>
        </Show>

        <div class="flex flex-wrap gap-2">
          <Show when={status()}>
            <Button variant="outline" disabled={pending() || !canSaveConfig(form(), status())} onClick={save}>
              Save
            </Button>
          </Show>
          <Show when={replacing()}>
            <Button variant="outline" disabled={pending()} onClick={cancelReplace}>
              Cancel
            </Button>
          </Show>
          <Show when={status()?.hasKey && !replacing()}>
            <Button
              variant="outline"
              disabled={pending()}
              onClick={() => {
                setError("");
                setReplacing(true);
              }}
            >
              Replace key
            </Button>
          </Show>
          <Show when={status()?.hasKey}>
            <Button variant="outline" disabled={pending()} onClick={removeKey}>
              Remove key
            </Button>
          </Show>
          <Show when={configured()}>
            <Button variant="outline" disabled={pending()} onClick={() => void test()}>
              Test connection
            </Button>
            <Button variant="outline" disabled={pending()} onClick={() => void startFeedback("feedback")}>
              Send feedback…
            </Button>
          </Show>
        </div>

        <Show when={connection()}>
          {(result) => (
            <p role="status" class={connectionLine(result()).ok ? "text-sm" : "text-sm text-destructive"}>
              {connectionLine(result()).text}
            </p>
          )}
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-sm text-destructive">
            {error()}
          </p>
        </Show>

        {/* Keyed on the saved repository (the callback must take it, or Solid never rebuilds): pointing Settings at another one lists that one's reports, not the old list. */}
        <Show when={configured() ? status()?.repo : null} keyed>
          {(repository) => <FeedbackReports repo={repository} />}
        </Show>
      </div>
    </DashboardSurfaceSection>
  );
}
