import { createHash, randomBytes } from 'node:crypto';
import type { InstagramDashboard } from './instagram-types';
import type { InstagramAuthStatus } from './instagram-publishing-types';
export type InstagramAuthPoll = { status: InstagramAuthStatus; dashboard: InstagramDashboard | null };
export interface InstagramAuthOptions {
  brokerUrl?: string;
  connect: (token: string) => Promise<InstagramDashboard>;
  fetch?: typeof fetch;
  now?: () => number;
}
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

/** Verifier and redeemed token stay in main; renderer receives only connection state. */
export class InstagramAuthService {
  private readonly options: InstagramAuthOptions;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly broker: string | null;
  private current: { id: string; verifier: string; expiresAt: string } | null = null;
  private error: string | null = null;
  private busy = false;
  private saving = false;
  private savingTask?: Promise<InstagramDashboard>;
  private generation = 0;
  constructor(options: InstagramAuthOptions) {
    this.options = options; this.request = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
    if (!options.brokerUrl) { this.broker = null; return; }
    const url = new URL(options.brokerUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.')) throw new Error('Instagram authorization requires a configured HTTPS service origin.');
    this.broker = url.origin;
  }
  status(): InstagramAuthStatus {
    if (this.current && Date.parse(this.current.expiresAt) <= this.now()) { this.current = null; this.generation++; this.error = 'Instagram sign-in expired. Start again.'; }
    return { configured: !!this.broker, pending: !!this.current, expiresAt: this.current?.expiresAt ?? null, error: this.error };
  }
  private async post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    if (!this.broker) throw new Error('Browser sign-in is not configured. Set up the HTTPS authorization service first, or use a developer token.');
    try {
      const response = await this.request(new URL(path, this.broker), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(25_000) });
      const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16 * 1024) throw new Error('Oversized response'); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Failed response');
      return { status: response.status, data: data as Record<string, unknown> };
    } catch { throw new Error('The Instagram authorization service could not complete the request. Start sign-in again or check its configuration.'); }
  }
  async start(): Promise<{ authorizationUrl: string; expiresAt: string }> {
    if (this.busy || this.status().pending) throw new Error('Instagram sign-in is already in progress. Finish or cancel it first.');
    const generation = ++this.generation;
    this.busy = true; this.error = null;
    const verifier = randomBytes(32).toString('base64url');
    try {
      const { data } = await this.post('/v1/instagram/start', { challenge: createHash('sha256').update(verifier).digest('base64url') });
      if (!opaque(data.id) || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= this.now() || Date.parse(data.expiresAt) > this.now() + 11 * 60_000 || typeof data.authorizationUrl !== 'string') throw new Error('The authorization service returned invalid sign-in data.');
      const authorization = new URL(data.authorizationUrl);
      const scopes = authorization.searchParams.get('scope')?.split(',').sort().join(',');
      if (authorization.origin !== 'https://www.instagram.com' || authorization.pathname !== '/oauth/authorize' || authorization.username || authorization.password || authorization.hash ||
        !opaque(authorization.searchParams.get('state')) || authorization.searchParams.get('redirect_uri') !== `${this.broker}/v1/instagram/callback` ||
        authorization.searchParams.get('response_type') !== 'code' || !/^\d{1,40}$/.test(authorization.searchParams.get('client_id') ?? '') ||
        scopes !== 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights') throw new Error('The authorization service returned an unexpected sign-in address.');
      if (generation !== this.generation) { void this.post('/v1/instagram/cancel', { id: data.id, verifier }).catch(() => {}); throw new Error('Instagram sign-in cancelled.'); }
      this.current = { id: data.id, verifier, expiresAt: data.expiresAt };
      return { authorizationUrl: authorization.href, expiresAt: data.expiresAt };
    } catch (error) { if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Instagram sign-in failed.'; throw error; }
    finally { this.busy = false; }
  }
  async poll(): Promise<InstagramAuthPoll> {
    if (this.busy || !this.status().pending || !this.current) return { status: this.status(), dashboard: null };
    const current = this.current, generation = this.generation;
    this.busy = true;
    try {
      const { status, data } = await this.post('/v1/instagram/redeem', { id: current.id, verifier: current.verifier });
      if (generation !== this.generation || this.current !== current) return { status: this.status(), dashboard: null };
      if (status === 202 && data.status === 'pending') return { status: this.status(), dashboard: null };
      this.current = null;
      if (typeof data.accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,8192}$/.test(data.accessToken)) throw new Error('The authorization service returned an invalid authorization.');
      this.saving = true;
      this.savingTask = this.options.connect(data.accessToken);
      const dashboard = await this.savingTask;
      this.error = dashboard.error;
      return { status: this.status(), dashboard };
    } catch (error) {
      if (generation === this.generation) { this.current = null; this.error = error instanceof Error ? error.message : 'Instagram sign-in failed.'; }
      return { status: this.status(), dashboard: null };
    } finally { this.busy = false; this.saving = false; this.savingTask = undefined; }
  }
  async cancel(waitForSave = false): Promise<InstagramAuthStatus> {
    if (this.saving) {
      if (!waitForSave) throw new Error('Instagram authorization is being saved. Wait for the connection result before disconnecting.');
      // Disconnect must wait for a committed connection, including any queue
      // pause that runs before its credential write, so it cannot reappear later.
      await this.savingTask?.catch(() => {});
    }
    const current = this.current; this.current = null; this.generation++; this.error = null;
    if (current) await this.post('/v1/instagram/cancel', { id: current.id, verifier: current.verifier }).catch(() => {});
    return this.status();
  }
}
