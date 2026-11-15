/**
 * What a feedback report becomes on GitHub, and back: checking what the dialog sent, the issue's title, labels and
 * body, and reading issues and comments again for Settings. Pure, so it is all tested without a network or Electron.
 */

import {
  FEEDBACK_AREAS,
  FEEDBACK_AREA_LABELS,
  FEEDBACK_IMPACTS,
  FEEDBACK_IMPACT_LABELS,
  FEEDBACK_IMPORTANCES,
  FEEDBACK_IMPORTANCE_LABELS,
  FEEDBACK_KINDS,
} from './feedback-types';

import type { FeedbackComment, FeedbackKind, FeedbackListItem, FeedbackReport } from './feedback-types';

/** The report is wrong in a way the person can fix, and the message says how. */
export class FeedbackInputError extends Error {}

export const LIMITS = { title: 120, text: 8000, reporter: 40 } as const;
export const SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;

/** The first line of every report issue, which is how the app tells its own reports from anything else in the repository. */
export const REPORT_MARKER = '<!-- blackout-report v1 -->';
/** The first line of a comment written from inside the app. */
export const APP_COMMENT_MARKER = '<!-- blackout-app -->';

const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export function parseRepo(value: unknown): string {
  const repo = typeof value === 'string' ? value.trim() : '';
  if (!REPO.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) {
    throw new FeedbackInputError('The repository must look like owner/name.');
  }
  return repo;
}

