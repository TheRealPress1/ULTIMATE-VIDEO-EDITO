/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EgressProxy, parseBasicAuth, parseConnectTarget } from "./egress-proxy";

import type { Server as HttpServer } from "node:http";
import type { Server, Socket } from "node:net";
import type { Resolve } from "../web-media-url";

// No real network: names resolve from this table, and every "public"
// connection is dialed to a server on loopback instead.
const NAMES: Record<string, string[]> = {
  "media.example.com": ["93.184.216.34"],
  "lan.example.com": ["192.168.1.20"],
  "mixed.example.com": ["93.184.216.34", "127.0.0.1"],
  "metadata.example.com": ["169.254.169.254"],
};
const resolve: Resolve = async (host) => {
  const addresses = NAMES[host];
  if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address, family: 4 as const }));
};

let echo: Server;
let echoPort = 0;
let origin: HttpServer;
let originPort = 0;
let originBody = "hello from origin";
let lastOriginHeaders: Record<string, unknown> = {};
let proxy: EgressProxy;
let dialed: Array<{ address: string; port: number }>;

function listen(server: Server | HttpServer): Promise<number> {
  return new Promise((settle) => server.listen(0, "127.0.0.1", () => settle((server.address() as { port: number }).port)));
}

beforeEach(async () => {
  echo = createServer((socket) => socket.pipe(socket));
  echoPort = await listen(echo);
  originBody = "hello from origin";
  origin = createHttpServer((request, response) => {
    lastOriginHeaders = request.headers;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${originBody} ${request.url}`);
  });
  originPort = await listen(origin);
  dialed = [];
  proxy = new EgressProxy({
    resolve,
    dial: ({ address }, port) => {
      dialed.push({ address, port });
      return connect({ host: "127.0.0.1", port: port === 80 ? originPort : echoPort });
    },
  });
});

afterEach(async () => {
  proxy.dispose();
  await new Promise((settle) => echo.close(settle));
  origin.closeAllConnections();
  await new Promise((settle) => origin.close(settle));
});

function credentials(url: string): string {
  const parsed = new URL(url);
  return Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64");
}

/** Sends a CONNECT through the proxy; resolves with the status line and the open socket. */
function tunnel(url: string, target: string, auth: string | null = credentials(url)): Promise<{ status: number; socket: Socket }> {
  const port = Number(new URL(url).port);
  return new Promise((settle, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let head = "";
    socket.once("error", reject);
    socket.on("data", function onData(chunk: Buffer) {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeListener("data", onData);
      settle({ status: Number(head.split(" ")[1]), socket });
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${auth}\r\n` : ""}\r\n`);
  });
}

function exchange(socket: Socket, text: string): Promise<string> {
  return new Promise((settle) => {
    socket.once("data", (chunk: Buffer) => settle(chunk.toString("utf8")));
    socket.write(text);
  });
}

/** A plain-http request through the proxy, absolute-form. */
function proxiedGet(url: string, target: string, auth: string | null = credentials(url), extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((settle, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: Number(new URL(url).port),
      path: target,
      headers: { host: new URL(target).host, "x-kept": "yes", ...extra, ...(auth ? { "proxy-authorization": `Basic ${auth}` } : {}) },
      agent: false,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => settle({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("parsing", () => {
  it("reads CONNECT targets", () => {
    expect(parseConnectTarget("media.example.com:443")).toEqual({ host: "media.example.com", port: 443 });
    expect(parseConnectTarget("[2606:4700::1111]:443")).toEqual({ host: "2606:4700::1111", port: 443 });
    expect(parseConnectTarget("media.example.com")).toBeNull();
    expect(parseConnectTarget("a:99999")).toBeNull();
    expect(parseConnectTarget("a b:443")).toBeNull();
  });

  it("reads Basic credentials", () => {
    expect(parseBasicAuth(`Basic ${Buffer.from("run-1:pa:ss").toString("base64")}`)).toEqual({ user: "run-1", password: "pa:ss" });
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth(undefined)).toBeNull();
  });
});

describe("EgressProxy", () => {
  it("tunnels to a public host through the address it checked, counting bytes", async () => {
    const session = await proxy.open();
    expect(session.url).toMatch(/^http:\/\/run-[0-9a-f]+:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    const { status, socket } = await tunnel(session.url, "media.example.com:443");
    expect(status).toBe(200);
    expect(await exchange(socket, "ping")).toBe("ping");
    expect(dialed).toEqual([{ address: "93.184.216.34", port: 443 }]);
    expect(session.bytes()).toBe(4);
    expect(session.hosts()).toEqual(["media.example.com"]);
    socket.destroy();
    session.close();
  });

  it("asks for credentials, and forgets a closed session's", async () => {
    const session = await proxy.open();
    expect((await tunnel(session.url, "media.example.com:443", null)).status).toBe(407);
    expect((await tunnel(session.url, "media.example.com:443", Buffer.from("run-x:nope").toString("base64"))).status).toBe(407);
    const wrongPassword = Buffer.from(`${new URL(session.url).username}:${"0".repeat(36)}`).toString("base64");
    expect((await tunnel(session.url, "media.example.com:443", wrongPassword)).status).toBe(407);
    session.close();
    expect((await tunnel(session.url, "media.example.com:443")).status).toBe(407);
    expect(dialed).toEqual([]);
  });

  it("refuses private addresses, names that resolve to one, and local names", async () => {
    const session = await proxy.open();
    for (const target of ["10.0.0.1:443", "127.0.0.1:443", "[::1]:443", "169.254.169.254:80", "lan.example.com:443", "mixed.example.com:443", "metadata.example.com:443", "localhost:443", "printer.local:443", "intranet:443"]) {
      expect((await tunnel(session.url, target)).status, target).toBe(403);
    }
    expect(session.refused()).toEqual(expect.arrayContaining(["10.0.0.1", "lan.example.com", "mixed.example.com", "localhost"]));
    expect(dialed).toEqual([]);
  });

  it("refuses ports other than 80 and 443", async () => {
    const session = await proxy.open();
    expect((await tunnel(session.url, "media.example.com:8443")).status).toBe(403);
    expect((await tunnel(session.url, "media.example.com:22")).status).toBe(403);
    expect(session.refused()).toEqual([]);
    expect(session.refusedPorts()).toEqual(["media.example.com:8443", "media.example.com:22"]);
    expect(dialed).toEqual([]);
  });

  it("answers 502 for a name that doesn't resolve", async () => {
    const session = await proxy.open();
    expect((await tunnel(session.url, "nowhere.example.com:443")).status).toBe(502);
  });

  it("forwards plain http to the checked address without the proxy's headers", async () => {
    const session = await proxy.open();
    const answer = await proxiedGet(session.url, "http://media.example.com/clip.mp4?token=1");
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("hello from origin /clip.mp4?token=1");
    expect(dialed).toEqual([{ address: "93.184.216.34", port: 80 }]);
    expect(lastOriginHeaders.host).toBe("media.example.com");
    expect(lastOriginHeaders["x-kept"]).toBe("yes");
    expect(lastOriginHeaders["proxy-authorization"]).toBeUndefined();
    expect(session.bytes()).toBeGreaterThan(0);
    expect((await proxiedGet(session.url, "http://lan.example.com/")).status).toBe(403);
    expect((await proxiedGet(session.url, "http://media.example.com/", null)).status).toBe(407);
    expect((await proxiedGet(session.url, "http://media.example.com:8080/")).status).toBe(403);
  });

  it("serves an h2c upgrade request as plain HTTP/1.1", async () => {
    // What curl sends for plain http when yt-dlp impersonates a browser.
    const session = await proxy.open();
    const answer = await proxiedGet(session.url, "http://media.example.com/a.mp3", undefined, { connection: "Upgrade, HTTP2-Settings", upgrade: "h2c", "http2-settings": "AAMAAABkAAQAoAAAAAIAAAAA" });
    expect(answer).toEqual({ status: 200, body: "hello from origin /a.mp3" });
    expect(lastOriginHeaders.upgrade).toBeUndefined();
    expect(lastOriginHeaders["http2-settings"]).toBeUndefined();
  });

  it("cuts a session that goes over its byte cap", async () => {
    let limited = 0;
    let active = 0;
    const session = await proxy.open({ maxBytes: 1000, onLimit: () => limited++, onActivity: () => active++ });
    const { socket } = await tunnel(session.url, "media.example.com:443");
    const closed = new Promise((settle) => socket.once("close", settle));
    socket.write("x".repeat(5000));
    await closed;
    expect(limited).toBe(1);
    expect(session.limited()).toBe(true);
    expect(session.bytes()).toBeGreaterThan(1000);
    expect(active).toBeGreaterThan(0);
  });

  it("cuts a session's tunnels when it closes", async () => {
    const session = await proxy.open();
    const { socket } = await tunnel(session.url, "media.example.com:443");
    const closed = new Promise((settle) => socket.once("close", settle));
    session.close();
    await closed;
  });
});
