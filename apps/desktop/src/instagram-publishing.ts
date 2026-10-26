import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { InstagramPublishError, publicInstagramVideoUrl } from './instagram-publishing-api';
import type { InstagramPublishDraft, InstagramPublishItem, InstagramPublishOperation, InstagramPublishQueue, InstagramPublishResponse } from './instagram-publishing-types';
const UUID = /^[a-f0-9-]{36}$/i;
const STATES = ['draft', 'approved', 'preparing', 'processing', 'publishing', 'published', 'needs_review', 'failed', 'cancelled'];
const identifier = (value: unknown): value is string => typeof value === 'string' && /^\d{1,40}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const MAX_ITEMS = 200;

function draft(value: InstagramPublishDraft): InstagramPublishDraft {
  if (!value || !identifier(value.accountId) || typeof value.caption !== 'string' || value.caption.length > 2200 ||
    !date(value.scheduledAt) || typeof value.shareToFeed !== 'boolean') throw new Error('Choose an account, a caption up to 2,200 characters, and a valid publishing time.');
  return { accountId: value.accountId, videoUrl: publicInstagramVideoUrl(value.videoUrl), caption: value.caption,
    scheduledAt: new Date(value.scheduledAt).toISOString(), shareToFeed: value.shareToFeed };
}
function item(value: unknown): InstagramPublishItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid queue');
  const row = value as InstagramPublishItem;
  if (!UUID.test(row.id) || !UUID.test(row.revision) || !STATES.includes(row.state) || !date(row.createdAt) ||
    (row.approvedAt !== null && !date(row.approvedAt)) || (row.containerId !== null && !identifier(row.containerId)) ||
    (row.mediaId !== null && !identifier(row.mediaId)) || (row.publishedAt !== null && !date(row.publishedAt)) ||
    (row.error !== null && (typeof row.error !== 'string' || row.error.length > 1000))) throw new Error('Invalid queue');
  if (['approved', 'preparing', 'processing', 'publishing', 'published'].includes(row.state) && !row.approvedAt) throw new Error('Invalid approval');
  if (['processing', 'publishing', 'published'].includes(row.state) && !row.containerId) throw new Error('Invalid container');
  return { ...draft(row), id: row.id, revision: row.revision, state: row.state, createdAt: row.createdAt,
    approvedAt: row.approvedAt, containerId: row.containerId, mediaId: row.mediaId, publishedAt: row.publishedAt, error: row.error };
}

export interface InstagramPublishingOptions {
  storageDirectory: string;
  request: (accountId: string, operation: InstagramPublishOperation) => Promise<InstagramPublishResponse>;
  now?: () => Date;
}

