/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What the feedback dialog and Settings' Feedback card say and decide, apart from drawing it: the words for each kind
 * of report, what is still missing before one can go, how a draft becomes the report main sends, and the lines
 * Settings shows about the connection and the reports. Components are not rendered in tests, so this is where it is tested.
 */

import {
  FEEDBACK_AREAS,
  FEEDBACK_AREA_LABELS,
  FEEDBACK_IMPACTS,
  FEEDBACK_IMPACT_LABELS,
  FEEDBACK_IMPORTANCES,
  FEEDBACK_IMPORTANCE_LABELS,
} from '@desktop/feedback-types';

import type {
  FeedbackArea,
  FeedbackComment,
  FeedbackConfigInput,
  FeedbackConnection,
  FeedbackImpact,
  FeedbackImportance,
  FeedbackKind,
  FeedbackListItem,
  FeedbackReport,
  FeedbackStatus,
  FeedbackSubmitResult,
} from '@desktop/feedback-types';

/** Where "Report issue" has always gone, and still goes when feedback is not set up on this Mac. */
export const PUBLIC_ISSUES_URL = 'https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO/issues';

/** Where reports go until Settings says otherwise: the private repository the testers and the owner both read. */
export const DEFAULT_FEEDBACK_REPO = 'TheRealPress1/blackout-feedback';

export const TITLE_MAX = 120;
export const TEXT_MAX = 8000;

export type Draft = {
  kind: FeedbackKind;
  title: string;
  area: FeedbackArea;
  doing: string;
  happened: string;
  expected: string;
  why: string;
  impact: FeedbackImpact;
  importance: FeedbackImportance;
};

export const emptyDraft = (kind: FeedbackKind = 'feedback'): Draft => ({
  kind,
  title: '',
  area: 'timeline',
  doing: '',
  happened: '',
  expected: '',
  why: '',
  impact: 'slows-me-down',
  importance: 'changes-my-work',
});

export type FieldKey = 'doing' | 'happened' | 'expected' | 'why';
export type FieldSpec = { key: FieldKey; label: string; hint: string; required: boolean; rows: number };

/** The questions of each kind, worded the way the repository's forms word them. */
export function fieldsFor(kind: FeedbackKind): FieldSpec[] {
  if (kind === 'idea') {
    return [
      { key: 'doing', label: 'What would you want to be able to do?', hint: 'Describe it the way you would to an assistant editor.', required: true, rows: 3 },
      { key: 'expected', label: 'How do you do it today in Premiere (or your other tool)?', hint: 'Tools, shortcuts, panels, the steps you take.', required: true, rows: 3 },
      { key: 'why', label: 'Why does it matter in a real edit?', hint: 'How often you need it, and what it costs you without it.', required: false, rows: 2 },
    ];
  }
  return [
    { key: 'doing', label: 'What were you trying to do?', hint: 'In your own words: what was the edit you wanted to make?', required: true, rows: 3 },
    { key: 'happened', label: 'What happened?', hint: '', required: true, rows: 3 },
    { key: 'expected', label: 'What did you expect, or what does Premiere do here?', hint: 'The shortcut, tool or behavior you would reach for in Premiere. This is the most useful answer.', required: true, rows: 3 },
  ];
}

/** What is still missing before the report can be sent, as a sentence for the person, or null when it can go. */
export function missing(draft: Draft): string | null {
  if (!draft.title.trim()) return 'Give it a short title.';
  for (const field of fieldsFor(draft.kind)) {
    if (field.required && !draft[field.key].trim()) return `Fill in "${field.label}".`;
  }
  return null;
}

/** The report main sends: trimmed, and with what does not belong to the kind left out. */
export function toReport(draft: Draft, screenshot: string | null, workspace: FeedbackReport['workspace']): FeedbackReport {
  const idea = draft.kind === 'idea';
  return {
    kind: draft.kind,
    title: draft.title.trim(),
    area: draft.area,
    doing: draft.doing.trim(),
    happened: idea ? '' : draft.happened.trim(),
    expected: draft.expected.trim(),
    why: idea ? draft.why.trim() : '',
    impact: idea ? 'small' : draft.impact,
    importance: idea ? draft.importance : 'nice-to-have',
    workspace,
    screenshot,
  };
}

export type Choice<T extends string> = { id: T; label: string };

export const AREA_CHOICES: readonly Choice<FeedbackArea>[] = FEEDBACK_AREAS.map((id) => ({ id, label: FEEDBACK_AREA_LABELS[id] }));
export const IMPACT_CHOICES: readonly Choice<FeedbackImpact>[] = FEEDBACK_IMPACTS.map((id) => ({ id, label: FEEDBACK_IMPACT_LABELS[id] }));
export const IMPORTANCE_CHOICES: readonly Choice<FeedbackImportance>[] = FEEDBACK_IMPORTANCES.map((id) => ({ id, label: FEEDBACK_IMPORTANCE_LABELS[id] }));

/** Whether the person has typed anything yet, which is what closing the dialog by a stray click would lose. */
export const hasUnsentText = (draft: Draft): boolean => [draft.title, draft.doing, draft.happened, draft.expected, draft.why].some((text) => text.trim() !== '');

