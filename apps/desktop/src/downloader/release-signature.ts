/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The signature on a yt-dlp release's checksums. yt-dlp's release workflow
// signs SHA2-256SUMS with its release key and publishes the OpenPGP detached
// signature beside it as SHA2-256SUMS.sig. Cutroom trusts a release's
// checksums only once that signature checks out against the key below, kept
// in the app: someone who can upload files to a release (or edit one) can't
// sign them too. Someone who can run yt-dlp's release workflow could, which
// no check on this side can tell apart.
//
// Only what that workflow makes is read: one version 4 signature over the
// file's bytes, by an RSA key, hashed with SHA-256, SHA-384 or SHA-512.
// Anything else fails, so an unfamiliar signature stops an install instead
// of being let through.

import { constants, createHash, createPublicKey, verify } from "node:crypto";

import type { KeyObject } from "node:crypto";

/**
 * yt-dlp's release key, as published at
 * https://github.com/yt-dlp/yt-dlp/blob/master/public.key (unchanged since
 * signing began in March 2023). Replacing it means pasting the new block here
 * and its fingerprint below.
 */
export const YT_DLP_PUBLIC_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGP78C4BEAD0rF9zjGPAt0thlt5C1ebzccAVX7Nb1v+eqQjk+WEZdTETVCg3
WAM5ngArlHdm/fZqzUgO+pAYrB60GKeg7ffUDf+S0XFKEZdeRLYeAaqqKhSibVal
DjvOBOztu3W607HLETQAqA7wTPuIt2WqmpL60NIcyr27LxqmgdN3mNvZ2iLO+bP0
nKR/C+PgE9H4ytywDa12zMx6PmZCnVOOOu6XZEFmdUxxdQ9fFDqd9LcBKY2LDOcS
Yo1saY0YWiZWHtzVoZu1kOzjnS5Fjq/yBHJLImDH7pNxHm7s/PnaurpmQFtDFruk
t+2lhDnpKUmGr/I/3IHqH/X+9nPoS4uiqQ5HpblB8BK+4WfpaiEg75LnvuOPfZIP
KYyXa/0A7QojMwgOrD88ozT+VCkKkkJ+ijXZ7gHNjmcBaUdKK7fDIEOYI63Lyc6Q
WkGQTigFffSUXWHDCO9aXNhP3ejqFWgGMtCUsrbkcJkWuWY7q5ARy/05HbSM3K4D
U9eqtnxmiV1WQ8nXuI9JgJQRvh5PTkny5LtxqzcmqvWO9TjHBbrs14BPEO9fcXxK
L/CFBbzXDSvvAgArdqqlMoncQ/yicTlfL6qzJ8EKFiqW14QMTdAn6SuuZTodXCTi
InwoT7WjjuFPKKdvfH1GP4bnqdzTnzLxCSDIEtfyfPsIX+9GI7Jkk/zZjQARAQAB
tDdTaW1vbiBTYXdpY2tpICh5dC1kbHAgc2lnbmluZyBrZXkpIDxjb250YWN0QGdy
dWI0ay54eXo+iQJOBBMBCgA4FiEErAy75oSNaoc0ZK9OV89lkztadYEFAmP78C4C
GwMFCwkIBwIGFQoJCAsCBBYCAwECHgECF4AACgkQV89lkztadYEVqQ//cW7TxhXg
7Xbh2EZQzXml0egn6j8QaV9KzGragMiShrlvTO2zXfLXqyizrFP4AspgjSn/4NrI
8mluom+Yi+qr7DXT4BjQqIM9y3AjwZPdywe912Lxcw52NNoPZCm24I9T7ySc8lmR
FQvZC0w4H/VTNj/2lgJ1dwMflpwvNRiWa5YzcFGlCUeDIPskLx9++AJE+xwU3LYm
jQQsPBqpHHiTBEJzMLl+rfd9Fg4N+QNzpFkTDW3EPerLuvJniSBBwZthqxeAtw4M
UiAXh6JvCc2hJkKCoygRfM281MeolvmsGNyQm+axlB0vyldiPP6BnaRgZlx+l6MU
cPqgHblb7RW5j9lfr6OYL7SceBIHNv0CFrt1OnkGo/tVMwcs8LH3Ae4a7UJlIceL
V54aRxSsZU7w4iX+PB79BWkEsQzwKrUuJVOeL4UDwWajp75OFaUqbS/slDDVXvK5
OIeuth3mA/adjdvgjPxhRQjA3l69rRWIJDrqBSHldmRsnX6cvXTDy8wSXZgy51lP
m4IVLHnCy9m4SaGGoAsfTZS0cC9FgjUIyTyrq9M67wOMpUxnuB0aRZgJE1DsI23E
qdvcSNVlO+39xM/KPWUEh6b83wMn88QeW+DCVGWACQq5N3YdPnAJa50617fGbY6I
gXIoRHXkDqe23PZ/jURYCv0sjVtjPoVC+bg=
=bJkn
-----END PGP PUBLIC KEY BLOCK-----`;

/** The fingerprint of the key above: `gpg --show-keys public.key` prints it. */
export const YT_DLP_KEY_FINGERPRINT = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";

/** A key signatures are checked against. */
export type ReleaseKey = { fingerprint: string; key: KeyObject; bytes: number };

/** Why a signature wasn't accepted, in words that follow "the signature …". */
export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

const HASHES: Record<number, string> = { 8: "sha256", 9: "sha384", 10: "sha512" };
const RSA = new Set([1, 3]);
/** Subpackets whose meaning is known; any other one marked critical makes the signature unreadable, as OpenPGP asks. */
const UNDERSTOOD = new Set([2, 16, 33]);

/** Reads past the end of a packet as a malformed one rather than a RangeError. */
function need(bytes: Uint8Array, end: number): void {
  if (end > bytes.length) throw new SignatureError("is cut short");
}

/** One OpenPGP packet at `at`: its tag, its body and where the next one starts. */
function readPacket(bytes: Buffer, at: number): { tag: number; body: Buffer; end: number } {
  need(bytes, at + 2);
  const first = bytes[at]!;
  if (!(first & 0x80)) throw new SignatureError("isn't an OpenPGP packet");
  let tag: number, length: number, start: number;
  if (first & 0x40) {
    tag = first & 0x3f;
    const octet = bytes[at + 1]!;
    if (octet < 192) [length, start] = [octet, at + 2];
    else if (octet < 224) {
      need(bytes, at + 3);
      [length, start] = [((octet - 192) << 8) + bytes[at + 2]! + 192, at + 3];
    } else if (octet === 255) {
      need(bytes, at + 6);
      [length, start] = [bytes.readUInt32BE(at + 2), at + 6];
    } else throw new SignatureError("is split into parts, which Blackout doesn't read");
  } else {
    tag = (first >> 2) & 0x0f;
    const type = first & 0x03;
    if (type === 3) throw new SignatureError("has no length, which Blackout doesn't read");
    const size = 1 << type;
    need(bytes, at + 1 + size);
    length = size === 1 ? bytes[at + 1]! : size === 2 ? bytes.readUInt16BE(at + 1) : bytes.readUInt32BE(at + 1);
    start = at + 1 + size;
  }
  need(bytes, start + length);
  return { tag, body: bytes.subarray(start, start + length), end: start + length };
}

/** A multiprecision integer at `at`: its bytes, without the bit count before them. */
function readMpi(bytes: Buffer, at: number): { value: Buffer; end: number } {
  need(bytes, at + 2);
  const end = at + 2 + Math.ceil(bytes.readUInt16BE(at) / 8);
  need(bytes, end);
  return { value: bytes.subarray(at + 2, end), end };
}

/** The packets an ASCII-armored block holds. */
function dearmor(armored: string): Buffer {
  const lines = armored.trim().split(/\r?\n/);
  const blank = lines.findIndex((line) => !line.trim());
  const body = lines.slice(blank + 1).filter((line) => line && !line.startsWith("=") && !line.startsWith("-----"));
  return Buffer.from(body.join(""), "base64");
}

/** A public key's fingerprint and RSA key, from its first packet; the fingerprint must be `expected`. */
export function readPublicKey(armored: string, expected: string): ReleaseKey {
  const bytes = dearmor(armored);
  const packet = readPacket(bytes, 0);
  const body = packet.body;
  if (packet.tag !== 6 || body[0] !== 4 || !RSA.has(body[5] ?? -1)) throw new SignatureError("key isn't a version 4 RSA public key");
  const modulus = readMpi(body, 6);
  const exponent = readMpi(body, modulus.end);
  const header = Buffer.from([0x99, body.length >> 8, body.length & 0xff]);
  const fingerprint = createHash("sha1").update(header).update(body).digest("hex").toUpperCase();
  if (fingerprint !== expected.replace(/\s+/g, "").toUpperCase()) throw new SignatureError(`key's fingerprint is ${fingerprint}, not ${expected}`);
  const jwk = { kty: "RSA", n: modulus.value.toString("base64url"), e: exponent.value.toString("base64url") };
  return { fingerprint, key: createPublicKey({ key: jwk, format: "jwk" }), bytes: modulus.value.length };
}

