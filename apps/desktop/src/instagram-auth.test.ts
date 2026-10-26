import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InstagramAuthService } from './instagram-auth';
import type { InstagramDashboard } from './instagram-types';
const now = Date.parse('2026-10-25T12:00:00Z');
const id = 'a'.repeat(43), state = 'b'.repeat(43), token = 'IG_TEST_TOKEN_12345678901234567890';
const start = { id, expiresAt: new Date(now + 600_000).toISOString(), authorizationUrl: `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ state, client_id: '123', response_type: 'code', redirect_uri: 'https://auth.example.com/v1/instagram/callback', scope: 'instagram_business_basic,instagram_business_manage_insights,instagram_business_content_publish' })}` };
const dashboard = { status: 'connected', account: { id: '101' }, error: null } as InstagramDashboard;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe('desktop Instagram browser authorization', () => {
  it('is honestly unconfigured without an HTTPS broker and never makes a request', async () => {
    const request = vi.fn(); const auth = new InstagramAuthService({ fetch: request, connect: vi.fn() });
    expect(auth.status().configured).toBe(false); await expect(auth.start()).rejects.toThrow('not configured'); expect(request).not.toHaveBeenCalled();
  });
  it('keeps binding and tokens in main and returns only the connected dashboard', async () => {
    const request = vi.fn(async (url: Parameters<typeof fetch>[0], _init?: RequestInit) => String(url).endsWith('/start') ? json(start) : json({ accessToken: token }));
    const connect = vi.fn(async () => dashboard);
    const auth = new InstagramAuthService({ brokerUrl: 'https://auth.example.com', fetch: request as typeof fetch, connect, now: () => now });
    const begun = await auth.start(); expect(begun).not.toHaveProperty('id');
    const result = await auth.poll(); expect(result.dashboard).toEqual(dashboard); expect(JSON.stringify(result)).not.toContain(token);
    expect(connect).toHaveBeenCalledWith(token);
    const challenge = JSON.parse(String(request.mock.calls[0]![1]!.body)).challenge;
    const verifier = JSON.parse(String(request.mock.calls[1]![1]!.body)).verifier;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(auth.status().pending).toBe(false);
  });
  it('rejects unexpected browser origins and invalid service configuration', async () => {
    expect(() => new InstagramAuthService({ brokerUrl: 'http://localhost', connect: vi.fn() })).toThrow('HTTPS');
    const auth = new InstagramAuthService({ brokerUrl: 'https://auth.example.com', fetch: vi.fn(async () => json({ ...start, authorizationUrl: `https://evil.example/oauth?state=${state}` })), connect: vi.fn(), now: () => now });
    await expect(auth.start()).rejects.toThrow('unexpected sign-in address'); expect(auth.status().pending).toBe(false);
  });
  it('never saves a token from a poll that completes after cancellation', async () => {
    let finish!: (value: Response) => void;
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).endsWith('/start') ? json(start) : String(url).endsWith('/cancel') ? json({ cancelled: true }) : new Promise<Response>((resolve) => { finish = resolve; }));
    const connect = vi.fn(); const auth = new InstagramAuthService({ brokerUrl: 'https://auth.example.com', fetch: request as typeof fetch, connect, now: () => now });
    await auth.start(); const polling = auth.poll(); await vi.waitFor(() => expect(finish).toBeDefined()); await auth.cancel(); finish(json({ accessToken: token }));
    expect((await polling).dashboard).toBeNull(); expect(connect).not.toHaveBeenCalled();
  });
  it('does not report cancellation while the authorized connection is already being saved', async () => {
    let finish!: (value: InstagramDashboard) => void;
    const connect = vi.fn(() => new Promise<InstagramDashboard>((resolve) => { finish = resolve; }));
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).endsWith('/start') ? json(start) : json({ accessToken: token }));
    const auth = new InstagramAuthService({ brokerUrl: 'https://auth.example.com', fetch: request as typeof fetch, connect, now: () => now });
    await auth.start(); const polling = auth.poll(); await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await expect(auth.cancel()).rejects.toThrow('being saved'); finish(dashboard); expect((await polling).dashboard).toEqual(dashboard);
  });
  it('reports token exchange failures with fixed text rather than leaked remote errors', async () => {
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).endsWith('/start') ? json(start) : json({ error: token }, 400));
    const auth = new InstagramAuthService({ brokerUrl: 'https://auth.example.com', fetch: request as typeof fetch, connect: vi.fn(), now: () => now });
    await auth.start(); const result = await auth.poll(); expect(result.status.error).toContain('could not complete'); expect(JSON.stringify(result)).not.toContain(token);
  });
  it('provides a disconnect barrier that waits for a pending authorized credential save', async () => {
    let finish!: (value: InstagramDashboard) => void;
    const connect = vi.fn(() => new Promise<InstagramDashboard>((resolve) => { finish = resolve; }));
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).endsWith('/start') ? json(start) : json({ accessToken: token }));
    const auth = new InstagramAuthService({ brokerUrl: 'https://auth.example.com', fetch: request as typeof fetch, connect, now: () => now });
    await auth.start(); const polling = auth.poll(); await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    let disconnected = false;
    const removal = auth.cancel(true).then(() => { disconnected = true; });
    await Promise.resolve(); expect(disconnected).toBe(false);
    finish(dashboard); await polling; await removal;
    expect(disconnected).toBe(true); expect(auth.status().pending).toBe(false);
  });
});
