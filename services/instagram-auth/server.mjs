import { createServer } from 'node:http';
import { createBroker } from './broker.mjs';
const broker = createBroker({ publicUrl: process.env.PUBLIC_URL, clientId: process.env.INSTAGRAM_APP_ID, clientSecret: process.env.INSTAGRAM_APP_SECRET });
const clients = new Map();
const server = createServer(async (request, response) => {
  try {
    const now = Date.now();
    // Do not trust forwarded IP headers. Configure ingress rate limits too.
    const address = request.socket.remoteAddress ?? 'unknown';
    for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
    if (!clients.has(address) && clients.size >= 10000) { response.writeHead(429, { 'Cache-Control': 'no-store' }); response.end('Try again later.'); return; }
    const client = clients.get(address) ?? { count: 0, until: now + 60_000 };
    client.count++; clients.set(address, client);
    if (client.count > 180) { response.writeHead(429, { 'Cache-Control': 'no-store' }); response.end('Try again later.'); return; }
    let body;
    if (request.method === 'POST') {
      if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415); response.end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8192) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const result = await broker.handle({ method: request.method, url: request.url, body, origin: request.headers.origin });
    response.writeHead(result.status, result.headers); response.end(result.body);
  } catch { response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end('Request could not be completed.'); }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1');
// No request/URL/body logs: OAuth callback codes and exchange queries are credentials.