let releaseKeys: readonly ReleaseKey[] | undefined;

/** The keys a yt-dlp release may be signed with. */
export function ytDlpReleaseKeys(): readonly ReleaseKey[] {
  releaseKeys ??= [readPublicKey(YT_DLP_PUBLIC_KEY, YT_DLP_KEY_FINGERPRINT)];
  return releaseKeys;
}

/** The subpackets of a signature's area, as type and body. */
function subpackets(area: Buffer): Array<{ type: number; critical: boolean; body: Buffer }> {
  const found: Array<{ type: number; critical: boolean; body: Buffer }> = [];
  for (let at = 0; at < area.length;) {
    const octet = area[at]!;
    let length: number, start: number;
    if (octet < 192) [length, start] = [octet, at + 1];
    else if (octet < 255) {
      need(area, at + 2);
      [length, start] = [((octet - 192) << 8) + area[at + 1]! + 192, at + 2];
    } else {
      need(area, at + 5);
      [length, start] = [area.readUInt32BE(at + 1), at + 5];
    }
    if (length < 1) throw new SignatureError("has an empty subpacket");
    need(area, start + length);
    found.push({ type: area[start]! & 0x7f, critical: !!(area[start]! & 0x80), body: area.subarray(start + 1, start + length) });
    at = start + length;
  }
  return found;
}

