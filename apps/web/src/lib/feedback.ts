/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal } from 'solid-js';

import { MAIN_CHANNELS } from '@desktop/main-channels';
import { store } from '@/init';
import { mainBridge } from '@/lib/ipc';
import { PUBLIC_ISSUES_URL, workspaceOf } from './feedback-data';

import type { FeedbackKind, FeedbackReport, FeedbackStatus } from '@desktop/feedback-types';

const [status, setStatus] = createSignal<FeedbackStatus | null>(null);

/** What main last said about feedback; null until asked, and in a preview that has no desktop app. */
export const feedbackStatus = status;

/** Settings adopts the status that Save, Remove and the like return, so the dialog and the menu agree with it. */
export const adoptFeedbackStatus = (next: FeedbackStatus): void => {
  setStatus(next);
};

export async function refreshFeedbackStatus(): Promise<FeedbackStatus | null> {
  try {
    const next = await mainBridge.call(MAIN_CHANNELS.FEEDBACK_STATUS, undefined);
    setStatus(next);
    return next;
  } catch {
    return null;
  }
}

export type FeedbackDialogState = {
  open: boolean;
  kind: FeedbackKind;
  /** The picture of the window taken before the dialog was on screen, or null when none could be. */
  screenshot: string | null;
  workspace: FeedbackReport['workspace'];
};

const [dialog, setDialog] = createSignal<FeedbackDialogState>({ open: false, kind: 'feedback', screenshot: null, workspace: null });

export const feedbackDialog = dialog;

export const closeFeedbackDialog = (): void => {
  setDialog((state) => ({ ...state, open: false }));
};

/** After a report is sent the picture is of an earlier moment, so the next one starts without it. */
export const dropFeedbackScreenshot = (): void => {
  setDialog((state) => ({ ...state, screenshot: null }));
};

function openPublicIssues(): void {
  if (window.desktop) void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: PUBLIC_ISSUES_URL }).catch(() => {});
  else window.open(PUBLIC_ISSUES_URL, '_blank', 'noopener');
}

/** The editor's workspace when the editor is what is showing; the stored layout value means nothing on the dashboard. */
const currentWorkspace = (): FeedbackReport['workspace'] =>
  window.location.hash.startsWith('#/projects/') ? workspaceOf(store.get<string>('layout.workspace')) : null;

/** Long enough for the menu or the palette that asked to finish closing, so the picture shows the app and not that. */
const SETTLE_MS = 250;

/**
 * "Report issue", anywhere: the feedback dialog when feedback is set up on this Mac, and the public issues page, as
 * it has always been, when it is not. The picture of the window is taken first, so the dialog is not in it.
 */
export async function startFeedback(kind: FeedbackKind = 'feedback'): Promise<void> {
  // Already up: a second picture would be of the dialog itself.
  if (dialog().open) return;

  const current = await refreshFeedbackStatus();
  if (!current?.configured) {
    openPublicIssues();
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const screenshot = await mainBridge.call(MAIN_CHANNELS.FEEDBACK_CAPTURE, undefined).catch(() => null);
  setDialog({ open: true, kind, screenshot, workspace: currentWorkspace() });
}
