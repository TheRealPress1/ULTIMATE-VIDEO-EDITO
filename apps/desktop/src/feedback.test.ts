import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FeedbackInputError, FeedbackService, FeedbackServiceError } from './feedback';
import { APP_COMMENT_MARKER, REPORT_MARKER, issueBody, checkReport } from './feedback-format';

import type { FeedbackDeps } from './feedback';

const REPO = 'TheRealPress1/blackout-feedback';
const KEY = 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEF';
const env = { version: '0.226.0', os: 'macOS 15.1', arch: 'Apple silicon' };

type Call = { method: string; url: string; headers: Record<string, string>; body: string | undefined };
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error;

let dir: string;
let calls: Call[];
let replies: Array<(call: Call) => Reply | undefined>;
let secureAvailable: boolean;
let clock: number;

/** Stands in for safeStorage: reversible, and plainly not the text itself. */
const secure = {
  isEncryptionAvailable: () => secureAvailable,
  encryptString: (value: string) => Buffer.from(`enc:${[...value].reverse().join('')}`),
  decryptString: (bytes: Buffer) => [...bytes.toString().slice(4)].reverse().join(''),
};

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call: Call = {
    method: init?.method ?? 'GET',
    url: String(input),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === 'string' ? init.body : undefined,
  };
  calls.push(call);
  for (const reply of replies) {
    const out = reply(call);
    if (out instanceof Error) throw out;
    if (out) return new Response(out.json === undefined ? null : JSON.stringify(out.json), { status: out.status ?? 200, headers: out.headers });
  }
  return new Response('{}', { status: 200 });
}) as typeof fetch;

const service = (over: Partial<FeedbackDeps> = {}) =>
  new FeedbackService({ fetch: fakeFetch, secure, dir, environment: () => env, now: () => clock, id: () => 'abc123', ...over });

const configured = async (s = service()) => {
  await s.saveConfig({ repo: REPO, reporter: 'Alex', key: KEY });
  return s;
};

const report = (over: Record<string, unknown> = {}) => ({
  kind: 'feedback',
  title: 'The razor skips a frame',
  area: 'timeline',
  doing: 'Cutting at the breath.',
  happened: 'It cut a frame late.',
  expected: 'Premiere cuts at the playhead.',
  impact: 'blocks-work',
  workspace: 'edit',
  screenshot: null,
  ...over,
});

const shot = `data:image/jpeg;base64,${Buffer.from('not really a picture').toString('base64')}`;
const when = (match: (call: Call) => boolean, reply: Reply) => replies.unshift((call) => (match(call) ? reply : undefined));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-test-'));
  calls = [];
  replies = [];
  secureAvailable = true;
  clock = Date.UTC(2026, 10, 14, 12, 0, 0);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const message = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected it to throw');
};

