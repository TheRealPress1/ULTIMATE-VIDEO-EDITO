/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The only way out for yt-dlp. yt-dlp does its own networking, and the links
// it is handed come from agents, which read them anywhere: without a gate, a
// link (or a redirect, or a manifest that names another host) could point it
// at this machine or the local network, around the refusals web_media_*
// enforce in-process (see ../web-media-url). So every yt-dlp run gets
// `--proxy` pointing here: a proxy on loopback that takes CONNECT tunnels and
// plain-http requests to ports 80 and 443 only, resolves each host itself,
// refuses a host when any of its addresses is not public, and connects to the
// address it checked, so a name that answers differently the second time
// (DNS rebinding) gets nowhere either.
//
// Each run opens its own session: fresh random credentials, its own byte
// count (the callers' size caps) and its own list of refused hosts (the
// reason a failed run gives). Closing the session cuts its connections, and
// its credentials stop working. Logs name hosts, never paths: a media URL's
// path and query often carry signed tokens.
//
// Not yet: chaining to a proxy the Mac is set up to use. Forcing `--proxy`
// takes yt-dlp off the system proxy, so a network that only lets traffic out
// through one blocks platform downloads until that lands.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { resolvePublic, systemResolve } from "../web-media-url";

import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Resolve, ResolvedAddress } from "../web-media-url";

/** The ports yt-dlp may reach: the web's. Media CDNs on other ports are refused. */
export const EGRESS_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Opens a TCP connection to a checked address; a test points it at a local server. */
export type Dial = (address: ResolvedAddress, port: number) => Socket;

export type EgressProxyOptions = {
  resolve?: Resolve;
  dial?: Dial;
  /** One line per refused or failed connection, hosts only. */
  log?: (line: string) => void;
  /** How long one connection attempt may take before the next address is tried. */
  connectTimeoutMs?: number;
};

export type EgressSessionOptions = {
  /** Received bytes past which every connection of the session is cut. */
  maxBytes?: number;
  /** Bytes moved either way: a run's sign of life. */
  onActivity?: () => void;
  /** Called once, when the session goes over `maxBytes`. */
  onLimit?: () => void;
};

/** One run's way out. */
export interface EgressSession {
  /** For yt-dlp's `--proxy`: `http://user:password@127.0.0.1:port`. */
  readonly url: string;
  /** Bytes received from the internet so far. */
  bytes(): number;
  /** Hosts the session reached. */
  hosts(): string[];
  /** Hosts refused for naming a local or private address. */
  refused(): string[];
  /** `host:port` pairs refused for the port. */
  refusedPorts(): string[];
  /** Whether the session went over its byte cap. */
  limited(): boolean;
  close(): void;
}

type Session = {
  user: string;
  password: Buffer;
  options: EgressSessionOptions;
  received: number;
  sockets: Set<Duplex>;
  hosts: Set<string>;
  refused: Set<string>;
  ports: Set<string>;
  limited: boolean;
  closed: boolean;
};

const HOP_BY_HOP = new Set([
  "connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade",
]);

const CONNECT_TARGET = /^(\[[0-9a-fA-F:.%a-zA-Z]+\]|[^\s:[\]/]+):(\d{1,5})$/;

/** `host:port` of a CONNECT request; IPv6 brackets kept off the host. */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const match = CONNECT_TARGET.exec(target.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1]!.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, ""), port };
}

/** The user and password a `Proxy-Authorization: Basic …` header carries. */
export function parseBasicAuth(header: string | undefined): { user: string; password: string } | null {
  const match = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const named = new Set(String(headers.connection ?? "").toLowerCase().split(",").map((name) => name.trim()).filter(Boolean));
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}

const defaultDial: Dial = ({ address, family }, port) => netConnect({ host: address, port, family });

/** A refusal: why, for the session's record, and the status the client sees. */
class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class EgressProxy {
  private readonly resolve: Resolve;
  private readonly dial: Dial;
  private readonly log: (line: string) => void;
  private readonly connectTimeoutMs: number;
  private readonly sessions = new Map<string, Session>();
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private disposed = false;

  constructor(options: EgressProxyOptions = {}) {
    this.resolve = options.resolve ?? systemResolve;
    this.dial = options.dial ?? defaultDial;
    this.log = options.log ?? (() => {});
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  }

