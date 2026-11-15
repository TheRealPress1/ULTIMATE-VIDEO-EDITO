/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectPortal,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TextField, TextFieldInput, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";
import { closeFeedbackDialog, dropFeedbackScreenshot, feedbackDialog, feedbackStatus, startFeedback } from "@/lib/feedback";
import {
  AREA_CHOICES,
  DIALOG_TITLE,
  IMPACT_CHOICES,
  IMPORTANCE_CHOICES,
  TEXT_MAX,
  TITLE_MAX,
  dialogDescription,
  emptyDraft,
  fieldsFor,
  hasUnsentText,
  missing,
  sentWithReport,
  submittedMessage,
  toReport,
} from "@/lib/feedback-data";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";

import type { Choice, Draft } from "@/lib/feedback-data";
import type { FeedbackKind, FeedbackSubmitResult } from "@desktop/feedback-types";

/**
 * What was typed stays across closing and opening the dialog until it is sent: a stray click outside, or Esc, must
 * not cost a tester the paragraph they just wrote.
 */
const [draft, setDraft] = createSignal<Draft>(emptyDraft());

const KINDS: readonly Choice<FeedbackKind>[] = [
  { id: "feedback", label: "Feedback" },
  { id: "idea", label: "Idea" },
];

/** Typing in a field belongs to the field: the editor's shortcuts must not hear it. */
const keepKeys = (event: KeyboardEvent) => event.stopPropagation();

function ChoiceSelect<T extends string>(props: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange(value: T): void;
}) {
  return (
    <div class="grid gap-2">
      <span class="text-xs">{props.label}</span>
      <Select<Choice<T>>
        options={[...props.options]}
        value={props.options.find((option) => option.id === props.value)}
        onChange={(option) => option && props.onChange(option.id)}
        optionValue="id"
        optionTextValue="label"
        itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue.label}</SelectItem>}
      >
        <SelectTrigger aria-label={props.label}>
          <SelectValue<Choice<T>>>{(state) => state.selectedOption()?.label}</SelectValue>
        </SelectTrigger>
        <SelectPortal>
          <SelectContent />
        </SelectPortal>
      </Select>
    </div>
  );
}

/**
 * "Send feedback": the one place a problem or an idea is written down. It is mounted once at the app's root and opened
 * with `startFeedback` (the Help menus, the palette, Settings), which takes the picture of the window first.
 */