describe('the settings and the key', () => {
  it('starts unset, and says whether this Mac can keep a key', async () => {
    expect(await service().status()).toEqual({ configured: false, repo: null, reporter: null, hasKey: false, secureStorage: true });
    secureAvailable = false;
    expect((await service().status()).secureStorage).toBe(false);
  });

  it('keeps the key encrypted, and never says it', async () => {
    const s = await configured();
    const status = await s.status();
    expect(status).toEqual({ configured: true, repo: REPO, reporter: 'Alex', hasKey: true, secureStorage: true });
    expect(JSON.stringify(status)).not.toContain(KEY);

    for (const file of await readdir(dir)) expect(await readFile(join(dir, file), 'utf8')).not.toContain(KEY);
    expect(await readFile(join(dir, 'feedback-key.bin'), 'utf8')).toMatch(/^enc:/);
  });

  it('reports that a key is saved without decrypting it, and says so when it can no longer be read', async () => {
    let decrypted = 0;
    const counting = { ...secure, decryptString: (bytes: Buffer) => { decrypted++; return secure.decryptString(bytes); } };
    const s = await configured(service({ secure: counting }));
    expect((await s.status()).hasKey).toBe(true);
    expect(decrypted).toBe(0);

    const unreadable = service({ secure: { ...secure, decryptString: () => { throw new Error('keychain locked'); } } });
    expect((await unreadable.status()).hasKey).toBe(true);
    expect((await message(unreadable.test())).message).toMatch(/cannot be read.*Paste it again/);
  });

  it('writes whole files, one save after the other, and leaves no temporary file', async () => {
    const s = service();
    await Promise.all([
      s.saveConfig({ repo: REPO, reporter: 'First', key: KEY }),
      s.saveConfig({ repo: 'o/second', reporter: 'Second' }),
      s.saveConfig({ repo: 'o/third', reporter: 'Third' }),
    ]);
    expect(await s.status()).toMatchObject({ repo: 'o/third', reporter: 'Third', hasKey: true, configured: true });
    expect((await readdir(dir)).sort()).toEqual(['feedback-key.bin', 'feedback.json']);
  });

  it('leaves the saved key alone when only the name or repository changes, and removes it on request', async () => {
    const s = await configured();
    expect(await s.saveConfig({ repo: 'o/other', reporter: 'Sam' })).toMatchObject({ configured: true, repo: 'o/other', reporter: 'Sam', hasKey: true });
    expect(await s.clearKey()).toMatchObject({ configured: false, hasKey: false, repo: 'o/other' });
  });

  it('refuses a repository, name or key that is not right, and a key it cannot encrypt', async () => {
    const s = service();
    expect(await message(s.saveConfig({ repo: 'https://github.com/a/b', reporter: 'Alex', key: KEY }))).toBeInstanceOf(FeedbackInputError);
    expect(await message(s.saveConfig({ repo: REPO, reporter: '', key: KEY }))).toBeInstanceOf(FeedbackInputError);
    expect((await message(s.saveConfig({ repo: REPO, reporter: 'Alex', key: 'not a key' }))).message).toMatch(/does not look like an access key/);

    secureAvailable = false;
    expect((await message(s.saveConfig({ repo: REPO, reporter: 'Alex', key: KEY }))).message).toMatch(/cannot keep the key encrypted/);
    expect((await s.status()).hasKey).toBe(false);
  });

  it('asks for the setup before it sends anything', async () => {
    expect((await message(service().submit(report()))).message).toMatch(/Set up feedback in Settings/);
    expect(calls).toHaveLength(0);
  });
});

