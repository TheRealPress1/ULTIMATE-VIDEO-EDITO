import { describe, expect, it } from 'vitest';

import {
  APP_COMMENT_MARKER,
  FeedbackInputError,
  LIMITS,
  REPORT_MARKER,
  SCREENSHOT_MAX_BYTES,
  appCommentBody,
  checkReport,
  displayBody,
  environmentLine,
  isReportIssue,
  issueBody,
  issueLabels,
  issueTitle,
  kindOf,
  parseComment,
  parseIssue,
  parseRepo,
  parseReporter,
  reporterOf,
} from './feedback-format';

const env = { version: '0.226.0', os: 'macOS 15.1', arch: 'Apple silicon' };
const jpeg = (bytes: number) => `data:image/jpeg;base64,${'A'.repeat(Math.ceil((bytes * 4) / 3 / 4) * 4)}`;

const feedback = () => ({
  kind: 'feedback',
  title: '  The razor  skips a frame ',
  area: 'timeline',
  doing: 'Cutting an interview at the breath.',
  happened: 'The cut landed one frame late.',
  expected: 'In Premiere the razor lands where the playhead is.',
  impact: 'slows-me-down',
  workspace: 'edit',
  screenshot: null,
});

const idea = () => ({
  kind: 'idea',
  title: 'Slip tool',
  area: 'timeline',
  doing: 'Slip a clip inside its cut.',
  expected: 'Y in Premiere, then drag.',
  why: 'Every dialogue edit needs it.',
  importance: 'must-have',
  workspace: 'board',
});

const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FeedbackInputError);
    return (error as Error).message;
  }
  throw new Error('expected it to throw');
};

describe('the repository and the name', () => {
  it('takes owner/name and nothing that could lead elsewhere', () => {
    expect(parseRepo(' TheRealPress1/blackout-feedback ')).toBe('TheRealPress1/blackout-feedback');
    for (const bad of ['', 'one', 'a/b/c', 'a/../b', '../x', 'a b/c', 'https://github.com/a/b', 'a/b?x=1', null, 7]) {
      expect(() => parseRepo(bad)).toThrow(FeedbackInputError);
    }
  });

  it('takes a plain name on one line, without markdown characters', () => {
    expect(parseReporter('  Alex   Moreau ')).toBe('Alex Moreau');
    expect(parseReporter('**A<>l_e`x**')).toBe('Alex');
    expect(() => parseReporter('A')).toThrow(FeedbackInputError);
    expect(() => parseReporter('x'.repeat(LIMITS.reporter + 1))).toThrow(FeedbackInputError);
  });
});

describe('checking a report', () => {
  it('trims it and sets aside what does not belong to its kind', () => {
    const report = checkReport(feedback());
    expect(report).toMatchObject({ kind: 'feedback', title: 'The razor skips a frame', area: 'timeline', impact: 'slows-me-down', workspace: 'edit', screenshot: null });
    expect(report.why).toBe('');

    const i = checkReport(idea());
    expect(i).toMatchObject({ kind: 'idea', happened: '', importance: 'must-have', impact: 'small' });
  });

  it('says what to fix, one thing at a time', () => {
    expect(message(() => checkReport(null))).toMatch(/nothing to send/);
    expect(message(() => checkReport({ ...feedback(), kind: 'rant' }))).toMatch(/feedback or an idea/);
    expect(message(() => checkReport({ ...feedback(), title: '   ' }))).toMatch(/title/);
    expect(message(() => checkReport({ ...feedback(), title: 'x'.repeat(LIMITS.title + 1) }))).toMatch(/too long/);
    expect(message(() => checkReport({ ...feedback(), area: 'sound' }))).toMatch(/where you were/);
    expect(message(() => checkReport({ ...feedback(), doing: ' ' }))).toMatch(/What were you trying to do/);
    expect(message(() => checkReport({ ...feedback(), happened: '' }))).toMatch(/What happened/);
    expect(message(() => checkReport({ ...feedback(), expected: '' }))).toMatch(/Premiere/);
    expect(message(() => checkReport({ ...feedback(), impact: 'meh' }))).toMatch(/in your way/);
    expect(message(() => checkReport({ ...idea(), importance: 'meh' }))).toMatch(/how important/);
    expect(message(() => checkReport({ ...feedback(), happened: 'x'.repeat(LIMITS.text + 1) }))).toMatch(/too long/);
  });

  it('keeps a JPEG screenshot and refuses anything else, or a big one', () => {
    const small = jpeg(1000);
    expect(checkReport({ ...feedback(), screenshot: small }).screenshot).toBe(small);
    expect(message(() => checkReport({ ...feedback(), screenshot: 'data:image/png;base64,AAAA' }))).toMatch(/JPEG/);
    expect(message(() => checkReport({ ...feedback(), screenshot: 'https://example.com/x.jpg' }))).toMatch(/JPEG/);
    expect(message(() => checkReport({ ...feedback(), screenshot: jpeg(SCREENSHOT_MAX_BYTES + 4096) }))).toMatch(/too large/);
  });
});

