import { describe, expect, it } from 'vitest';

import {
  AREA_CHOICES,
  DEFAULT_FEEDBACK_REPO,
  IMPACT_CHOICES,
  IMPORTANCE_CHOICES,
  TEXT_MAX,
  canReply,
  canSaveConfig,
  commentAuthor,
  connectionLine,
  dialogDescription,
  emptyDraft,
  fieldsFor,
  hasUnsentText,
  keyLooksRight,
  kindLabel,
  missing,
  readableBody,
  repoLooksRight,
  reportMeta,
  sentWithReport,
  statusLine,
  stateLabel,
  submittedMessage,
  toConfigInput,
  toReport,
  when,
  workspaceOf,
} from './feedback-data';

import type { FeedbackListItem, FeedbackStatus } from '@desktop/feedback-types';

const KEY = 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEF';
const status = (over: Partial<FeedbackStatus> = {}): FeedbackStatus => ({ configured: false, repo: null, reporter: null, hasKey: false, secureStorage: true, ...over });

const filled = () => ({
  ...emptyDraft('feedback'),
  title: '  The razor skips a frame ',
  doing: ' Cutting at the breath. ',
  happened: ' A frame late. ',
  expected: ' At the playhead, like Premiere. ',
});

describe('the questions of each kind', () => {
  it('asks a problem the three questions, and an idea its own, with the reason optional', () => {
    expect(fieldsFor('feedback').map((f) => [f.key, f.required])).toEqual([['doing', true], ['happened', true], ['expected', true]]);
    expect(fieldsFor('idea').map((f) => [f.key, f.required])).toEqual([['doing', true], ['expected', true], ['why', false]]);
    expect(fieldsFor('feedback')[2]!.label).toMatch(/what does Premiere do/);
  });

  it('says what is missing, one thing at a time, and nothing once it can go', () => {
    expect(missing(emptyDraft())).toBe('Give it a short title.');
    expect(missing({ ...emptyDraft(), title: 'x' })).toBe('Fill in "What were you trying to do?".');
    expect(missing({ ...emptyDraft(), title: 'x', doing: 'a' })).toBe('Fill in "What happened?".');
    expect(missing({ ...emptyDraft(), title: 'x', doing: 'a', happened: 'b' })).toMatch(/Premiere/);
    expect(missing(filled())).toBeNull();
    // An idea does not need "what happened", and its reason may be left blank.
    expect(missing({ ...emptyDraft('idea'), title: 'x', doing: 'a', expected: 'b' })).toBeNull();
  });
});

describe('the report that is sent', () => {
  it('is trimmed, and a problem carries no idea fields', () => {
    const report = toReport({ ...filled(), why: 'ignored' }, 'data:image/jpeg;base64,AAAA', 'edit');
    expect(report).toMatchObject({ kind: 'feedback', title: 'The razor skips a frame', doing: 'Cutting at the breath.', happened: 'A frame late.', expected: 'At the playhead, like Premiere.', why: '', impact: 'slows-me-down', workspace: 'edit', screenshot: 'data:image/jpeg;base64,AAAA' });
  });

  it('carries an idea with its importance, and no impact or "what happened"', () => {
    const report = toReport({ ...emptyDraft('idea'), title: 'Slip', doing: 'Slip a clip', expected: 'Y', why: ' Dialogue. ', happened: 'stale', importance: 'must-have' }, null, null);
    expect(report).toMatchObject({ kind: 'idea', happened: '', why: 'Dialogue.', importance: 'must-have', impact: 'small', workspace: null, screenshot: null });
  });

  it('reads the workspace from what the layout stored', () => {
    expect(workspaceOf('edit')).toBe('edit');
    expect(workspaceOf('board')).toBe('board');
    expect(workspaceOf('color')).toBeNull();
    expect(workspaceOf(undefined)).toBeNull();
  });
});

