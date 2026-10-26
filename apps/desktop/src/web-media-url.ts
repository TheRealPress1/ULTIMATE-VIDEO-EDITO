/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which URLs the app fetches on an agent's behalf. An agent's links come from
// anywhere, including a page or a file it was told to read, so a download
// must never become a way into this machine or its network: the app's own
// MCP server listens on loopback, and a router or NAS answers on a private
// address. Only http(s) to public hosts, without credentials, every address a
// name resolves to public, checked again on every redirect.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DapiError } from "@diffusionstudio/dapi";

export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Every address a host name resolves to. */
export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

export const PRIVATE_ADDRESS = "Local and private network addresses can't be downloaded from. Use a public http or https link.";

/** Name suffixes that only mean something on this machine or its network. */
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "home.arpa"];

/** The system resolver, every address (IPv4 and IPv6) as the OS orders them. */
export const systemResolve: Resolve = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));

function parseV4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

/** Eight 16-bit groups; a dotted IPv4 tail and `::` expanded, a zone (`%en0`) dropped. */
function parseV6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const missing = 8 - head.length - (rest?.length ?? 0);
  if (rest === null ? missing !== 0 : missing < 1) return null;
  const groups = rest === null ? head : [...head, ...Array<string>(missing).fill("0"), ...rest];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

function isPublicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false; // this network, private, loopback, multicast and reserved
  if (a === 100 && b! >= 64 && b! <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  // 198.18.0.0/15 (benchmarking) is left reachable on purpose: proxy tools in
  // fake-IP mode (Surge, Clash, Stash) answer every name with one of these
  // and carry the connection out themselves, and no LAN or metadata service
  // lives there.
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

const embedded = (high: number, low: number): number[] => [high >> 8, high & 255, low >> 8, low & 255];

function isPublicV6(groups: number[]): boolean {
  const [first, second] = groups as [number, number];
  // Addresses that carry an IPv4 one are as public as it is: mapped
  // (::ffff:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return isPublicV4(embedded(groups[6]!, groups[7]!));
  if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return isPublicV4(embedded(groups[6]!, groups[7]!));
  if (first === 0x2002) return isPublicV4(embedded(second, groups[2]!));
  // Only global unicast is public. That leaves out the unspecified address,
  // loopback, IPv4-compatible, unique local, link-local, site-local and
  // multicast at once.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && (second === 0 || second === 0xdb8)) return false; // Teredo, documentation
  if (first === 0x2001 && ((second & 0xfff0) === 0x10 || (second & 0xfff0) === 0x20)) return false; // ORCHID
  if (first === 0x2001 && second === 2 && groups[2] === 0) return false; // benchmarking
  if (first === 0x3fff && second < 0x1000) return false; // documentation
  return true;
}

/** Whether an IP address is reachable on the public internet: not loopback, private, link-local, CGNAT, unspecified, multicast or reserved. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0]!);
  if (family === 4) return isPublicV4(parseV4(bare)!);
  if (family === 6) {
    const groups = parseV6(bare);
    return groups !== null && isPublicV6(groups);
  }
  return false;
}

/** A URL's host as the checks compare it: lowercase, without IPv6 brackets or a trailing dot. */
export function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** Whether a host name (not an address) can only name something on this machine or its network. */
function isLocalName(host: string): boolean {
  if (!host.includes(".")) return true; // an intranet name, resolved through the search domains
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * `value` as a URL the app may fetch: http(s), no user name or password, and
 * a public host. Throws the reason otherwise. Names are resolved separately
 * (`resolvePublic`), since that needs the network.
 */
export function checkWebUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DapiError("invalid-input", "That isn't a valid web address. Use a full http or https link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DapiError("invalid-input", "Only http and https links can be downloaded.");
  }
  if (url.username || url.password) {
    throw new DapiError("invalid-input", "Links with a user name or password can't be downloaded. Use a public link.");
  }
  const host = hostOf(url);
  if (!host) throw new DapiError("invalid-input", "That link has no host name.");
  if (isIP(host.split("%")[0]!) ? !isPublicAddress(host) : isLocalName(host)) {
    throw new DapiError("invalid-input", PRIVATE_ADDRESS);
  }
  // Fragments never go on the wire, and two spellings of one file should compare equal.
  url.hash = "";
  return url;
}

/**
 * The addresses `host` resolves to, when every one of them is public. All of
 * them, not just the first: a client may connect to any, and a name that
 * mixes a public address with a private one is how a page gets a browser
 * (or this app) to talk to the local network.
 */
export async function resolvePublic(host: string, resolve: Resolve): Promise<ResolvedAddress[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0]!);
  if (family) {
    if (!isPublicAddress(bare)) throw new DapiError("invalid-input", PRIVATE_ADDRESS);
    return [{ address: bare, family: family === 6 ? 6 : 4 }];
  }
  if (isLocalName(bare.toLowerCase().replace(/\.$/, ""))) throw new DapiError("invalid-input", PRIVATE_ADDRESS);
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(bare);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DapiError("not-found", `Couldn't find the server ${bare}${code ? ` (${code})` : ""}. Check the link.`, { cause: error });
  }
  if (!addresses.length) throw new DapiError("not-found", `Couldn't find the server ${bare}. Check the link.`);
  if (addresses.some(({ address }) => !isPublicAddress(address))) throw new DapiError("invalid-input", PRIVATE_ADDRESS);
  return addresses;
}
