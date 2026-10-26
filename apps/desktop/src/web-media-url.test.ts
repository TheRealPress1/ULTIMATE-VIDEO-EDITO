/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";
import { checkWebUrl, isPublicAddress, PRIVATE_ADDRESS, resolvePublic } from "./web-media-url";

import type { ResolvedAddress } from "./web-media-url";

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.0.1",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1",
    "198.51.100.7", "203.0.113.9", "224.0.0.251", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  ])("refuses IPv4 %s", (address) => expect(isPublicAddress(address)).toBe(false));

  it.each([
    "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.5", "::ffff:192.168.0.1", "::ffff:169.254.169.254",
    "::127.0.0.1", "::ffff:0:127.0.0.1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:c0a8:101::1",
    "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%en0", "febf::1", "fec0::1", "ff02::1", "ff05::1:3", "100::1",
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "2001:10::1", "2001:20::1", "2001:2::1", "3fff::1",
    "[::1]", "not-an-ip", "1.2.3", "1.2.3.256", "::ffff:1.2.3.256", "1::2::3", "12345::",
  ])("refuses IPv6 and malformed %s", (address) => expect(isPublicAddress(address)).toBe(false));

  it.each([
    "1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "198.20.0.1", "223.255.255.255",
    // What fake-IP DNS proxies (Surge, Clash, Stash) answer every name with.
    "198.18.0.1", "198.18.4.27", "198.19.255.255", "::ffff:198.18.0.7",
    "2606:4700:4700::1111", "2a00:1450:4001:82a::200e", "2620:0:860:ed1a::1", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "[2606:4700::1]",
  ])("allows public %s", (address) => expect(isPublicAddress(address)).toBe(true));
});

describe("checkWebUrl", () => {
  it("normalizes a public http(s) URL and drops its fragment", () => {
    expect(checkWebUrl("https://Upload.Wikimedia.org/a b.jpg#frag").href).toBe("https://upload.wikimedia.org/a%20b.jpg");
    expect(checkWebUrl("http://example.com:8080/x").port).toBe("8080");
    expect(checkWebUrl("https://example.com./x").hostname).toBe("example.com.");
  });

  it.each([
    ["file:///etc/passwd", /http and https/], ["ftp://example.com/a.jpg", /http and https/], ["data:image/png;base64,AAAA", /http and https/],
    ["javascript:alert(1)", /http and https/], ["not a url", /valid web address/], ["https://user:pass@example.com/a.jpg", /user name or password/],
    ["https://token@example.com/a.jpg", /user name or password/],
  ])("refuses %s", (url, message) => expect(() => checkWebUrl(url)).toThrow(message));

  it.each([
    "http://localhost/a.jpg", "http://LOCALHOST:43127/mcp", "http://app.localhost/", "http://printer.local/scan.jpg", "http://db.internal/x",
    "http://nas.home.arpa/a.jpg", "http://intranet/a.jpg", "http://127.0.0.1:43127/mcp", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/",
    "http://0177.0.0.1/", "http://0/", "http://10.1.2.3/", "http://192.168.1.1/admin", "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]:43127/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[64:ff9b::a00:1]/",
    "http://localhost./a.jpg",
  ])("refuses the private host in %s", (url) => {
    expect(() => checkWebUrl(url)).toThrow(PRIVATE_ADDRESS);
  });

  it("accepts public IP literals", () => {
    expect(checkWebUrl("http://93.184.216.34/a.jpg").hostname).toBe("93.184.216.34");
    expect(checkWebUrl("http://[2606:4700::1111]/a.jpg").hostname).toBe("[2606:4700::1111]");
  });
});

describe("resolvePublic", () => {
  const resolver = (addresses: ResolvedAddress[]) => vi.fn(async () => addresses);

  it("answers every address when all are public", async () => {
    const resolve = resolver([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::248:1893", family: 6 }]);
    await expect(resolvePublic("example.com", resolve)).resolves.toHaveLength(2);
    expect(resolve).toHaveBeenCalledWith("example.com");
  });

  it("lets through the addresses a fake-IP proxy answers with", async () => {
    await expect(resolvePublic("upload.wikimedia.org", resolver([{ address: "198.18.0.42", family: 4 }]))).resolves.toEqual([{ address: "198.18.0.42", family: 4 }]);
    expect(checkWebUrl("http://198.18.0.42/a.jpg").hostname).toBe("198.18.0.42");
  });

  it("refuses a name when any address it resolves to is private", async () => {
    for (const address of ["127.0.0.1", "10.0.0.8", "::1", "::ffff:192.168.1.10", "fd00::5"]) {
      const family = address.includes(":") ? 6 : 4;
      await expect(resolvePublic("rebind.example", resolver([{ address: "93.184.216.34", family: 4 }, { address, family }]))).rejects.toThrow(PRIVATE_ADDRESS);
    }
  });

  it("checks IP literals without resolving them, and local names without asking DNS", async () => {
    const resolve = resolver([]);
    await expect(resolvePublic("8.8.8.8", resolve)).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
    await expect(resolvePublic("[::1]", resolve)).rejects.toThrow(PRIVATE_ADDRESS);
    await expect(resolvePublic("printer.local", resolve)).rejects.toThrow(PRIVATE_ADDRESS);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reports a name that does not resolve as not found", async () => {
    await expect(resolvePublic("nowhere.example", resolver([]))).rejects.toMatchObject({ code: "not-found" });
    const failing = vi.fn(async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); });
    await expect(resolvePublic("nowhere.example", failing)).rejects.toThrow(/Couldn't find the server nowhere\.example \(ENOTFOUND\)/);
  });
});
