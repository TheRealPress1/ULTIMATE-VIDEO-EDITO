/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// For the tests: a real release's checksums with yt-dlp's own signature on
// them, and a stand-in key that signs the way yt-dlp's release workflow does
// (gpg --detach-sign: one version 4 RSA signature over the file's bytes).

import { constants, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import type { ReleaseKey } from "./release-signature";

/** yt-dlp 2026.10.26's SHA2-256SUMS, byte for byte. */
export const RELEASE_SUMS = `e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3  yt-dlp
f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d  yt-dlp.exe
21f942d258d25cc4e60b4982a25c423460f0bebb835f38e6dfd1fcb140087f95  yt-dlp.tar.gz
0066dbac3c124028e2dcae2a197fccee33cd91f456313d24f7af89fd54590e98  yt-dlp_arm64.exe
767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795  yt-dlp_linux
f34053415136e55073dd64ba5326d161ecc23ce0e98c081d8752867b37809450  yt-dlp_linux.zip
e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483  yt-dlp_linux_aarch64
74708e707e8fa8177c8347e58152337edf320149cd7b225defd453f7cde47822  yt-dlp_linux_aarch64.zip
ec828c26c6da7898b279da2cad3dca434ebec7f8f18ae7b6420027f3aa037bf2  yt-dlp_linux_armv7l.zip
0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa  yt-dlp_macos
20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1  yt-dlp_macos.zip
e97a4dd919221d233e7720e18fa3f66db60fbd1d8c0846bf6deb8e88e04475a8  yt-dlp_musllinux
c3a67f7c14d4cbf876e7801039237fc16b929a629c72f9c785ec3fdc8aa40748  yt-dlp_musllinux.zip
ea97b8564667f3cabc334c3216526de39bc684e99815ecf07b6642f4cba8af4d  yt-dlp_musllinux_aarch64
1648beeb7b0c78b471654262697066c016783d33813659367a5c274828ba3240  yt-dlp_musllinux_aarch64.zip
fd51b212cf8380c7a52ee08c0d6be7f3c59b2f2c832eaf7b45acfae6eab57419  yt-dlp_win.zip
5eaa4c61f3c09189f3a551bf1855c13aad61fb865cc33f06012a6c2dbe287a45  yt-dlp_win_arm64.zip
e2898afd51c029d23c58de60cd8446b110dd3aa121b3e4149bafcee3356c59c0  yt-dlp_win_x86.zip
c0407c66361f50a99e10949ae882ea2ad7de9086b75d226d8fd88da4f74828fa  yt-dlp_x86.exe
`;

/** Its SHA2-256SUMS.sig, as published with the release. */
export const RELEASE_SUMS_SIG = Buffer.from(
  "iQIzBAABCgAdFiEErAy75oSNaoc0ZK9OV89lkztadYEFAmrf0ykACgkQV89lkztadYFrgRAAi88f07ETAUGIzH/ifgZLMdYcQavM" +
  "pBw5GsbCi4Os7K2+MJNZgJ1SpTYa/qQZ0GPS+RCsebOPcbByTAt9OSjnN7ZzJVPbl8B/FioDRWBond7Z3JvZojU28Xv6dd0YGv7s" +
  "w0pNit1Rro+9qtxQ1ibiNlqZHyj8BHyANOvSNNRLJuVmDkXWirmQwAjHnTmnK3Qcg2dOmuQr5DX/XbeNqzxxcqphUO7upijylfOt" +
  "VQyKoY91ze41k0XE4H1e+jdn8OuZEZhw2h/UEk9EX5ENn6jAqOPN3c0t33vUgZqYUliDnYogSC2ITb8tbsxdMRnQG5HouYLHVK56" +
  "aPClkx5sm/891XpwYw2xF8RIqqDEt9yf+V0xbd2rJBOvjQmPMJ6iLUbaBI440VRaJDd5ZEkMAGd+O8xxMQ+xf/SvPpFM8ytAgxk+" +
  "B76xTYv/2Z9FiMC08Au0iXkEaJ72ws/i0Ly55BvZ8bbON3yMrk64WG3JHoQo0xF+1K1YuWjpXxkesseLlj6fPcNlcAKjK2mzKV5E" +
  "Qe+ZPdCzWy4+BM3tQybyrUkHYQkJnCUad1a2/ufpnZFy1sFm/SM+o71Sf3qLYFz/BP6RVSnChN5DvuxN+hPZfL4dqubxUIXZAAYx" +
  "t1dss2NhqBc7BdhbetJwmt/foI8NLAiKYp6D5Rhv1zhdajQta+BlF78=",
  "base64",
);

export type SignOptions = {
  /** The signature's version (4 is the only one read). */
  version?: number;
  /** Its type: 0 signs a file's bytes, 1 its text. */
  type?: number;
  /** OpenPGP's number for the hash: 8 is SHA-256, 10 SHA-512, 2 SHA-1. */
  hash?: number;
  /** The fingerprint it names as its signer, the key's own unless given. */
  issuer?: string;
  /** More subpackets for the hashed area, each as its type and body. */
  extra?: Array<{ type: number; critical?: boolean; body: Buffer }>;
};

const HASH_NAMES: Record<number, string> = { 2: "sha1", 8: "sha256", 9: "sha384", 10: "sha512" };

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);

function subpacket(type: number, body: Buffer, critical = false): Buffer {
  return Buffer.concat([Buffer.from([body.length + 1, type | (critical ? 0x80 : 0)]), body]);
}

/** A stand-in release key: the key to check with, and what signs with it. */
export function testSigner(): { keys: readonly ReleaseKey[]; sign: (data: Uint8Array, options?: SignOptions) => Buffer } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fingerprint = randomBytes(20).toString("hex").toUpperCase();
  const keys = [{ fingerprint, key: pair.publicKey, bytes: 256 }];
  return {
    keys,
    sign(data, options = {}) {
      const hashId = options.hash ?? 8;
      const hash = HASH_NAMES[hashId]!;
      const issuer = Buffer.from(options.issuer ?? fingerprint, "hex");
      const created = Buffer.alloc(4);
      created.writeUInt32BE(1_793_000_000);
      const hashedArea = Buffer.concat([
        subpacket(33, Buffer.concat([Buffer.from([4]), issuer])),
        subpacket(2, created),
        ...(options.extra ?? []).map((item) => subpacket(item.type, item.body, item.critical)),
      ]);
      const head = Buffer.concat([Buffer.from([options.version ?? 4, options.type ?? 0, 1, hashId]), u16(hashedArea.length), hashedArea]);
      const trailer = Buffer.from([0x04, 0xff, 0, 0, 0, 0]);
      trailer.writeUInt32BE(head.length, 2);
      const signed = Buffer.concat([data, head, trailer]);
      let value = sign(hash, signed, { key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING });
      while (value.length > 1 && value[0] === 0) value = value.subarray(1);
      const bits = (value.length - 1) * 8 + value[0]!.toString(2).length;
      const unhashed = subpacket(16, issuer.subarray(-8));
      const quick = createHash(hash).update(signed).digest().subarray(0, 2);
      const body = Buffer.concat([head, u16(unhashed.length), unhashed, quick, u16(bits), value]);
      // An old-format packet with a two-byte length, as gpg writes it.
      return Buffer.concat([Buffer.from([0x89]), u16(body.length), body]);
    },
  };
}
