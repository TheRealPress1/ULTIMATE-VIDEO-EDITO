import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
const TTL = 10 * 60_000;
const opaque = () => randomBytes(32).toString('base64url');
const validOpaque = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const tokenValid = (value) => typeof value === 'string' && /^[A-Za-z0-9._~-]{20,8192}$/.test(value);
const json = (status, body) => ({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(body) });
const page = (success) => ({ status: success ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  body: `<!doctype html><html><head><title>UVE Instagram connection</title></head><body><h1>${success ? 'Instagram authorized' : 'Instagram connection did not finish'}</h1><p>${success ? 'Return to UVE to finish connecting. You can close this browser tab.' : 'Return to UVE and try connecting again.'}</p></body></html>` });

/** No cookies, redirects supplied by clients, persisted tokens, or arbitrary upstream URLs. */
export function createBroker({ publicUrl, clientId, clientSecret, fetch: request = globalThis.fetch, now = Date.now, maxFlows = 1000 }) {
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.search || base.hash || base.pathname !== '/' || !base.hostname.includes('.')) throw new Error('PUBLIC_URL must be an HTTPS origin.');
  if (!/^\d{1,40}$/.test(clientId ?? '') || typeof clientSecret !== 'string' || clientSecret.length < 16 || clientSecret.length > 512) throw new Error('Configure the server-only Instagram app ID and secret.');
  const callback = new URL('/v1/instagram/callback', base).href;
  const flows = new Map();
  const states = new Map();
  const prune = () => { for (const [id, flow] of flows) if (flow.expires <= now()) { flows.delete(id); states.delete(flow.state); flow.token = null; } };
  const cleanup = setInterval(prune, 30_000);
  cleanup.unref?.();
  async function upstream(url, options, allowSingleAccountEnvelope = false) {
    const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Authorization exchange failed.');
    const chunks = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 32 * 1024) throw new Error('Authorization exchange failed.'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok || !data || typeof data !== 'object' || data.error) throw new Error('Authorization exchange failed.');
    const account = allowSingleAccountEnvelope && !data.access_token && Array.isArray(data.data) && data.data.length === 1 ? data.data[0] : data;
    if (!account || typeof account !== 'object' || !tokenValid(account.access_token)) throw new Error('Authorization exchange failed.');
    return { access_token: account.access_token };
  }
  return {
    dispose() { clearInterval(cleanup); for (const flow of flows.values()) flow.token = null; flows.clear(); states.clear(); },
    async handle({ method, url: path, body, origin }) {
      prune();
      const url = new URL(path, base);
      if (url.origin !== base.origin) return json(400, { error: 'Invalid request.' });
      if (method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
      if (method === 'POST') {
        // Desktop main-process calls have no Origin. Cross-site browser calls are denied.
        if (origin) return json(403, { error: 'Browser API calls are not supported.' });
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid request.' });
        if (url.pathname === '/v1/instagram/start') {
          if (!validOpaque(body.challenge)) return json(400, { error: 'Invalid desktop binding.' });
          if (flows.size >= maxFlows) return json(503, { error: 'Authorization is busy. Try again later.' });
          const id = opaque(), state = opaque(), expires = now() + TTL;
          flows.set(id, { challenge: body.challenge, state, expires, status: 'pending', token: null }); states.set(state, id);
          const authorization = new URL('https://www.instagram.com/oauth/authorize');
          authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', state,
            scope: 'instagram_business_basic,instagram_business_manage_insights,instagram_business_content_publish', enable_fb_login: '0', force_authentication: '1' }).toString();
          return json(200, { id, authorizationUrl: authorization.href, expiresAt: new Date(expires).toISOString() });
        }
        if (['/v1/instagram/redeem', '/v1/instagram/cancel'].includes(url.pathname)) {
          if (!validOpaque(body.id) || !validOpaque(body.verifier)) return json(400, { error: 'Invalid request.' });
          const flow = flows.get(body.id);
          const hash = createHash('sha256').update(body.verifier).digest('base64url');
          if (!flow || !timingSafeEqual(Buffer.from(hash), Buffer.from(flow.challenge))) return json(404, { error: 'Authorization expired or is unavailable. Start again.' });
          if (url.pathname.endsWith('/cancel')) { flows.delete(body.id); states.delete(flow.state); flow.token = null; flow.status = 'cancelled'; return json(200, { cancelled: true }); }
          if (['pending', 'exchanging'].includes(flow.status)) return json(202, { status: 'pending' });
          flows.delete(body.id); states.delete(flow.state);
          if (flow.status !== 'ready' || !flow.token) return json(400, { error: 'Instagram authorization failed. Start again.' });
          const token = flow.token; flow.token = null;
          return json(200, { accessToken: token });
        }
      }
      if (method === 'GET' && url.pathname === '/v1/instagram/callback') {
        const state = url.searchParams.get('state');
        const id = validOpaque(state) ? states.get(state) : undefined;
        const flow = id ? flows.get(id) : undefined;
        if (!flow || flow.status !== 'pending') return page(false);
        states.delete(state); // Single-use before awaiting an exchange.
        flow.status = 'exchanging';
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code || code.length > 4096) { flow.status = 'failed'; return page(false); }
        try {
          const short = await upstream('https://api.instagram.com/oauth/access_token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', redirect_uri: callback, code }).toString(),
          }, true);
          if (flow.expires <= now() || flows.get(id) !== flow || flow.status === 'cancelled') return page(false);
          const exchange = new URL('https://graph.instagram.com/access_token');
          exchange.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: clientSecret, access_token: short.access_token }).toString();
          const long = await upstream(exchange, { method: 'GET', headers: { Accept: 'application/json' } });
          if (flow.expires <= now() || flows.get(id) !== flow || flow.status === 'cancelled') return page(false);
          flow.token = long.access_token; flow.status = 'ready';
          return page(true);
        } catch { if (flows.get(id) === flow) flow.status = 'failed'; return page(false); }
      }
      return json(404, { error: 'Not found.' });
    },
  };
}
