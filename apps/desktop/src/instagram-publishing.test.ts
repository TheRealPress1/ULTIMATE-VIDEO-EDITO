import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstagramPublishingService } from './instagram-publishing';
import { InstagramPublishError, publicInstagramVideoUrl, requestInstagramPublishing } from './instagram-publishing-api';
import type { InstagramPublishDraft, InstagramPublishOperation, InstagramPublishResponse } from './instagram-publishing-types';
let dir: string;
let now: Date;
let services: InstagramPublishingService[];
const draft = (): InstagramPublishDraft => ({ accountId: '101', videoUrl: 'https://media.example.com/export.mp4', caption: 'Reviewed Reel', scheduledAt: now.toISOString(), shareToFeed: true });
const request = () => vi.fn(async (_account: string, operation: InstagramPublishOperation): Promise<InstagramPublishResponse> => operation.kind === 'create' ? { id: '201' } : operation.kind === 'status' ? { status: 'FINISHED' } : { id: '301' });
function service(api = request()) { const value = new InstagramPublishingService({ storageDirectory: dir, request: api, now: () => now }); services.push(value); return { service: value, api }; }
async function approved(value: InstagramPublishingService, input = draft()) {
  const created = (await value.create(input)).items.at(-1)!;
  return (await value.approve(created.id, created.revision)).items.at(-1)!;
}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'uve-instagram-publish-')); now = new Date('2026-10-25T12:00:00Z'); services = []; });
afterEach(async () => { for (const value of services) value.dispose(); await rm(dir, { recursive: true, force: true }); });
describe('approved local publishing queue (mock API only)', () => {
  it('makes no outbound calls for drafts or future approvals', async () => {
    const f = service(); const created = (await f.service.create(draft())).items[0]!;
    await f.service.tick(); expect(f.api).not.toHaveBeenCalled();
    await expect(f.service.approve(created.id, 'stale')).rejects.toThrow('draft changed');
    await f.service.remove(created.id);
    await approved(f.service, { ...draft(), scheduledAt: new Date(now.getTime() + 60_000).toISOString() });
    await f.service.tick(); expect(f.api).not.toHaveBeenCalled();
  });
  it('persists approval before ordered creation/status/publication and never republishes after restart', async () => {
    const f = service(); await approved(f.service);
    await f.service.tick();
    expect(f.api.mock.calls.map(([, operation]) => operation.kind)).toEqual(['create', 'status', 'publish']);
    expect((await f.service.snapshot()).items[0]).toMatchObject({ state: 'published', mediaId: '301', containerId: '201' });
    const reopened = service(); await reopened.service.tick(); expect(reopened.api).not.toHaveBeenCalled();
  });
  it('continues a saved processing container after restart without creating it twice', async () => {
    const f = service(); f.api.mockImplementation(async (_account, operation) => operation.kind === 'create' ? { id: '201' } : { status: 'IN_PROGRESS' });
    await approved(f.service); await f.service.tick();
    expect((await f.service.snapshot()).items[0]!.state).toBe('processing');
    const reopened = service(); await reopened.service.tick();
    expect(reopened.api.mock.calls.map(([, operation]) => operation.kind)).toEqual(['status', 'publish']);
  });
  it('records ambiguous publication for review and does not retry, even if a later status says FINISHED', async () => {
    const f = service();
    f.api.mockImplementation(async (_account, operation) => {
      if (operation.kind === 'publish') throw new InstagramPublishError('Response lost; check Instagram.', true);
      return operation.kind === 'create' ? { id: '201' } : { status: 'FINISHED' };
    });
    const row = await approved(f.service); await f.service.tick();
    expect((await f.service.snapshot()).items[0]!.state).toBe('needs_review');
    await f.service.tick(); await f.service.reconcile(row.id); await f.service.tick();
    expect(f.api.mock.calls.filter(([, operation]) => operation.kind === 'publish')).toHaveLength(1);
    expect((await f.service.snapshot()).items[0]!.state).toBe('needs_review');
  });
  it('recovers an interrupted publish conservatively and can confirm PUBLISHED without sending another publish', async () => {
    const f = service(); await approved(f.service);
    const path = join(dir, 'publishing.json'); const value = JSON.parse(await readFile(path, 'utf8'));
    value.items[0].state = 'publishing'; value.items[0].containerId = '201'; await writeFile(path, JSON.stringify(value));
    const reopened = service(); reopened.api.mockResolvedValue({ status: 'PUBLISHED' });
    expect((await reopened.service.snapshot()).items[0]!.state).toBe('needs_review');
    await reopened.service.tick(); expect(reopened.api).not.toHaveBeenCalled();
    await reopened.service.reconcile(value.items[0].id);
    expect((await reopened.service.snapshot()).items[0]).toMatchObject({ state: 'published', mediaId: null });
    expect(reopened.api.mock.calls[0]![1].kind).toBe('status');
  });
  it('honors cancellation while a processing status request is pending', async () => {
    const f = service(); let finish!: (value: InstagramPublishResponse) => void;
    f.api.mockImplementation(async (_account, operation) => operation.kind === 'create' ? { id: '201' } : new Promise((resolve) => { finish = resolve; }));
    const row = await approved(f.service); const work = f.service.tick();
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledTimes(2));
    const cancelled = f.service.cancel(row.id); finish({ status: 'FINISHED' });
    await work; await cancelled;
    expect((await f.service.snapshot()).items[0]!.state).toBe('cancelled');
    expect(f.api.mock.calls.some(([, operation]) => operation.kind === 'publish')).toBe(false);
  });
  it('stops approvals more than 24 hours late for review without network traffic', async () => {
    const f = service(); await approved(f.service); now = new Date(now.getTime() + 25 * 3600_000); await f.service.tick();
    expect((await f.service.snapshot()).items[0]).toMatchObject({ state: 'needs_review', error: expect.stringContaining('24 hours late') });
    expect(f.api).not.toHaveBeenCalled();
  });
  it('fails closed on damaged queues and preserves their bytes', async () => {
    const path = join(dir, 'publishing.json'); await writeFile(path, '{broken'); const f = service();
    expect((await f.service.snapshot()).error).toContain('could not be read safely');
    await f.service.tick(); await expect(f.service.create(draft())).rejects.toThrow('could not be read safely');
    expect(await readFile(path, 'utf8')).toBe('{broken'); expect(f.api).not.toHaveBeenCalled();
  });
  it('pauses future approvals when credentials change and never resumes them on reconnect', async () => {
    const f = service(); await approved(f.service, { ...draft(), scheduledAt: new Date(now.getTime() + 60_000).toISOString() });
    await f.service.pauseApproved(); now = new Date(now.getTime() + 120_000);
    const reopened = service(); await reopened.service.tick();
    expect((await reopened.service.snapshot()).items[0]!.state).toBe('needs_review'); expect(reopened.api).not.toHaveBeenCalled();
  });
  it('does not retry permission failures and removes only local records', async () => {
    const f = service(); f.api.mockRejectedValue(new InstagramPublishError('Missing instagram_business_content_publish.', false));
    const row = await approved(f.service); await f.service.tick(); await f.service.tick();
    expect((await f.service.snapshot()).items[0]!.state).toBe('failed'); expect(f.api).toHaveBeenCalledOnce();
    await f.service.remove(row.id); expect((await f.service.snapshot()).items).toEqual([]); expect(f.api).toHaveBeenCalledOnce();
  });
});

