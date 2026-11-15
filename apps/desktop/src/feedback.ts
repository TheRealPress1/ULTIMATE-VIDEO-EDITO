/**
 * In-app feedback, main process. A report becomes an issue in a private GitHub repository, with its screenshot saved
 * as a file in the same repository, through the REST API and an access key the person pasted into Settings.
 *
 * - The key is kept encrypted (Electron's safeStorage) and read only here. Nothing returned to the web app contains it.
 * - The host is fixed: only https://api.github.com is ever contacted, and only when the person acts (send, test, list, reply).
 * - Without secure storage the key is refused rather than written in the clear.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FeedbackInputError,
  LIMITS,
  appCommentBody,
  checkReport,
  displayBody,
  isReportIssue,
  issueBody,
  issueLabels,
  issueTitle,
  parseComment,
  parseIssue,
  parseRepo,
  parseReporter,
} from './feedback-format';

import type { ReportEnvironment } from './feedback-format';
import type {
  FeedbackComment,
  FeedbackConfigInput,
  FeedbackConnection,
  FeedbackListItem,
  FeedbackStatus,
  FeedbackSubmitResult,
  FeedbackThread,
} from './feedback-types';

/** GitHub (or the network) said no, in words a person can act on. */
export class FeedbackServiceError extends Error {}

export { FeedbackInputError };

export type SecureStore = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type FeedbackDeps = {
  /** `net.fetch` in the app. */
  fetch: typeof fetch;
  secure: SecureStore;
  /** Where the settings and the encrypted key live. */
  dir: string;
  environment(): ReportEnvironment;
  now?(): number;
  /** A short unique name for a screenshot file. */
  id?(): string;
};

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
/** Pastes of a fine-grained or classic token: letters, digits and underscores. */
const KEY = /^[A-Za-z0-9_]{20,255}$/;
const MIN_GAP_MS = 3000;
/** GitHub's issue list shows a new issue several seconds late (measured: 2 to 7); a report just sent is listed from here meanwhile. */
const RECENT_MS = 120_000;

type Config = { repo: string; reporter: string };

export class FeedbackService {
  private readonly deps: FeedbackDeps;
  private lastSent = 0;
  private sending = false;
  /** Settings writes run one after another. */
  private writes: Promise<unknown> = Promise.resolve();
  /** Reports sent from here lately, by number: shown by `list` until GitHub's own list shows them. */
  private readonly recent = new Map<number, { at: number; item: FeedbackListItem }>();

  constructor(deps: FeedbackDeps) {
    this.deps = deps;
  }

  /** ---- Settings ---- */

  async status(): Promise<FeedbackStatus> {
    const config = await this.readConfig();
    const hasKey = await this.hasKey();
    return {
      configured: Boolean(config?.repo && config.reporter && hasKey),
      repo: config?.repo ?? null,
      reporter: config?.reporter ?? null,
      hasKey,
      secureStorage: this.deps.secure.isEncryptionAvailable(),
    };
  }

  async saveConfig(input: FeedbackConfigInput): Promise<FeedbackStatus> {
    const repo = parseRepo(input?.repo);
    const reporter = parseReporter(input?.reporter);

    const key = typeof input?.key === 'string' ? input.key.trim() : '';
    if (input?.key !== undefined && key) {
      if (!KEY.test(key)) throw new FeedbackInputError('That does not look like an access key. Paste it exactly as GitHub showed it.');
      if (!this.deps.secure.isEncryptionAvailable()) {
        throw new FeedbackInputError('This Mac cannot keep the key encrypted, so Blackout will not store it.');
      }
    }

    await this.queued(async () => {
      await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
      await this.write('feedback.json', JSON.stringify({ repo, reporter } satisfies Config));
      if (key) await this.write('feedback-key.bin', this.deps.secure.encryptString(key));
    });
    return this.status();
  }

  async clearKey(): Promise<FeedbackStatus> {
    await this.queued(() => rm(join(this.deps.dir, 'feedback-key.bin'), { force: true }));
    return this.status();
  }