/** A name that can sit in a line of markdown: no formatting characters, one line. */
export function parseReporter(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/[<>*_`[\]\\|]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (name.length < 2 || name.length > LIMITS.reporter) {
    throw new FeedbackInputError(`Your name must be between 2 and ${LIMITS.reporter} characters.`);
  }
  return name;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, what: string): T => {
  if (typeof value === 'string' && (list as readonly string[]).includes(value)) return value as T;
  throw new FeedbackInputError(`Choose ${what}.`);
};

const text = (value: unknown, label: string, required: boolean): string => {
  const out = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (required && !out) throw new FeedbackInputError(`Fill in "${label}".`);
  if (out.length > LIMITS.text) throw new FeedbackInputError(`"${label}" is too long (${LIMITS.text} characters at most).`);
  return out;
};

const JPEG = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

/** Checks what the dialog sent and returns it trimmed, with what does not apply to its kind set aside. */
export function checkReport(input: unknown): FeedbackReport {
  if (typeof input !== 'object' || input === null) throw new FeedbackInputError('There is nothing to send.');
  const r = input as Record<string, unknown>;

  const kind = oneOf(FEEDBACK_KINDS, r.kind, 'whether this is feedback or an idea');
  const idea = kind === 'idea';

  const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new FeedbackInputError('Give it a short title.');
  if (title.length > LIMITS.title) throw new FeedbackInputError(`The title is too long (${LIMITS.title} characters at most).`);

  let screenshot: string | null = null;
  if (r.screenshot !== null && r.screenshot !== undefined) {
    const match = typeof r.screenshot === 'string' ? JPEG.exec(r.screenshot) : null;
    if (!match) throw new FeedbackInputError('The screenshot is not a JPEG picture.');
    if (Math.floor((match[1]!.length * 3) / 4) > SCREENSHOT_MAX_BYTES) throw new FeedbackInputError('The screenshot is too large.');
    screenshot = r.screenshot as string;
  }

  const workspace = r.workspace === 'edit' || r.workspace === 'board' ? r.workspace : null;

  return {
    kind,
    title,
    area: oneOf(FEEDBACK_AREAS, r.area, 'where you were'),
    doing: text(r.doing, idea ? 'What would you want to be able to do?' : 'What were you trying to do?', true),
    happened: idea ? '' : text(r.happened, 'What happened?', true),
    expected: text(r.expected, idea ? 'How do you do it today in Premiere?' : 'What did you expect, or what does Premiere do here?', true),
    why: text(r.why, 'Why does it matter?', false),
    impact: idea ? 'small' : oneOf(FEEDBACK_IMPACTS, r.impact, 'how much it gets in your way'),
    importance: idea ? oneOf(FEEDBACK_IMPORTANCES, r.importance, 'how important it is') : 'nice-to-have',
    workspace,
    screenshot,
  };
}

export type ReportEnvironment = { version: string; os: string; arch: string };

export function environmentLine(env: ReportEnvironment, workspace: FeedbackReport['workspace']): string {
  const where = workspace ? ` · ${workspace === 'edit' ? 'Edit' : 'Board'} workspace` : '';
  return `Blackout ${env.version} · ${env.os} · ${env.arch}${where}`;
}

export const issueTitle = (report: FeedbackReport): string => `${report.kind === 'idea' ? '[Idea]' : '[Feedback]'} ${report.title}`;

export function issueLabels(report: FeedbackReport): string[] {
  const labels = ['from-app', report.kind, `area:${report.area}`];
  if (report.kind === 'feedback' && report.impact === 'blocks-work') labels.push('blocks-work');
  return labels;
}

/** `screenshotUrl` is a link into the repository itself, which the app builds from GitHub's answer. */
export function issueBody(report: FeedbackReport, reporter: string, env: ReportEnvironment, screenshotUrl: string | null): string {
  const idea = report.kind === 'idea';
  const out = [
    REPORT_MARKER,
    `**Type:** ${idea ? 'Idea' : 'Feedback'}  `,
    `**Area:** ${FEEDBACK_AREA_LABELS[report.area]}  `,
    idea
      ? `**Importance:** ${FEEDBACK_IMPORTANCE_LABELS[report.importance]}  `
      : `**Impact:** ${FEEDBACK_IMPACT_LABELS[report.impact]}  `,
    `**Reported by:** ${reporter}  `,
    `**App:** ${environmentLine(env, report.workspace)}`,
    '',
  ];

  const section = (heading: string, body: string) => out.push(`### ${heading}`, body, '');

  if (idea) {
    section('What would you want to be able to do?', report.doing);
    section('How do you do it today in Premiere (or your other tool)?', report.expected);
    if (report.why) section('Why does it matter in a real edit?', report.why);
  } else {
    section('What were you trying to do?', report.doing);
    section('What happened?', report.happened);
    section('What did you expect, or what does Premiere do here?', report.expected);
  }

  if (screenshotUrl) section('Screenshot', `![Screenshot](${screenshotUrl})`);
  return out.join('\n').trimEnd();
}

/** A comment written from inside the app: who wrote it is in its first line. */
export const appCommentBody = (reporter: string, body: string): string => `${APP_COMMENT_MARKER}\n**${reporter}:** ${body.trim()}`;

export function parseComment(raw: { id: number; body?: string | null; created_at: string }): FeedbackComment {
  const body = raw.body ?? '';
  if (!body.startsWith(APP_COMMENT_MARKER)) return { id: raw.id, fromApp: false, reporter: null, createdAt: raw.created_at, body: body.trim() };

  const rest = body.slice(APP_COMMENT_MARKER.length).trim();
  const named = /^\*\*(.+?):\*\* ([\s\S]*)$/.exec(rest);
  return { id: raw.id, fromApp: true, reporter: named ? named[1]! : null, createdAt: raw.created_at, body: (named ? named[2]! : rest).trim() };
}

export const reporterOf = (body: string | null | undefined): string | null => /^\*\*Reported by:\*\* (.+?)\s*$/m.exec(body ?? '')?.[1] ?? null;

export const kindOf = (labels: readonly string[]): FeedbackKind | null => (labels.includes('idea') ? 'idea' : labels.includes('feedback') ? 'feedback' : null);

/** The report as the person wrote it, without the marker line. */
export const displayBody = (body: string | null | undefined): string => (body ?? '').replace(REPORT_MARKER, '').trim();

type RawIssue = {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  created_at: string;
  updated_at: string;
  comments: number;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
};

const labelNames = (issue: RawIssue): string[] => (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? ''));

/** What Settings lists: only issues the app made (a pull request or anything else in the repository is left out). */
export function isReportIssue(issue: RawIssue): boolean {
  return !issue.pull_request && labelNames(issue).includes('from-app');
}

export function parseIssue(issue: RawIssue): Omit<FeedbackListItem, 'comments'> & { comments: number } {
  return {
    number: issue.number,
    title: issue.title.replace(/^\[(Feedback|Idea)\]\s*/, ''),
    state: issue.state === 'closed' ? 'closed' : 'open',
    kind: kindOf(labelNames(issue)),
    reporter: reporterOf(issue.body),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    comments: issue.comments,
  };
}