describe('the words around the dialog', () => {
  it('says where it goes, what goes with it, and what became of it', () => {
    expect(dialogDescription({ repo: 'o/r' })).toMatch(/goes to o\/r/);
    expect(sentWithReport('Alex', '0.226.0', false)).toBe("Sent with it: your name (Alex), Blackout 0.226.0 and your Mac's system version, which workspace was open. Nothing else.");
    expect(sentWithReport(null, '0.226.0', true)).toMatch(/and the picture of the app window below\. Nothing else\.$/);
    expect(submittedMessage({ number: 12, screenshot: 'attached' })).toBe('Thank you. Your report is #12.');
    expect(submittedMessage({ number: 12, screenshot: 'failed' })).toMatch(/screenshot could not be saved/);
  });
});

describe('Settings: the connection', () => {
  it('knows a repository and a key by their shape', () => {
    expect(repoLooksRight('TheRealPress1/blackout-feedback')).toBe(true);
    for (const bad of ['', 'one', 'a/b/c', 'a/../b', 'a b/c', 'https://github.com/a/b']) expect(repoLooksRight(bad)).toBe(false);
    expect(keyLooksRight(KEY)).toBe(true);
    expect(keyLooksRight(` ${KEY} `)).toBe(true);
    for (const bad of ['', 'short', 'has spaces in it that make it long enough to count', `${KEY}!`]) expect(keyLooksRight(bad)).toBe(false);
  });

  it('lets Save work only for a name, a repository and, when typed, a key that is right', () => {
    const form = { reporter: 'Alex', repo: 'o/r', key: KEY };
    expect(canSaveConfig(form, status())).toBe(true);
    expect(canSaveConfig(form, undefined)).toBe(false);
    expect(canSaveConfig({ ...form, reporter: ' A ' }, status())).toBe(false);
    expect(canSaveConfig({ ...form, repo: 'nope' }, status())).toBe(false);
    expect(canSaveConfig({ ...form, key: 'short' }, status())).toBe(false);
    // No encryption on this Mac: a key is not accepted.
    expect(canSaveConfig(form, status({ secureStorage: false }))).toBe(false);
    // Changing the name alone is fine once a key is saved, and not before.
    expect(canSaveConfig({ ...form, key: '' }, status({ hasKey: true }))).toBe(true);
    expect(canSaveConfig({ ...form, key: '' }, status({ hasKey: false }))).toBe(false);
  });

  it('sends a key only when one was typed', () => {
    expect(toConfigInput({ reporter: '  Alex   M ', repo: ' o/r ', key: '' })).toEqual({ repo: 'o/r', reporter: 'Alex M' });
    expect(toConfigInput({ reporter: 'Alex', repo: 'o/r', key: ` ${KEY} ` })).toEqual({ repo: 'o/r', reporter: 'Alex', key: KEY });
  });

  it('says in a line where things stand', () => {
    expect(statusLine(undefined)).toMatch(/Reading/);
    expect(statusLine(status())).toMatch(/Not set up yet/);
    expect(statusLine(status({ secureStorage: false }))).toMatch(/cannot keep an access key encrypted/);
    expect(statusLine(status({ configured: true, repo: 'o/r', reporter: 'Alex', hasKey: true }))).toBe('Reports go to o/r as Alex.');
  });

  it('warns when the repository is public', () => {
    expect(connectionLine({ repo: 'o/r', private: true })).toMatchObject({ ok: true });
    const open = connectionLine({ repo: 'o/r', private: false });
    expect(open.ok).toBe(false);
    expect(open.text).toMatch(/PUBLIC/);
  });
});