/** Which workspace a stored layout value means; anything else is not a workspace. */
export const workspaceOf = (stored: unknown): FeedbackReport['workspace'] => (stored === 'edit' || stored === 'board' ? stored : null);

export const DIALOG_TITLE = 'Send feedback';

export function dialogDescription(status: Pick<FeedbackStatus, 'repo'>): string {
  return `This goes to ${status.repo ?? 'the feedback repository'}. Only people who can open that repository can read it.`;
}

/** What leaves the Mac with a report, said before it does. */
export function sentWithReport(reporter: string | null, version: string, hasScreenshot: boolean): string {
  const parts = [`your name${reporter ? ` (${reporter})` : ''}`, `Blackout ${version} and your Mac's system version`, 'which workspace was open'];
  return `Sent with it: ${parts.join(', ')}${hasScreenshot ? ', and the picture of the app window below' : ''}. Nothing else.`;
}

export function submittedMessage(result: FeedbackSubmitResult): string {
  const note = result.screenshot === 'failed' ? ' The screenshot could not be saved, so it went without one.' : '';
  return `Thank you. Your report is #${result.number}.${note}`;
}

/** ---- Settings: the connection ---- */

export const FEEDBACK_PURPOSE =
  'Report a problem or an idea from inside Blackout. Reports go to a private GitHub repository chosen below, and you can follow each one here, with the replies.';

export const FEEDBACK_DISCLOSURE =
  'What leaves this Mac, and only when you press Send: what you write in the form, your name, the Blackout and system versions, which workspace was open, and the picture of the app window if you keep it. The access key is stored encrypted on this Mac and is never shown again.';

export const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
export const KEY_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

export const repoLooksRight = (repo: string): boolean => REPO_PATTERN.test(repo.trim()) && !repo.trim().split('/').some((part) => part === '.' || part === '..');
export const keyLooksRight = (key: string): boolean => KEY_PATTERN.test(key.trim());

export type ConfigForm = { reporter: string; repo: string; key: string };

/** Whether Save does something: a name and repository that are right, and a key that is right when one is being added. */
export function canSaveConfig(form: ConfigForm, status: FeedbackStatus | null | undefined): boolean {
  if (!status) return false;
  const reporter = form.reporter.replace(/\s+/g, ' ').trim();
  if (reporter.length < 2 || reporter.length > 40 || !repoLooksRight(form.repo)) return false;
  if (form.key.trim()) return status.secureStorage && keyLooksRight(form.key);
  return status.hasKey;
}

/** What Settings sends to main: a key only when one was typed, so the saved key stays as it is. */
export const toConfigInput = (form: ConfigForm): FeedbackConfigInput => ({
  repo: form.repo.trim(),
  reporter: form.reporter.replace(/\s+/g, ' ').trim(),
  ...(form.key.trim() ? { key: form.key.trim() } : {}),
});

export function statusLine(status: FeedbackStatus | null | undefined): string {
  if (!status) return 'Reading the settings…';
  if (!status.secureStorage && !status.hasKey) return 'This Mac cannot keep an access key encrypted, so Blackout will not store one.';
  if (status.configured) return `Reports go to ${status.repo} as ${status.reporter}.`;
  return 'Not set up yet. Add your name, the repository and the access key you were given.';
}

export function connectionLine(connection: FeedbackConnection): { ok: boolean; text: string } {
  return connection.private
    ? { ok: true, text: `Connected to ${connection.repo}. It is private: only people with access can read your reports.` }
    : { ok: false, text: `Connected to ${connection.repo}, but it is PUBLIC: anyone can read your reports. Use a private repository.` };
}

/** ---- Settings: the reports ---- */

export function when(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(locale, { dateStyle: 'medium' });
}

export const kindLabel = (kind: FeedbackKind | null): string => (kind === 'idea' ? 'Idea' : kind === 'feedback' ? 'Feedback' : 'Report');
export const stateLabel = (item: Pick<FeedbackListItem, 'state'>): string => (item.state === 'closed' ? 'Closed' : 'Open');

export function reportMeta(item: FeedbackListItem, format: (iso: string) => string = when): string {
  const replies = item.comments === 1 ? '1 reply' : `${item.comments} replies`;
  return [kindLabel(item.kind), stateLabel(item), item.reporter, `updated ${format(item.updatedAt)}`, item.comments ? replies : null].filter(Boolean).join(' · ');
}

export const canReply = (text: string): boolean => text.trim().length > 0 && text.length <= TEXT_MAX;

/**
 * A report as plain lines for Settings, which shows text and never markup: headings and bold marks come off, and the
 * screenshot's image link, which only GitHub can draw, becomes a note that one went with it.
 */
export function readableBody(body: string): string {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '(a screenshot went with it)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Who wrote a reply: the tester, from inside the app, or the people reading the reports on GitHub. */
export const commentAuthor = (comment: Pick<FeedbackComment, 'fromApp' | 'reporter'>): string => (comment.fromApp ? comment.reporter ?? 'Tester' : 'Blackout team');