/**
 * Checks that `signature`, a binary OpenPGP detached signature, signs
 * `data` with one of `keys`. Throws a SignatureError saying why not.
 */
export function checkSignature(data: Uint8Array, signature: Uint8Array, keys: readonly ReleaseKey[]): void {
  const bytes = Buffer.from(signature.buffer, signature.byteOffset, signature.byteLength);
  const packet = readPacket(bytes, 0);
  if (packet.tag !== 2 || packet.end !== bytes.length) throw new SignatureError("isn't a single OpenPGP signature");
  const body = packet.body;
  need(body, 6);
  if (body[0] !== 4) throw new SignatureError(`is a version ${body[0]} signature, which Blackout doesn't read`);
  if (body[1] !== 0x00) throw new SignatureError("doesn't sign a file's bytes");
  if (!RSA.has(body[2]!)) throw new SignatureError("isn't an RSA signature");
  const hash = HASHES[body[3]!];
  if (!hash) throw new SignatureError("uses a hash Blackout doesn't accept");
  const hashedEnd = 6 + body.readUInt16BE(4);
  need(body, hashedEnd + 2);
  const unhashedEnd = hashedEnd + 2 + body.readUInt16BE(hashedEnd);
  need(body, unhashedEnd + 2);
  const hashed = subpackets(body.subarray(6, hashedEnd));
  const unhashed = subpackets(body.subarray(hashedEnd + 2, unhashedEnd));
  const quick = body.subarray(unhashedEnd, unhashedEnd + 2);
  const { value, end } = readMpi(body, unhashedEnd + 2);
  if (end !== body.length) throw new SignatureError("has bytes after its value");
  if (hashed.some((item) => item.critical && !UNDERSTOOD.has(item.type))) throw new SignatureError("carries a condition Blackout doesn't understand");

  // The signer: its fingerprint (subpacket 33) or key ID (16, the fingerprint's last 8 bytes), when it says.
  const issuers = [...hashed, ...unhashed].flatMap((item) =>
    item.type === 33 && item.body[0] === 4 ? [item.body.subarray(1).toString("hex").toUpperCase()]
    : item.type === 16 && item.body.length === 8 ? [item.body.toString("hex").toUpperCase()] : []);
  const candidates = issuers.length ? keys.filter((key) => issuers.some((issuer) => key.fingerprint.endsWith(issuer))) : keys;
  if (!candidates.length) throw new SignatureError(`is by a key Blackout doesn't know (${issuers[0]})`);

  // What was signed: the data, then the signature's own hashed part, then its length (RFC 4880, 5.2.4).
  const trailer = Buffer.from([0x04, 0xff, 0, 0, 0, 0]);
  trailer.writeUInt32BE(hashedEnd, 2);
  const signed = Buffer.concat([data, body.subarray(0, hashedEnd), trailer]);
  if (!createHash(hash).update(signed).digest().subarray(0, 2).equals(quick)) throw new SignatureError("doesn't match the file");
  for (const candidate of candidates) {
    if (value.length > candidate.bytes) continue;
    const padded = Buffer.concat([Buffer.alloc(candidate.bytes - value.length), value]);
    if (verify(hash, signed, { key: candidate.key, padding: constants.RSA_PKCS1_PADDING }, padded)) return;
  }
  throw new SignatureError("doesn't match the file");
}