  /** The port it listens on, starting it the first time. */
  start(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error("The downloader's network gate has shut down."));
    this.listening ??= new Promise<number>((settle, reject) => {
      const server = createServer({ requestTimeout: 0, headersTimeout: 30_000 });
      server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => void this.tunnel(request, socket, head));
      server.on("request", (request: IncomingMessage, response: ServerResponse) => void this.forward(request, response));
      // No "upgrade" listener on purpose: Node then serves an Upgrade request
      // as a plain one, and the hop-by-hop headers are dropped on the way. So
      // curl's h2c upgrade (yt-dlp's impersonating client over plain http)
      // gets HTTP/1.1; WebSockets (wss) go through CONNECT anyway.
      server.on("clientError", (_error, socket: Duplex) => socket.destroy());
      server.once("error", (error) => {
        this.listening = null;
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("The downloader's network gate has no port."));
        settle(address.port);
      });
      this.server = server;
    });
    return this.listening;
  }

  /** A session with its own credentials, byte count and refusals. */
  async open(options: EgressSessionOptions = {}): Promise<EgressSession> {
    const port = await this.start();
    const user = `run-${randomBytes(9).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    const session: Session = {
      user, password: Buffer.from(password), options, received: 0, sockets: new Set(), hosts: new Set(), refused: new Set(), ports: new Set(), limited: false, closed: false,
    };
    this.sessions.set(user, session);
    return {
      url: `http://${user}:${password}@127.0.0.1:${port}`,
      bytes: () => session.received,
      hosts: () => [...session.hosts],
      refused: () => [...session.refused],
      refusedPorts: () => [...session.ports],
      limited: () => session.limited,
      close: () => this.closeSession(session),
    };
  }

  /** Stops listening and cuts every connection. */
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) this.closeSession(session);
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.user);
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
  }

  private authenticate(header: string | undefined): Session | null {
    const credentials = parseBasicAuth(header);
    if (!credentials) return null;
    const session = this.sessions.get(credentials.user);
    if (!session || session.closed) return null;
    const given = Buffer.from(credentials.password);
    return given.length === session.password.length && timingSafeEqual(given, session.password) ? session : null;
  }

  private track(session: Session, socket: Duplex, inbound: boolean): void {
    session.sockets.add(socket);
    socket.once("close", () => session.sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      session.options.onActivity?.();
      if (!inbound) return;
      session.received += chunk.length;
      const cap = session.options.maxBytes;
      if (cap !== undefined && session.received > cap && !session.limited) {
        session.limited = true;
        this.log(`egress: a run went over its ${cap}-byte cap`);
        for (const open of session.sockets) open.destroy();
        session.options.onLimit?.();
      }
    });
  }

  /** The checked addresses of `host:port`, or the reason it is refused. */
  private async check(session: Session, host: string, port: number): Promise<ResolvedAddress[]> {
    if (!EGRESS_PORTS.has(port)) {
      session.ports.add(`${host.includes(":") ? `[${host}]` : host}:${port}`);
      this.log(`egress: refused ${host}:${port} (port)`);
      throw new Refusal(403, `Port ${port} isn't allowed.`);
    }
    try {
      return await resolvePublic(host, this.resolve);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "invalid-input") {
        session.refused.add(host);
        this.log(`egress: refused ${host} (local or private address)`);
        throw new Refusal(403, "Local and private network addresses are refused.");
      }
      this.log(`egress: couldn't resolve ${host}`);
      throw new Refusal(502, `Couldn't resolve ${host}.`);
    }
  }

  /** Connects to the first address that answers, in the order the resolver gave them. */
  private async connect(addresses: ResolvedAddress[], port: number): Promise<Socket> {
    let last: unknown;
    for (const address of addresses) {
      try {
        return await new Promise<Socket>((settle, reject) => {
          const socket = this.dial(address, port);
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("connect timeout"));
          }, this.connectTimeoutMs);
          socket.once("connect", () => {
            clearTimeout(timer);
            socket.removeListener("error", reject);
            settle(socket);
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("connect failed");
  }

  private async tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    const reply = (status: number, text: string, extra = "") => {
      if (!client.destroyed) client.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const session = this.authenticate(request.headers["proxy-authorization"]);
    if (!session) return reply(407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="cutroom"\r\n');
    const target = parseConnectTarget(request.url ?? "");
    if (!target) return reply(400, "Bad Request");
    session.sockets.add(client);
    client.once("close", () => session.sockets.delete(client));
    let upstream: Socket;
    try {
      const addresses = await this.check(session, target.host, target.port);
      upstream = await this.connect(addresses, target.port);
    } catch (error) {
      if (error instanceof Refusal) return reply(error.status, error.status === 403 ? "Forbidden" : "Bad Gateway");
      this.log(`egress: couldn't connect to ${target.host}:${target.port}`);
      return reply(502, "Bad Gateway");
    }
    if (session.closed || client.destroyed) {
      upstream.destroy();
      client.destroy();
      return;
    }
    session.hosts.add(target.host);
    this.track(session, upstream, true);
    this.track(session, client, false);
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const fail = (status: number, extra: Record<string, string> = {}) => {
      if (!response.headersSent) response.writeHead(status, { ...extra, connection: "close", "content-length": "0" });
      response.end();
    };
    const session = this.authenticate(request.headers["proxy-authorization"]);
    if (!session) return fail(407, { "proxy-authenticate": 'Basic realm="cutroom"' });
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      return fail(400);
    }
    if (target.protocol !== "http:" || target.username || target.password) return fail(400);
    const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const port = target.port ? Number(target.port) : 80;
    let addresses: ResolvedAddress[];
    try {
      addresses = await this.check(session, host, port);
    } catch (error) {
      return fail(error instanceof Refusal ? error.status : 502);
    }
    let socket: Socket;
    try {
      socket = await this.connect(addresses, port);
    } catch {
      this.log(`egress: couldn't connect to ${host}:${port}`);
      return fail(502);
    }
    if (session.closed) {
      socket.destroy();
      return fail(502);
    }
    session.hosts.add(host);
    this.track(session, socket, true);
    // The client's socket belongs to the server's parser: closed with the
    // session, never read here.
    const client = request.socket;
    session.sockets.add(client);
    client.once("close", () => session.sockets.delete(client));
    const upstream = httpRequest({
      method: request.method,
      host: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      // Without an agent, the request goes over the connection made to the
      // checked address, and never resolves the name again.
      headers: { ...forwardHeaders(request.headers), connection: "close" },
      createConnection: () => socket,
    }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers));
      answer.pipe(response);
      answer.on("error", () => response.destroy());
    });
    upstream.on("error", () => {
      if (!response.headersSent) fail(502);
      else response.destroy();
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  }
}