describe('Settings: the reports', () => {
  const item = (over: Partial<FeedbackListItem> = {}): FeedbackListItem => ({ number: 3, title: 'Slip tool', state: 'open', kind: 'idea', reporter: 'Alex', createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T11:00:00Z', comments: 0, ...over });

  it('names a kind and a state', () => {
    expect([kindLabel('idea'), kindLabel('feedback'), kindLabel(null)]).toEqual(['Idea', 'Feedback', 'Report']);
    expect([stateLabel(item()), stateLabel(item({ state: 'closed' }))]).toEqual(['Open', 'Closed']);
  });

  it('describes a report in one line, with its replies when it has any', () => {
    const format = () => 'Nov 14, 2026';
    expect(reportMeta(item(), format)).toBe('Idea · Open · Alex · updated Nov 14, 2026');
    expect(reportMeta(item({ comments: 1, state: 'closed', kind: 'feedback', reporter: null }), format)).toBe('Feedback · Closed · updated Nov 14, 2026 · 1 reply');
    expect(reportMeta(item({ comments: 3 }), format)).toMatch(/· 3 replies$/);
  });

  it('formats a date, and gives back what it cannot read', () => {
    expect(when('2026-11-14T10:00:00Z', 'en-US')).toMatch(/2026/);
    expect(when('not a date')).toBe('not a date');
  });

  it('lets a reply go when it has words and is not too long', () => {
    expect(canReply('  ')).toBe(false);
    expect(canReply('Yes, frame 120.')).toBe(true);
    expect(canReply('x'.repeat(TEXT_MAX + 1))).toBe(false);
  });
});

describe('what the dialog offers', () => {
  it('lists every area, impact and importance once, with the words the report is written in', () => {
    expect(AREA_CHOICES.map((c) => c.id)).toEqual(['timeline', 'tracks', 'markers', 'playback', 'monitor', 'board', 'ai', 'projects', 'other']);
    expect(IMPACT_CHOICES.map((c) => c.id)).toEqual(['blocks-work', 'slows-me-down', 'annoying', 'small']);
    expect(IMPORTANCE_CHOICES.map((c) => c.id)).toEqual(['must-have', 'changes-my-work', 'nice-to-have']);
    expect(AREA_CHOICES[0]!.label).toBe('Timeline: cutting and trimming');
    expect(IMPACT_CHOICES.every((c) => c.label.length > 0)).toBe(true);
  });

  it('starts from the repository the owner reads, which the Settings field offers', () => {
    expect(DEFAULT_FEEDBACK_REPO).toBe('TheRealPress1/blackout-feedback');
    expect(repoLooksRight(DEFAULT_FEEDBACK_REPO)).toBe(true);
  });

  it('knows when a stray click would lose what was typed', () => {
    expect(hasUnsentText(emptyDraft())).toBe(false);
    expect(hasUnsentText({ ...emptyDraft(), title: '   ' })).toBe(false);
    expect(hasUnsentText({ ...emptyDraft(), why: 'because' })).toBe(true);
    expect(hasUnsentText({ ...emptyDraft('idea'), expected: 'x' })).toBe(true);
  });
});

describe('a report read back in Settings', () => {
  it('drops the markup and says a screenshot went with it', () => {
    const body = [
      '**Type:** Feedback  ',
      '**Reported by:** Alex  ',
      '',
      '### What were you trying to do?',
      'Cut at the breath.',
      '',
      '',
      '',
      '### Screenshot',
      '![Screenshot](https://github.com/o/r/blob/main/reports/2026-11-14/a1.jpg?raw=true)',
    ].join('\n');
    const text = readableBody(body);
    expect(text).toBe(['Type: Feedback', 'Reported by: Alex', '', 'What were you trying to do?', 'Cut at the breath.', '', 'Screenshot', '(a screenshot went with it)'].join('\n'));
    expect(text).not.toMatch(/github\.com|\*\*|###/);
  });

  it('leaves ordinary text alone, markup-like characters in a sentence included', () => {
    expect(readableBody('Use a * b and 2 ** 3, then [x] it.')).toBe('Use a * b and 2 ** 3, then [x] it.');
    expect(readableBody('')).toBe('');
  });

  it('tells who wrote a reply', () => {
    expect(commentAuthor({ fromApp: true, reporter: 'Alex' })).toBe('Alex');
    expect(commentAuthor({ fromApp: true, reporter: null })).toBe('Tester');
    expect(commentAuthor({ fromApp: false, reporter: null })).toBe('Blackout team');
  });
});