/** A durable outbox. Only explicit approval makes a draft eligible for outbound calls. */
export class InstagramPublishingService {
  private items: InstagramPublishItem[] = [];
  private loaded = false;
  private broken: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private cancelled = new Set<string>();
  private publishingRequests = new Set<string>();
  private disposed = false;
  private pauses = 0;
  private readonly now: () => Date;
  private readonly options: InstagramPublishingOptions;
  constructor(options: InstagramPublishingOptions) { this.options = options; this.now = options.now ?? (() => new Date()); }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn); this.chain = run.catch(() => {}); return run;
  }
  private snapshotValue(): InstagramPublishQueue { return { items: structuredClone(this.items), error: this.broken }; }
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const path = join(this.options.storageDirectory, 'publishing.json');
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid queue');
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('items' in value) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw new Error('Invalid queue');
      this.items = value.items.map(item);
      if (new Set(this.items.map((row) => row.id)).size !== this.items.length) throw new Error('Duplicate queue IDs');
      let recovered = false;
      this.items = this.items.map((row) => {
        if (!['preparing', 'publishing'].includes(row.state)) return row;
        recovered = true;
        return { ...row, revision: randomUUID(), state: 'needs_review', error: 'The app stopped during an outbound request. Check Instagram before creating another post; this item will not retry automatically.' };
      });
      if (recovered) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.items = [];
      this.broken = 'The local publishing queue could not be read safely. Preserve instagram/publishing.json before repairing it; publishing is disabled.';
    }
  }
  private writable(): void { if (this.broken) throw new Error(this.broken); if (this.disposed) throw new Error('Publishing has stopped.'); }
  private async save(): Promise<void> {
    this.writable();
    await mkdir(this.options.storageDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.storageDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Publishing storage must be a real local directory.');
    const target = join(this.options.storageDirectory, 'publishing.json');
    const temporary = join(this.options.storageDirectory, `.publishing-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, items: this.items })); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      if (process.platform !== 'win32') { const handle = await open(this.options.storageDirectory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
    } catch (error) {
      this.broken = 'The publishing queue could not be saved. Publishing is paused to avoid duplicate or unapproved posts. Restart after checking local storage.';
      throw error;
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  private find(id: string): InstagramPublishItem { const row = this.items.find((entry) => entry.id === id); if (!row) throw new Error('This queue item no longer exists. Refresh the queue.'); return row; }
  private async transition(row: InstagramPublishItem, patch: Partial<InstagramPublishItem>): Promise<void> {
    Object.assign(row, patch, { revision: randomUUID() }); await this.save();
  }
  snapshot(): Promise<InstagramPublishQueue> { return this.serialized(async () => { await this.load(); return this.snapshotValue(); }); }
  /** Changing credentials invalidates outstanding approvals, including future schedules. */
  pauseApproved(): Promise<void> {
    this.pauses++;
    return this.serialized(async () => {
      try {
        await this.load(); this.writable();
        let changed = false;
        for (const row of this.items) {
          if (!['approved', 'preparing', 'processing', 'publishing'].includes(row.state)) continue;
          Object.assign(row, { state: 'needs_review', revision: randomUUID(), error: 'The Instagram connection changed. This approval is paused. Review the account and create a newly approved draft before publishing.' });
          changed = true;
        }
        if (changed) await this.save();
      } finally { this.pauses--; }
    });
  }
  create(input: InstagramPublishDraft): Promise<InstagramPublishQueue> {
    const copy = draft(input);
    return this.serialized(async () => {
      await this.load(); this.writable();
      if (this.items.length >= MAX_ITEMS) throw new Error('The publishing queue is full. Remove completed or cancelled items first.');
      if (Date.parse(copy.scheduledAt) > this.now().getTime() + 365 * 86400_000) throw new Error('Schedule within the next year.');
      this.items.push({ ...copy, id: randomUUID(), revision: randomUUID(), state: 'draft', createdAt: this.now().toISOString(), approvedAt: null,
        containerId: null, mediaId: null, publishedAt: null, error: null });
      await this.save(); return this.snapshotValue();
    });
  }
  approve(id: string, revision: string): Promise<InstagramPublishQueue> {
    return this.serialized(async () => {
      await this.load(); this.writable(); const row = this.find(id);
      if (row.state !== 'draft' || row.revision !== revision) throw new Error('This draft changed. Review its current account, video, caption and time before approving.');
      await this.transition(row, { state: 'approved', approvedAt: this.now().toISOString(), error: null });
      return this.snapshotValue();
    });
  }
  cancel(id: string): Promise<InstagramPublishQueue> {
    if (this.publishingRequests.has(id)) return Promise.reject(new Error('Instagram is already receiving the publish request. Wait for its result; cancelling now cannot reliably prevent publication.'));
    this.cancelled.add(id);
    return this.serialized(async () => {
      try {
        await this.load(); this.writable(); const row = this.find(id);
        if (['published', 'publishing'].includes(row.state)) throw new Error('This item has already been sent to Instagram.');
        await this.transition(row, { state: 'cancelled', error: null }); return this.snapshotValue();
      } finally { this.cancelled.delete(id); }
    });
  }
  remove(id: string): Promise<InstagramPublishQueue> {
    return this.serialized(async () => {
      await this.load(); this.writable(); const row = this.find(id);
      if (!['draft', 'cancelled', 'published', 'failed'].includes(row.state)) throw new Error('Cancel or reconcile this active item before removing it.');
      this.items = this.items.filter((entry) => entry.id !== id); await this.save(); return this.snapshotValue();
    });
  }
  /** Safe read-only reconciliation; never retries an ambiguous publish. */
  reconcile(id: string): Promise<InstagramPublishQueue> {
    return this.serialized(async () => {
      await this.load(); this.writable(); const row = this.find(id);
      if (!row.containerId || !['needs_review', 'processing'].includes(row.state)) throw new Error('This item has no pending container to inspect.');
      const result = await this.options.request(row.accountId, { kind: 'status', containerId: row.containerId });
      if (result.status === 'PUBLISHED') await this.transition(row, { state: 'published', publishedAt: this.now().toISOString(), error: 'Instagram confirms publication. The media ID was not returned; verify the post in Instagram.' });
      else if (row.state === 'needs_review') await this.transition(row, { error: `Container status: ${result.status ?? 'unknown'}. Publication remains uncertain; inspect Instagram before posting again.` });
      else if (result.status === 'ERROR' || result.status === 'EXPIRED') await this.transition(row, { state: 'failed', error: 'Instagram could not process this hosted video or its container expired. Create a new reviewed draft after fixing the source.' });
      return this.snapshotValue();
    });
  }
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      await this.serialized(async () => {
        await this.load(); if (this.broken || this.disposed || this.pauses) return;
        const row = this.items.find((entry) => ['approved', 'processing'].includes(entry.state) && Date.parse(entry.scheduledAt) <= this.now().getTime());
        if (!row || this.cancelled.has(row.id)) return;
        if (this.now().getTime() - Math.max(Date.parse(row.scheduledAt), Date.parse(row.approvedAt!)) > 24 * 3600_000) {
          await this.transition(row, { state: 'needs_review', error: 'This approved item is over 24 hours late. It will not publish automatically. Review Instagram, cancel this item, and create a newly approved draft if you still want to post it.' });
          return;
        }
        try {
          if (row.state === 'approved') {
            await this.transition(row, { state: 'preparing' });
            const response = await this.options.request(row.accountId, { kind: 'create', videoUrl: row.videoUrl, caption: row.caption, shareToFeed: row.shareToFeed });
            if (!identifier(response.id)) throw new InstagramPublishError('Instagram did not confirm a container ID.', true);
            await this.transition(row, { state: 'processing', containerId: response.id });
          }
          if (this.disposed || this.pauses || this.cancelled.has(row.id)) return;
          const response = await this.options.request(row.accountId, { kind: 'status', containerId: row.containerId! });
          if (this.disposed || this.pauses || this.cancelled.has(row.id)) return;
          if (response.status === 'IN_PROGRESS') return;
          if (response.status === 'PUBLISHED') { await this.transition(row, { state: 'published', publishedAt: this.now().toISOString() }); return; }
          if (response.status !== 'FINISHED') { await this.transition(row, { state: 'failed', error: 'Instagram could not process this hosted video or its container expired. Review its format and URL.' }); return; }
          await this.transition(row, { state: 'publishing' });
          if (this.cancelled.has(row.id)) { await this.transition(row, { state: 'cancelled' }); return; }
          if (this.disposed || this.pauses) return; // On restart this persisted state requires review.
          this.publishingRequests.add(row.id);
          const published = await this.options.request(row.accountId, { kind: 'publish', containerId: row.containerId! });
          if (!identifier(published.id)) throw new InstagramPublishError('Publication returned no media ID. Inspect Instagram before trying again.', true);
          await this.transition(row, { state: 'published', mediaId: published.id, publishedAt: this.now().toISOString(), error: null });
        } catch (error) {
          if (this.broken || this.disposed) return;
          const uncertain = error instanceof InstagramPublishError ? error.uncertain : row.state === 'publishing';
          await this.transition(row, { state: uncertain ? 'needs_review' : 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : 'Publishing stopped. Review this item.' });
        } finally { this.publishingRequests.delete(row.id); }
      });
    } finally { this.ticking = false; }
  }
  start(): void { if (this.timer || this.disposed) return; this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30_000); this.timer.unref?.(); }
  dispose(): void { this.disposed = true; clearInterval(this.timer); this.timer = undefined; }
}