describe('publishing API boundary', () => {
  it.each(['http://example.com/video.mp4', 'https://127.0.0.1/video.mp4', 'https://user:secret@example.com/a', 'file:///tmp/video.mp4', 'https://host.local/a'])('rejects nonpublic media addresses: %s', (url) => { expect(() => publicInstagramVideoUrl(url)).toThrow(); });
  it('pins Graph origin, sends tokens in headers and posts form fields rather than leaking tokens into URLs', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: '201' }), { status: 200 }));
    await requestInstagramPublishing(fetcher, 'PRIVATE_TOKEN', '101', { kind: 'create', videoUrl: draft().videoUrl, caption: 'literal & caption', shareToFeed: true });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('https://graph.instagram.com/v24.0/101/media'); expect(url.href).not.toContain('PRIVATE_TOKEN');
    expect(init.redirect).toBe('error'); expect(init.headers).toMatchObject({ Authorization: 'Bearer PRIVATE_TOKEN' });
    expect(new URLSearchParams(String(init.body)).get('caption')).toBe('literal & caption');
  });
  it('classifies permission failures without echoing upstream tokens or captions', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 200, message: 'PRIVATE_TOKEN' } }), { status: 403 }));
    await expect(requestInstagramPublishing(fetcher, 'PRIVATE_TOKEN', '101', { kind: 'publish', containerId: '201' })).rejects.toMatchObject({ uncertain: false, message: expect.stringContaining('instagram_business_content_publish') });
  });
  it('classifies a missing publish reply as uncertain rather than safely retryable', async () => {
    await expect(requestInstagramPublishing(vi.fn(async () => { throw new Error('network'); }), 'TOKEN', '101', { kind: 'publish', containerId: '201' })).rejects.toMatchObject({ uncertain: true });
  });
});
