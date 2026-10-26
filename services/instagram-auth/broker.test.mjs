import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBroker } from './broker.mjs';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const secret = 'server-secret-not-for-desktop';
const token = 'IG_LONG_TEST_TOKEN_123456789012345';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(options = {}) {
  let now = Date.parse('2026-10-25T12:00:00Z');
  const calls = [];
  const broker = createBroker({ publicUrl: 'https://auth.example.com', clientId: '12345', clientSecret: secret, now: () => now,
    fetch: async (url, init) => { calls.push([String(url), init]); return json({ access_token: token }); }, ...options });
  const start = async () => { const result = await broker.handle({ method: 'POST', url: '/v1/instagram/start', body: { challenge } }); return JSON.parse(result.body); };
  const callback = (start) => broker.handle({ method: 'GET', url: `/v1/instagram/callback?state=${new URL(start.authorizationUrl).searchParams.get('state')}&code=TEST_CODE` });
  const redeem = (start, bound = verifier) => broker.handle({ method: 'POST', url: '/v1/instagram/redeem', body: { id: start.id, verifier: bound } });
  return { broker, start, callback, redeem, calls, advance: () => { now += 11 * 60_000; } };
}
test('binds authorization to a desktop verifier, exchanges only fixed Meta endpoints and redeems once', async () => {
  const f = fixture(), started = await f.start();
  assert.equal(new URL(started.authorizationUrl).origin, 'https://www.instagram.com');
  assert.equal(JSON.stringify(started).includes(secret), false);
  assert.equal((await f.redeem(started, 'b'.repeat(43))).status, 404);
  assert.equal((await f.redeem(started)).status, 202);
  const browser = await f.callback(started);
  assert.equal(browser.status, 200); assert.equal(browser.body.includes(token), false);
  assert.equal(f.calls[0][0], 'https://api.instagram.com/oauth/access_token');
  assert.equal(new URL(f.calls[1][0]).origin, 'https://graph.instagram.com');
  assert.equal(f.calls.every(([, options]) => options.redirect === 'error'), true);
  assert.equal(JSON.parse((await f.redeem(started)).body).accessToken, token);
  assert.equal((await f.redeem(started)).status, 404);
});
test('rejects forged state, duplicate callback and browser-origin API calls', async () => {
  const f = fixture(), started = await f.start();
  assert.equal((await f.broker.handle({ method: 'GET', url: '/v1/instagram/callback?state=bad&code=bad' })).status, 400);
  await f.callback(started);
  assert.equal((await f.callback(started)).status, 400); assert.equal(f.calls.length, 2);
  assert.equal((await f.broker.handle({ method: 'POST', url: '/v1/instagram/start', body: { challenge }, origin: 'https://attacker.example' })).status, 403);
});
test('expires bounded sessions without leaking authorization', async () => {
  const f = fixture({ maxFlows: 1 }), started = await f.start();
  assert.equal((await f.broker.handle({ method: 'POST', url: '/v1/instagram/start', body: { challenge } })).status, 503);
  f.advance(); assert.equal((await f.redeem(started)).status, 404); assert.equal((await f.callback(started)).status, 400);
  assert.equal(f.calls.length, 0); assert.ok((await f.start()).id);
});
test('cancellation invalidates callback and one-time redemption', async () => {
  const f = fixture(), started = await f.start();
  assert.equal((await f.broker.handle({ method: 'POST', url: '/v1/instagram/cancel', body: { id: started.id, verifier } })).status, 200);
  assert.equal((await f.callback(started)).status, 400); assert.equal((await f.redeem(started)).status, 404);
});
test('denied authorization never exchanges credentials', async () => {
  const f = fixture(), started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  assert.equal((await f.broker.handle({ method: 'GET', url: `/v1/instagram/callback?state=${state}&error=access_denied` })).status, 400);
  assert.equal((await f.redeem(started)).status, 400); assert.equal(f.calls.length, 0);
});
test('does not echo upstream errors, authorization codes, secrets or tokens into browser failures', async () => {
  const f = fixture({ fetch: async () => json({ error: { message: `${secret} ${token}` } }, 400) }), started = await f.start();
  const result = await f.callback(started);
  assert.equal(result.status, 400); assert.equal(result.body.includes(secret), false); assert.equal(result.body.includes(token), false);
  assert.equal((await f.redeem(started)).body.includes(secret), false);
});
test('requires an HTTPS public service and server-only secret', () => {
  assert.throws(() => createBroker({ publicUrl: 'http://localhost', clientId: '123', clientSecret: secret }));
  assert.throws(() => createBroker({ publicUrl: 'https://auth.example.com', clientId: '123', clientSecret: '' }));
});
test('consumes callback state before awaiting so concurrent callbacks cannot exchange twice', async () => {
  let finish;
  let requests = 0;
  const f = fixture({ fetch: async () => { requests++; return requests === 1 ? new Promise((resolve) => { finish = resolve; }) : json({ access_token: token }); } });
  const started = await f.start(); const first = f.callback(started);
  assert.equal((await f.callback(started)).status, 400);
  finish(json({ access_token: token })); assert.equal((await first).status, 200); assert.equal(requests, 2);
});
test('does not retain or redeem a token when cancellation arrives during exchange', async () => {
  let finish;
  let requests = 0;
  const f = fixture({ fetch: async () => { requests++; return requests === 1 ? new Promise((resolve) => { finish = resolve; }) : json({ access_token: token }); } });
  const started = await f.start(); const first = f.callback(started);
  await f.broker.handle({ method: 'POST', url: '/v1/instagram/cancel', body: { id: started.id, verifier } });
  finish(json({ access_token: token })); assert.equal((await first).status, 400); assert.equal((await f.redeem(started)).status, 404); assert.equal(requests, 1);
});
test('accepts a bounded single-account token envelope without accepting ambiguous multiple accounts', async () => {
  const f = fixture({ fetch: async (url) => String(url).includes('api.instagram.com') ? json({ data: [{ access_token: token, user_id: '101' }] }) : json({ access_token: token }) });
  const started = await f.start(); assert.equal((await f.callback(started)).status, 200); assert.equal(JSON.parse((await f.redeem(started)).body).accessToken, token);
  const invalid = fixture({ fetch: async () => json({ data: [{ access_token: token }, { access_token: token }] }) });
  const other = await invalid.start(); assert.equal((await invalid.callback(other)).status, 400);
});