  /** Asks GitHub whether the repository is reachable with the key, and whether it is private. */
  async test(): Promise<FeedbackConnection> {
    const { repo } = await this.ready();
    const info = (await this.github('GET', `/repos/${repo}`)) as { full_name?: string; private?: boolean };
    return { repo: info.full_name ?? repo, private: info.private === true };
  }

  /** ---- Sending ---- */

  async submit(raw: unknown): Promise<FeedbackSubmitResult> {
    const report = checkReport(raw);
    const { repo, reporter } = await this.ready();

    const now = this.deps.now?.() ?? Date.now();
    if (this.sending || now - this.lastSent < MIN_GAP_MS) throw new FeedbackInputError('One moment: the last report is still being sent.');
    this.sending = true;

    try {
      let screenshotUrl: string | null = null;
      let screenshot: FeedbackSubmitResult['screenshot'] = 'none';

      if (report.screenshot) {
        try {
          screenshotUrl = await this.saveScreenshot(repo, report.screenshot, now);
          screenshot = 'attached';
        } catch {
          // The words matter more than the picture: send the report without it.
          screenshot = 'failed';
        }
      }

      const issue = (await this.github('POST', `/repos/${repo}/issues`, {
        title: issueTitle(report),
        body: issueBody(report, reporter, this.deps.environment(), screenshotUrl),
        labels: issueLabels(report),
      })) as { number: number };

      this.lastSent = this.deps.now?.() ?? Date.now();
      const stamp = new Date(this.lastSent).toISOString();
      this.recent.set(issue.number, {
        at: this.lastSent,
        item: { number: issue.number, title: report.title, state: 'open', kind: report.kind, reporter, createdAt: stamp, updatedAt: stamp, comments: 0 },
      });
      return { number: issue.number, screenshot };
    } finally {
      this.sending = false;
    }
  }