export function FeedbackDialog() {
  const [keepShot, setKeepShot] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [sent, setSent] = createSignal<FeedbackSubmitResult>();

  // The native Help > Send Feedback… asks this window for the form.
  onMount(() => onCleanup(mainBridge.handle(MAIN_CHANNELS.FEEDBACK_REQUEST, () => void startFeedback("feedback"))));

  // Each time it comes up: a picture to keep, no old message, and the kind that was asked for unless a draft is kept.
  createEffect(
    on(
      () => feedbackDialog().open,
      (open) => {
        if (!open) return;
        setKeepShot(true);
        setError("");
        setSent(undefined);
        if (!hasUnsentText(draft())) setDraft(emptyDraft(feedbackDialog().kind));
      },
    ),
  );

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  // The questions depend on the kind alone. Read from the whole draft they would be rebuilt on every keystroke, and
  // the field being typed in would lose focus after each character.
  const kind = createMemo(() => draft().kind);
  const fields = createMemo(() => fieldsFor(kind()));
  const problem = () => missing(draft());
  const screenshot = () => feedbackDialog().screenshot;

  const send = async () => {
    if (busy() || problem()) return;
    setBusy(true);
    setError("");
    try {
      const state = feedbackDialog();
      const result = await mainBridge.call(
        MAIN_CHANNELS.FEEDBACK_SUBMIT,
        toReport(draft(), keepShot() ? state.screenshot : null, state.workspace),
      );
      setSent(result);
      setDraft(emptyDraft(draft().kind));
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const another = () => {
    dropFeedbackScreenshot();
    setSent(undefined);
    setError("");
  };

  const fieldKeys = (event: KeyboardEvent) => {
    keepKeys(event);
    if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
  };

  return (
    <Dialog
      open={feedbackDialog().open}
      onOpenChange={(open) => {
        if (!open && !busy()) closeFeedbackDialog();
      }}
    >
      <DialogPortal>
        <DialogContent
          class="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
          onInteractOutside={(event) => {
            if (busy() || hasUnsentText(draft())) event.preventDefault();
          }}
        >
          <DialogHeader class="px-6 pt-6 pb-4">
            <DialogTitle>{DIALOG_TITLE}</DialogTitle>
            <DialogDescription>{dialogDescription({ repo: feedbackStatus()?.repo ?? null })}</DialogDescription>
          </DialogHeader>

          <Show
            when={sent()}
            fallback={
              <>
                <div class="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-6 pb-4">
                  <div class="flex gap-2" role="group" aria-label="What kind of report">
                    <For each={KINDS}>
                      {(choice) => (
                        <Button
                          variant={kind() === choice.id ? "on" : "secondary"}
                          aria-pressed={kind() === choice.id}
                          disabled={busy()}
                          onClick={() => update({ kind: choice.id })}
                        >
                          {choice.label}
                        </Button>
                      )}
                    </For>
                  </div>

                  <TextField>
                    <TextFieldLabel uiSize="compact">A short title</TextFieldLabel>
                    <TextFieldInput
                      uiSize="compact"
                      spellcheck
                      maxLength={TITLE_MAX}
                      placeholder={kind() === "idea" ? "Slip and slide tools" : "The razor cuts one frame late"}
                      value={draft().title}
                      onInput={(event) => update({ title: event.currentTarget.value })}
                      onKeyDown={fieldKeys}
                      onKeyUp={keepKeys}
                    />
                  </TextField>

                  <ChoiceSelect label="Where in Blackout?" value={draft().area} options={AREA_CHOICES} onChange={(area) => update({ area })} />

                  <For each={fields()}>
                    {(field) => (
                      <TextField>
                        <TextFieldLabel uiSize="compact">
                          {field.label}
                          {field.required ? "" : " (optional)"}
                        </TextFieldLabel>
                        <Show when={field.hint}>
                          <p class="text-xxs text-muted-foreground">{field.hint}</p>
                        </Show>
                        <TextFieldTextArea
                          class="text-xs"
                          rows={field.rows}
                          maxLength={TEXT_MAX}
                          spellcheck
                          value={draft()[field.key]}
                          onInput={(event) => update({ [field.key]: event.currentTarget.value })}
                          onKeyDown={fieldKeys}
                          onKeyUp={keepKeys}
                        />
                      </TextField>
                    )}
                  </For>

                  <Show
                    when={kind() === "idea"}
                    fallback={
                      <ChoiceSelect
                        label="How much does it get in your way?"
                        value={draft().impact}
                        options={IMPACT_CHOICES}
                        onChange={(impact) => update({ impact })}
                      />
                    }
                  >
                    <ChoiceSelect
                      label="How much does it matter to you?"
                      value={draft().importance}
                      options={IMPORTANCE_CHOICES}
                      onChange={(importance) => update({ importance })}
                    />
                  </Show>

                  <p class="text-xxs text-muted-foreground">
                    {sentWithReport(feedbackStatus()?.reporter ?? null, APP_VERSION, !!screenshot() && keepShot())}
                  </p>

                  <Show when={screenshot()}>
                    {(picture) => (
                      <Show
                        when={keepShot()}
                        fallback={
                          <div class="flex items-center justify-between gap-2">
                            <span class="text-xs text-muted-foreground">No screenshot will be sent.</span>
                            <Button variant="outline" disabled={busy()} onClick={() => setKeepShot(true)}>
                              Add it back
                            </Button>
                          </div>
                        }
                      >
                        <div class="grid gap-2">
                          <img
                            src={picture()}
                            alt="The Blackout window as it was when you asked to send feedback"
                            class="max-h-44 w-full rounded-md border bg-black/40 object-contain"
                          />
                          <div class="flex items-center justify-between gap-2">
                            <span class="text-xs text-muted-foreground">The app window, taken just before this opened.</span>
                            <Button variant="outline" disabled={busy()} onClick={() => setKeepShot(false)}>
                              Remove
                            </Button>
                          </div>
                        </div>
                      </Show>
                    )}
                  </Show>

                </div>

                {/* Fixed under the scrolling form, so Send, and what went wrong with it, are in view however long the form is. */}
                <DialogFooter class="items-center gap-3 border-t px-6 py-4">
                  <Show
                    when={error()}
                    fallback={
                      <Show when={!busy() && problem()}>
                        <span class="mr-auto text-xs text-muted-foreground">{problem()}</span>
                      </Show>
                    }
                  >
                    <p role="alert" class="mr-auto text-xs text-destructive">
                      {error()}
                    </p>
                  </Show>
                  <Button variant="outline" disabled={busy()} onClick={closeFeedbackDialog}>
                    Cancel
                  </Button>
                  <Button disabled={busy() || !!problem()} onClick={() => void send()}>
                    {busy() ? "Sending…" : "Send"}
                  </Button>
                </DialogFooter>
              </>
            }
          >
            {(result) => (
              <div class="grid gap-4 px-6 pb-6">
                <p role="status" class="text-sm">
                  {submittedMessage(result())}
                </p>
                <p class="text-xs text-muted-foreground">
                  Follow it, and read the replies, in Settings → Feedback.
                </p>
                <DialogFooter>
                  <Button variant="outline" onClick={another}>
                    Send another
                  </Button>
                  <Button onClick={closeFeedbackDialog}>Close</Button>
                </DialogFooter>
              </div>
            )}
          </Show>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
