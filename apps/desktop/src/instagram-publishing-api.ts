import type { InstagramPublishOperation, InstagramPublishResponse } from './instagram-publishing-types';
const identifier = (value: unknown): value is string => typeof value === 'string' && /^\d{1,40}$/.test(value);
export class InstagramPublishError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain: boolean) { super(message); this.uncertain = uncertain; }
}

/** Public HTTPS hosting is required by Instagram Login publishing. Never fetch the media URL locally. */
export function publicInstagramVideoUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Provide a public HTTPS video URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Provide a public HTTPS video URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !host.includes('.') ||
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    /^[\d.]+$/.test(host) || host.includes(':') || url.searchParams.has('access_token')) {
    throw new Error('Use a public HTTPS hostname for the exported video; local files, private addresses and credentials are not accepted.');
  }
  return url.href;
}

/** Only these fixed Graph operations can use the private credential. Errors never echo API text or URLs. */
export async function requestInstagramPublishing(request: typeof fetch, token: string, accountId: string, operation: InstagramPublishOperation): Promise<InstagramPublishResponse> {
  if (!identifier(accountId)) throw new Error('Invalid Instagram account.');
  const params = new URLSearchParams();
  let path: string;
  if (operation.kind === 'create') {
    if (typeof operation.caption !== 'string' || operation.caption.length > 2200 || typeof operation.shareToFeed !== 'boolean') throw new Error('Reel captions support up to 2,200 characters.');
    path = `${accountId}/media`;
    params.set('media_type', 'REELS'); params.set('video_url', publicInstagramVideoUrl(operation.videoUrl));
    params.set('caption', operation.caption); params.set('share_to_feed', String(operation.shareToFeed));
  } else {
    if (!identifier(operation.containerId)) throw new Error('Invalid Instagram container.');
    path = operation.kind === 'status' ? operation.containerId : `${accountId}/media_publish`;
    params.set(operation.kind === 'status' ? 'fields' : 'creation_id', operation.kind === 'status' ? 'status_code' : operation.containerId);
  }
  const url = new URL(`https://graph.instagram.com/v24.0/${path}`);
  const read = operation.kind === 'status';
  if (read) url.search = params.toString();
  let response: Response;
  let payload: Record<string, unknown> | null = null;
  try {
    response = await request(url, { method: read ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(!read ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(!read ? { body: params.toString() } : {}) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 64 * 1024) throw new Error('Oversized response'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) payload = value as Record<string, unknown>;
  } catch { throw new InstagramPublishError('Instagram did not confirm the request. Check its status before trying to publish again.', !read); }
  const error = payload?.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : null;
  if (!response.ok || error) {
    const code = typeof error?.code === 'number' ? error.code : null;
    const definite = !!error && response.status < 500;
    if (response.status === 401 || code === 190 || code === 102) throw new InstagramPublishError('Reconnect Instagram before publishing; its authorization expired or is invalid.', !definite && !read);
    if (response.status === 403 || code === 10 || code === 200) throw new InstagramPublishError('Instagram denied publishing. Reconnect with instagram_business_content_publish and ensure your app/account has access.', !definite && !read);
    if (response.status === 429 || [4, 17, 32, 613].includes(code ?? -1)) throw new InstagramPublishError('Instagram is limiting publishing requests. Wait and review this item before retrying.', !definite && !read);
    throw new InstagramPublishError('Instagram rejected this publishing request. Check the hosted video requirements, app permissions and account.', !definite && !read);
  }
  if (!payload) throw new InstagramPublishError('Instagram returned an unrecognized publishing response.', !read);
  if (read) {
    if (!['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(String(payload.status_code))) throw new InstagramPublishError('Instagram returned an unrecognized container status.', false);
    return { status: payload.status_code as InstagramPublishResponse['status'] };
  }
  if (!identifier(payload.id)) throw new InstagramPublishError('Instagram did not return the new media identifier. Check status before retrying.', true);
  return { id: payload.id };
}