  /** Saves the picture as a file in the repository and returns a link into it that the repository's readers can open. */
  private async saveScreenshot(repo: string, dataUrl: string, now: number): Promise<string> {
    const day = new Date(now).toISOString().slice(0, 10);
    const name = this.deps.id?.() ?? Math.random().toString(16).slice(2, 10);
    const content = dataUrl.slice(dataUrl.indexOf(',') + 1);

    const saved = (await this.github('PUT', `/repos/${repo}/contents/reports/${day}/${name}.jpg`, {
      message: 'Screenshot for a report',
      content,
    })) as { content?: { html_url?: string } };

    const link = saved.content?.html_url;
    if (typeof link !== 'string' || !link.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/`)) {
      throw new FeedbackServiceError('GitHub did not say where the screenshot went.');
    }
    return `${link}?raw=true`;
  }

  /** ---- Reading and replying ---- */

  async list(): Promise<FeedbackListItem[]> {
    const { repo } = await this.ready();
    const issues = (await this.github('GET', `/repos/${repo}/issues?state=all&labels=from-app&sort=updated&direction=desc&per_page=30`)) as Parameters<typeof isReportIssue>[0][];
    return this.withRecent(issues.filter(isReportIssue).map(parseIssue));
  }

  /** GitHub's list plus the reports sent from here that it does not show yet, in order of when each was last touched. */
  private withRecent(listed: FeedbackListItem[]): FeedbackListItem[] {
    const now = this.deps.now?.() ?? Date.now();
    const shown = new Set(listed.map((item) => item.number));
    for (const [number, { at }] of this.recent) {
      // Forgotten once GitHub shows it, or after two minutes: a report still missing by then was removed.
      if (shown.has(number) || now - at > RECENT_MS) this.recent.delete(number);
    }
    return [...[...this.recent.values()].map(({ item }) => item), ...listed].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async thread(number: unknown): Promise<FeedbackThread> {
    const n = this.number(number);
    const { repo } = await this.ready();

    const issue = (await this.github('GET', `/repos/${repo}/issues/${n}`)) as Parameters<typeof isReportIssue>[0] & { body?: string | null };
    if (!isReportIssue(issue)) throw new FeedbackInputError('That is not one of your reports.');

    const comments = (await this.github('GET', `/repos/${repo}/issues/${n}/comments?per_page=100`)) as Parameters<typeof parseComment>[0][];
    const { comments: _count, ...item } = parseIssue(issue);
    return { ...item, body: displayBody(issue.body), comments: comments.map(parseComment) };
  }

  async reply(number: unknown, text: unknown): Promise<FeedbackComment> {
    const n = this.number(number);
    const body = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
    if (!body) throw new FeedbackInputError('Write a reply first.');
    if (body.length > LIMITS.text) throw new FeedbackInputError(`The reply is too long (${LIMITS.text} characters at most).`);

    const { repo, reporter } = await this.ready();
    const created = (await this.github('POST', `/repos/${repo}/issues/${n}/comments`, { body: appCommentBody(reporter, body) })) as Parameters<typeof parseComment>[0];
    return parseComment(created);
  }

  /** ---- Internals ---- */

  private number(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new FeedbackInputError('That is not a report number.');
    return value;
  }

  /** The repository and name to report as, or a message saying what is missing. */
  private async ready(): Promise<Config> {
    const config = await this.readConfig();
    if (!config) throw new FeedbackInputError('Set up feedback in Settings first: a repository, your name and an access key.');
    if (!(await this.hasKey())) throw new FeedbackInputError('Add the access key in Settings > Feedback first.');
    return config;
  }

  private async readConfig(): Promise<Config | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.deps.dir, 'feedback.json'), 'utf8')) as Partial<Config>;
      return { repo: parseRepo(parsed.repo), reporter: parseReporter(parsed.reporter) };
    } catch {
      return null;
    }
  }

  private async hasKey(): Promise<boolean> {
    try {
      return (await stat(join(this.deps.dir, 'feedback-key.bin'))).isFile();
    } catch {
      return false;
    }
  }

  /** The key, decrypted for one request; null when it is missing or this Mac can no longer read it. */
  private async readKey(): Promise<string | null> {
    try {
      const bytes = await readFile(join(this.deps.dir, 'feedback-key.bin'));
      return this.deps.secure.decryptString(bytes) || null;
    } catch {
      return null;
    }
  }

  /** Runs `work` after the writes before it, so two saves never interleave. */
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work);
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Written whole to a file of its own and moved into place, readable by this person only; the temporary file never stays. */
  private async write(name: string, data: string | Buffer): Promise<void> {
    const target = join(this.deps.dir, name);
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  private async github(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const key = await this.readKey();
    if (key === null) throw new FeedbackInputError('The saved access key cannot be read. Paste it again in Settings > Feedback.');

    let response: Response;
    try {
      response = await this.deps.fetch(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${key}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `Blackout/${this.deps.environment().version}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new FeedbackServiceError('Could not reach GitHub. Check your internet connection and try again.');
    }

    if (!response.ok) throw await this.refusal(response, path);
    return response.status === 204 ? null : response.json();
  }

  private async refusal(response: Response, path: string): Promise<FeedbackServiceError> {
    const repo = /^\/repos\/([^/]+\/[^/?]+)/.exec(path)?.[1] ?? 'the repository';
    switch (response.status) {
      case 401:
        return new FeedbackServiceError('GitHub did not accept the access key. It may have expired: ask for a new one.');
      case 403:
      case 429:
        return new FeedbackServiceError(
          response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429
            ? 'GitHub asks to wait a little. Try again in a minute.'
            : `The access key is not allowed to do this. It needs Issues and Contents access to ${repo}.`,
        );
      case 404:
        return new FeedbackServiceError(`GitHub cannot find ${repo}, or the access key has no access to it.`);
      case 422:
        return new FeedbackServiceError('GitHub did not accept the report.');
      default:
        return new FeedbackServiceError(
          response.status >= 300 && response.status < 400
            ? `${repo} has moved. Update its name in Settings.`
            : `GitHub answered with an error (${response.status}). Try again in a moment.`,
        );
    }
  }
}
