/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The chat for the open project: header (tabs and actions), transcript,
// the question card when one is pending, and the composer at the bottom.
// The panel is a view over the module-level store; it can be unmounted
// (tab switch, page change) without touching a running turn.

import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { useProject } from "@/context/project";
import { downloadDesktopApp } from "@/lib/desktop-app";

import type { ModelRef } from "@diffusionstudio/agent-chat";

import { attachmentPaths } from "./attachments";
import { Composer } from "./composer";
import { EditReview } from "./edit-review";
import { HeaderActions } from "./header-actions";
import { QuestionCard } from "./question-card";
import { RecentChats } from "./recent-chats";
import { SidebarTabs } from "./sidebar-tabs";
import {
  activeChatId,
  blockedReason,
  chatState,
  clearDraft,
  currentModel,
  draft,
  draftKey,
  ensureConnected,
  interrupt,
  openChat,
  refreshChats,
  respond,
  restoreDraft,
  send,
  setActiveChat,
  setDraftAttachments,
  setDraftText,
  setStoredModel,
  storedModel,
  summaryOf,
  transcriptOf,
} from "./store";
import { Transcript } from "./transcript";

export function ChatPanel() {
  const project = useProject();
  ensureConnected();

  createEffect(() => void refreshChats(project.id()));

  const chatId = createMemo(() => activeChatId(project.id()));
  createEffect(() => {
    const id = chatId();
    if (id) openChat(id);
  });

  const transcript = createMemo(() => transcriptOf(chatId()));
  const summary = createMemo(() => summaryOf(project.id(), chatId()));
  const key = createMemo(() => draftKey(project.id(), chatId()));
  const current = createMemo(() => draft(key()));
  const optimistic = () => chatState.sending[key()] ?? null;
  const items = createMemo(() => {
    const pending = optimistic();
    return pending ? [...transcript().items, pending] : transcript().items;
  });

  const running = () => summary()?.status === "running" || summary()?.status === "waiting" || optimistic() !== null;
  const waiting = () => transcript().pending !== null;
  const empty = () => items().length === 0;

  // The composer's model: in a chat, one of that chat's harness; in a draft,
  // whatever is remembered and ready.
  const model = createMemo<ModelRef | null>(() => {
    const chat = summary();
    const remembered = storedModel();
    if (chat) return remembered && remembered.harness === chat.harness ? remembered : { harness: chat.harness, model: chat.model };
    return currentModel();
  });

  const [sendCount, setSendCount] = createSignal(0);

  const handleModel = (ref: ModelRef) => {
    setStoredModel(ref);
    const chat = summary();
    // A chat keeps its harness: another harness means a new draft, with the
    // typed text carried over.
    if (chat && chat.harness !== ref.harness && !empty()) {
      const previousKey = key();
      const carried = current();
      setActiveChat(project.id(), null);
      const next = draftKey(project.id(), null);
      setDraftText(next, carried.text);
      setDraftAttachments(next, carried.attachments);
      clearDraft(previousKey);
    }
  };

  const handleSend = () => {
    const ref = model();
    const { text, attachments } = current();
    if (!ref || (!text.trim() && attachments.length === 0)) return;
    const sendKey = key();
    clearDraft(sendKey);
    setSendCount((count) => count + 1);
    send({
      projectId: project.id(),
      cwd: project.dir(),
      chatId: chatId(),
      text,
      attachments: attachmentPaths(attachments),
      model: ref,
    }).catch((error: Error) => {
      // Nothing typed is lost: the draft comes back with the error.
      restoreDraft(sendKey, { text, attachments });
      toast.error("Could not send", { description: error.message });
    });
  };

  const handleStop = () => {
    const id = chatId();
    if (!id) return;
    interrupt(id).catch((error: Error) => toast.error("Could not stop", { description: error.message }));
  };

  const answer = (answers: Record<string, string[]> | "skip") => {
    const id = chatId();
    const request = transcript().pending;
    if (!id || !request) return;
    respond(id, request.id, answers === "skip" ? "skip" : { answers }).catch((error: Error) =>
      toast.error("Could not answer", { description: error.message }),
    );
  };

  return (
    <div class="flex flex-1 min-h-0 flex-col">
      <div class="flex h-12 shrink-0 items-center border-y border-border px-4 [[data-platform=win32]_&]:border-t-0">
        <SidebarTabs />
        <HeaderActions
          projectId={project.id()}
          chatId={chatId()}
          onNewChat={() => setActiveChat(project.id(), null)}
          onOpenChat={(id) => setActiveChat(project.id(), id)}
        />
      </div>

      <Transcript items={items()} sendCount={sendCount()} chatKey={chatId() ?? "draft"} running={running()} waiting={waiting()} />

      <Show when={transcript().pending}>
        {(request) => <QuestionCard request={request()} onSubmit={answer} onSkip={() => answer("skip")} />}
      </Show>

      <Show when={chatId() === null}>
        <RecentChats projectId={project.id()} onOpen={(id) => setActiveChat(project.id(), id)} />
      </Show>
      <Show when={chatState.connection === "unavailable"}>
        <div class="mx-4 mb-2 flex shrink-0 items-center justify-end">
          <Button variant="secondary" size="small" onClick={() => downloadDesktopApp("chat_panel")}>
            Get desktop app
          </Button>
        </div>
      </Show>

      <EditReview projectId={project.id()} cwd={project.dir()} running={running()} updatedAt={summary()?.updatedAt} />

      <Composer
        text={current().text}
        attachments={current().attachments}
        onText={(text) => setDraftText(key(), text)}
        onAttachments={(attachments) => setDraftAttachments(key(), attachments)}
        running={running()}
        waiting={waiting()}
        blocked={blockedReason()}
        model={model()}
        onModel={handleModel}
        onSend={handleSend}
        onStop={handleStop}
      />
    </div>
  );
}