describe('the issue it becomes', () => {
  it('titles and labels it by kind, area and impact', () => {
    const report = checkReport(feedback());
    expect(issueTitle(report)).toBe('[Feedback] The razor skips a frame');
    expect(issueLabels(report)).toEqual(['from-app', 'feedback', 'area:timeline']);
    expect(issueLabels(checkReport({ ...feedback(), impact: 'blocks-work' }))).toContain('blocks-work');

    const i = checkReport(idea());
    expect(issueTitle(i)).toBe('[Idea] Slip tool');
    expect(issueLabels(i)).toEqual(['from-app', 'idea', 'area:timeline']);
  });

  it('writes a feedback report with the marker, who, where and the three answers', () => {
    const body = issueBody(checkReport(feedback()), 'Alex', env, null);
    expect(body.startsWith(REPORT_MARKER)).toBe(true);
    expect(body).toContain('**Impact:** Slows me down');
    expect(body).toContain('**Reported by:** Alex');
    expect(body).toContain('**App:** Blackout 0.226.0 · macOS 15.1 · Apple silicon · Edit workspace');
    expect(body).toContain('### What happened?\nThe cut landed one frame late.');
    expect(body).toContain('### What did you expect, or what does Premiere do here?\nIn Premiere the razor lands');
    expect(body).not.toContain('Screenshot');
  });

  it('writes an idea with its own questions, and the screenshot only when there is one', () => {
    const body = issueBody(checkReport(idea()), 'Alex', env, 'https://github.com/o/r/blob/main/reports/x.jpg?raw=true');
    expect(body).toContain('**Importance:** I would not edit without it');
    expect(body).toContain('### How do you do it today in Premiere (or your other tool)?');
    expect(body).toContain('### Why does it matter in a real edit?\nEvery dialogue edit needs it.');
    expect(body).not.toContain('What happened?');
    expect(body).toContain('![Screenshot](https://github.com/o/r/blob/main/reports/x.jpg?raw=true)');
    expect(body).toContain('Board workspace');
    expect(issueBody(checkReport({ ...idea(), why: '' }), 'Alex', env, null)).not.toContain('Why does it matter');
  });

  it('names the app, the system and the workspace in one line', () => {
    expect(environmentLine(env, null)).toBe('Blackout 0.226.0 · macOS 15.1 · Apple silicon');
  });
});

describe('reading issues and comments back', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    number: 12,
    title: '[Idea] Slip tool',
    state: 'open',
    body: issueBody(checkReport(idea()), 'Alex Moreau', env, null),
    created_at: '2026-11-14T10:00:00Z',
    updated_at: '2026-11-14T11:00:00Z',
    comments: 2,
    labels: [{ name: 'from-app' }, { name: 'idea' }, { name: 'area:timeline' }],
    ...over,
  });

  it('lists only what the app made, and not a pull request', () => {
    expect(isReportIssue(raw())).toBe(true);
    expect(isReportIssue(raw({ labels: [{ name: 'bug' }] }))).toBe(false);
    expect(isReportIssue(raw({ pull_request: {} }))).toBe(false);
    expect(isReportIssue(raw({ labels: ['from-app'] }))).toBe(true);
  });

  it('reads the kind, reporter and state, with the title as the person typed it', () => {
    expect(parseIssue(raw())).toEqual({ number: 12, title: 'Slip tool', state: 'open', kind: 'idea', reporter: 'Alex Moreau', createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T11:00:00Z', comments: 2 });
    expect(parseIssue(raw({ state: 'closed' })).state).toBe('closed');
    expect(kindOf(['x'])).toBeNull();
    expect(reporterOf(null)).toBeNull();
  });

  it('shows the report without its marker line', () => {
    const text = displayBody(raw().body);
    expect(text.startsWith('**Type:** Idea')).toBe(true);
    expect(text).not.toContain(REPORT_MARKER);
  });

  it('tells a comment from the app from one the team wrote on GitHub', () => {
    const sent = appCommentBody('Alex Moreau', '  It was frame 120.  ');
    expect(sent.startsWith(APP_COMMENT_MARKER)).toBe(true);
    expect(parseComment({ id: 1, body: sent, created_at: 't' })).toEqual({ id: 1, fromApp: true, reporter: 'Alex Moreau', createdAt: 't', body: 'It was frame 120.' });
    expect(parseComment({ id: 2, body: 'Fixed in 0.226.1.', created_at: 't' })).toEqual({ id: 2, fromApp: false, reporter: null, createdAt: 't', body: 'Fixed in 0.226.1.' });
    expect(parseComment({ id: 3, body: null, created_at: 't' }).body).toBe('');
  });
});