describe('sending a report', () => {
  it('saves the screenshot first, then opens the issue with a link to it', async () => {
    when((c) => c.method === 'PUT', { status: 201, json: { content: { html_url: `https://github.com/${REPO}/blob/main/reports/2026-11-14/abc123.jpg` } } });
    when((c) => c.method === 'POST', { status: 201, json: { number: 7 } });
    const s = await configured();

    expect(await s.submit(report({ screenshot: shot }))).toEqual({ number: 7, screenshot: 'attached' });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT https://api.github.com/repos/${REPO}/contents/reports/2026-11-14/abc123.jpg`,
      `POST https://api.github.com/repos/${REPO}/issues`,
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ message: 'Screenshot for a report', content: shot.split(',')[1] });

    const issue = JSON.parse(calls[1]!.body!) as { title: string; body: string; labels: string[] };
    expect(issue.title).toBe('[Feedback] The razor skips a frame');
    expect(issue.labels).toEqual(['from-app', 'feedback', 'area:timeline', 'blocks-work']);
    expect(issue.body.startsWith(REPORT_MARKER)).toBe(true);
    expect(issue.body).toContain('**Reported by:** Alex');
    expect(issue.body).toContain(`![Screenshot](https://github.com/${REPO}/blob/main/reports/2026-11-14/abc123.jpg?raw=true)`);
  });

  it('sends the key as the authorization and nowhere else, and only to api.github.com', async () => {
    when((c) => c.method === 'POST', { status: 201, json: { number: 1 } });
    const s = await configured();
    await s.submit(report());
    await s.test().catch(() => undefined);

    for (const call of calls) {
      expect(call.url.startsWith('https://api.github.com/')).toBe(true);
      expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers['User-Agent']).toBe('Blackout/0.226.0');
      expect(call.body ?? '').not.toContain(KEY);
    }
  });

  it('sends the report without the picture when the picture cannot be saved', async () => {
    when((c) => c.method === 'PUT', { status: 500 });
    when((c) => c.method === 'POST', { status: 201, json: { number: 8 } });
    const s = await configured();

    expect(await s.submit(report({ screenshot: shot }))).toEqual({ number: 8, screenshot: 'failed' });
    expect(JSON.parse(calls[1]!.body!).body).not.toContain('Screenshot');
  });

  it('does not touch GitHub for a report that is not right', async () => {
    const s = await configured();
    expect(await message(s.submit(report({ title: '' })))).toBeInstanceOf(FeedbackInputError);
    expect(calls).toHaveLength(0);
  });

  it('puts the second report off for a moment', async () => {
    when((c) => c.method === 'POST', { status: 201, json: { number: 1 } });
    const s = await configured();
    await s.submit(report());
    expect((await message(s.submit(report()))).message).toMatch(/One moment/);
    clock += 4000;
    await expect(s.submit(report())).resolves.toMatchObject({ number: 1 });
  });

  it('says in plain words what went wrong', async () => {
    const s = await configured();
    const cases: Array<[Reply, RegExp]> = [
      [{ status: 401 }, /did not accept the access key/],
      [{ status: 403 }, /not allowed to do this/],
      [{ status: 403, headers: { 'x-ratelimit-remaining': '0' } }, /wait a little/],
      [{ status: 404 }, /cannot find TheRealPress1\/blackout-feedback/],
      [{ status: 422 }, /did not accept the report/],
      [{ status: 301 }, /has moved/],
      [{ status: 502 }, /error \(502\)/],
      [new TypeError('fetch failed'), /Could not reach GitHub/],
    ];
    for (const [reply, expected] of cases) {
      replies = [];
      when((c) => c.method === 'POST', reply);
      clock += 4000;
      const error = await message(s.submit(report()));
      expect(error).toBeInstanceOf(FeedbackServiceError);
      expect(error.message).toMatch(expected);
      expect(error.message).not.toContain(KEY);
    }
  });
});

describe('the connection', () => {
  it('says whether the repository is private', async () => {
    when((c) => c.url.endsWith(`/repos/${REPO}`), { json: { full_name: REPO, private: true } });
    expect(await (await configured()).test()).toEqual({ repo: REPO, private: true });

    replies = [];
    when((c) => c.url.endsWith(`/repos/${REPO}`), { json: { full_name: REPO, private: false } });
    expect((await (await configured()).test()).private).toBe(false);
  });
});

describe('reading and replying', () => {
  const issue = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: '[Idea] Slip tool',
    state: 'open',
    body: issueBody(checkReport({ kind: 'idea', title: 'Slip tool', area: 'timeline', doing: 'Slip.', expected: 'Y.', importance: 'nice-to-have', workspace: null }), 'Alex', env, null),
    created_at: '2026-11-14T10:00:00Z',
    updated_at: '2026-11-14T11:00:00Z',
    comments: 1,
    labels: [{ name: 'from-app' }, { name: 'idea' }],
    ...over,
  });

  it('lists the reports the app made, newest activity first, and nothing else', async () => {
    when((c) => c.url.includes('/issues?'), { json: [issue(3), issue(2, { labels: [{ name: 'bug' }] }), issue(1, { pull_request: {} })] });
    const list = await (await configured()).list();
    expect(list.map((i) => [i.number, i.title, i.kind, i.reporter])).toEqual([[3, 'Slip tool', 'idea', 'Alex']]);
    expect(calls[0]!.url).toContain('labels=from-app');
  });

  it("lists a report just sent before GitHub's own list shows it, and once when it does", async () => {
    // Measured against the real API: the issue list lags a new report by several seconds.
    when((c) => c.method === 'POST', { status: 201, json: { number: 7 } });
    when((c) => c.url.includes('/issues?'), { json: [] });
    const s = await configured();
    await s.submit(report());

    expect((await s.list()).map((i) => [i.number, i.title, i.kind, i.reporter, i.state, i.comments])).toEqual([[7, 'The razor skips a frame', 'feedback', 'Alex', 'open', 0]]);

    // GitHub catches up: its own entry is shown, not a second one beside it.
    when((c) => c.url.includes('/issues?'), { json: [issue(7, { title: '[Feedback] The razor skips a frame', labels: [{ name: 'from-app' }, { name: 'feedback' }], comments: 0 })] });
    expect((await s.list()).map((i) => i.number)).toEqual([7]);

    // Once shown it is no longer remembered here: what GitHub says is the truth from then on.
    when((c) => c.url.includes('/issues?'), { json: [] });
    expect(await s.list()).toEqual([]);
  });

  it('stops adding a sent report after two minutes, so one that was deleted does not linger', async () => {
    when((c) => c.method === 'POST', { status: 201, json: { number: 7 } });
    when((c) => c.url.includes('/issues?'), { json: [] });
    const s = await configured();
    await s.submit(report());

    clock += 119_000;
    expect((await s.list()).map((i) => i.number)).toEqual([7]);
    clock += 2_000;
    expect(await s.list()).toEqual([]);
  });

  it('puts a report just sent among the others by when it was last touched', async () => {
    when((c) => c.method === 'POST', { status: 201, json: { number: 7 } });
    when((c) => c.url.includes('/issues?'), { json: [issue(3, { updated_at: '2026-11-14T13:00:00Z' }), issue(2, { updated_at: '2026-11-14T09:00:00Z' })] });
    const s = await configured();
    await s.submit(report());
    // The clock says 12:00 on the 14th: between the two.
    expect((await s.list()).map((i) => i.number)).toEqual([3, 7, 2]);
  });

  it('shows a report with its replies, told apart by who wrote them', async () => {
    when((c) => c.url.endsWith('/issues/3'), { json: issue(3) });
    when((c) => c.url.includes('/issues/3/comments'), {
      json: [
        { id: 1, body: 'Fixed in 0.226.1.', created_at: '2026-11-14T12:00:00Z' },
        { id: 2, body: `${APP_COMMENT_MARKER}\n**Alex:** Thanks, works.`, created_at: '2026-11-14T13:00:00Z' },
      ],
    });
    const thread = await (await configured()).thread(3);
    expect(thread.body.startsWith('**Type:** Idea')).toBe(true);
    expect(thread.comments.map((c) => [c.fromApp, c.reporter, c.body])).toEqual([
      [false, null, 'Fixed in 0.226.1.'],
      [true, 'Alex', 'Thanks, works.'],
    ]);
  });

  it('will not open something that is not a report', async () => {
    when((c) => c.url.endsWith('/issues/9'), { json: issue(9, { labels: [{ name: 'bug' }] }) });
    const error = await message((await configured()).thread(9));
    expect(error).toBeInstanceOf(FeedbackInputError);
    expect(await message((await configured()).thread('9'))).toBeInstanceOf(FeedbackInputError);
  });

  it('posts a reply as the person, marked as written from the app', async () => {
    when((c) => c.method === 'POST', { status: 201, json: { id: 5, body: `${APP_COMMENT_MARKER}\n**Alex:** It was frame 120.`, created_at: '2026-11-14T14:00:00Z' } });
    const comment = await (await configured()).reply(3, '  It was frame 120. ');
    expect(JSON.parse(calls[0]!.body!).body).toBe(`${APP_COMMENT_MARKER}\n**Alex:** It was frame 120.`);
    expect(comment).toMatchObject({ id: 5, fromApp: true, reporter: 'Alex', body: 'It was frame 120.' });
    expect(await message((await configured()).reply(3, '   '))).toBeInstanceOf(FeedbackInputError);
  });
});
