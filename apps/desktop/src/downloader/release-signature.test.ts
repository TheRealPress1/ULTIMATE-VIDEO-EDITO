/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { SignatureError, YT_DLP_KEY_FINGERPRINT, YT_DLP_PUBLIC_KEY, checkSignature, readPublicKey, ytDlpReleaseKeys } from "./release-signature";
import { RELEASE_SUMS, RELEASE_SUMS_SIG, testSigner } from "./release-signature-fixtures";

const sums = Buffer.from(RELEASE_SUMS);
const signer = testSigner();

/** Why `checkSignature` refused, or null when it accepted. */
function refusal(data: Uint8Array, signature: Uint8Array, keys = signer.keys): string | null {
  try {
    checkSignature(data, signature, keys);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(SignatureError);
    return (error as Error).message;
  }
}

describe("yt-dlp's release key", () => {
  it("is the key yt-dlp publishes, by its fingerprint", () => {
    const [key] = ytDlpReleaseKeys();
    expect(YT_DLP_KEY_FINGERPRINT).toBe("AC0CBBE6848D6A873464AF4E57CF65933B5A7581");
    expect(key).toMatchObject({ fingerprint: YT_DLP_KEY_FINGERPRINT, bytes: 512 });
    expect(key!.key.asymmetricKeyType).toBe("rsa");
    expect(ytDlpReleaseKeys()).toBe(ytDlpReleaseKeys());
  });

  it("is read only under its own fingerprint", () => {
    expect(readPublicKey(YT_DLP_PUBLIC_KEY, "ac0c bbe6 848d 6a87 3464  af4e 57cf 6593 3b5a 7581").fingerprint).toBe(YT_DLP_KEY_FINGERPRINT);
    expect(() => readPublicKey(YT_DLP_PUBLIC_KEY, "0".repeat(40))).toThrow(`key's fingerprint is ${YT_DLP_KEY_FINGERPRINT}, not ${"0".repeat(40)}`);
    expect(() => readPublicKey("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQ==\n-----END PGP PUBLIC KEY BLOCK-----", YT_DLP_KEY_FINGERPRINT)).toThrow(SignatureError);
  });

  it("accepts yt-dlp's own signature on a real release's checksums", () => {
    expect(refusal(sums, RELEASE_SUMS_SIG, ytDlpReleaseKeys())).toBeNull();
  });

  it("refuses those checksums once a byte changed", () => {
    const changed = Buffer.from(sums);
    changed[sums.indexOf("yt-dlp_macos.zip") - 3] ^= 1;
    expect(refusal(changed, RELEASE_SUMS_SIG, ytDlpReleaseKeys())).toBe("doesn't match the file");
    expect(refusal(Buffer.concat([sums, Buffer.from("0".repeat(64) + "  yt-dlp_macos.zip\n")]), RELEASE_SUMS_SIG, ytDlpReleaseKeys())).toBe("doesn't match the file");
  });

  it("refuses a signature whose value changed, even with its quick check intact", () => {
    const forged = Buffer.from(RELEASE_SUMS_SIG);
    forged[forged.length - 1] ^= 1;
    expect(refusal(sums, forged, ytDlpReleaseKeys())).toBe("doesn't match the file");
  });
});

describe("checkSignature", () => {
  const data = Buffer.from("20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1  yt-dlp_macos.zip\n");

  it("accepts what the release workflow signs, with SHA-256 or SHA-512", () => {
    expect(refusal(data, signer.sign(data))).toBeNull();
    expect(refusal(data, signer.sign(data, { hash: 10 }))).toBeNull();
  });

  it("refuses a signature by a key Cutroom doesn't know", () => {
    expect(refusal(data, signer.sign(data), ytDlpReleaseKeys())).toMatch(/^is by a key Cutroom doesn't know \([0-9A-F]{40}\)$/);
    // Naming yt-dlp's key as the signer doesn't make another key's signature its.
    expect(refusal(data, signer.sign(data, { issuer: YT_DLP_KEY_FINGERPRINT }), ytDlpReleaseKeys())).toBe("doesn't match the file");
    expect(refusal(data, testSigner().sign(data))).toMatch(/^is by a key Cutroom doesn't know/);
  });

  it("refuses kinds of signature the release workflow doesn't make", () => {
    expect(refusal(data, signer.sign(data, { version: 5 }))).toBe("is a version 5 signature, which Cutroom doesn't read");
    expect(refusal(data, signer.sign(data, { type: 1 }))).toBe("doesn't sign a file's bytes");
    expect(refusal(data, signer.sign(data, { hash: 2 }))).toBe("uses a hash Cutroom doesn't accept");
    expect(refusal(data, signer.sign(data, { extra: [{ type: 30, critical: true, body: Buffer.from([1]) }] }))).toBe("carries a condition Cutroom doesn't understand");
    // The same subpacket, not marked critical, is only ignored.
    expect(refusal(data, signer.sign(data, { extra: [{ type: 30, body: Buffer.from([1]) }] }))).toBeNull();
  });

  it("refuses anything that isn't one whole signature packet", () => {
    const good = signer.sign(data);
    expect(refusal(data, Buffer.alloc(0))).toBe("is cut short");
    expect(refusal(data, good.subarray(0, good.length - 10))).toBe("is cut short");
    expect(refusal(data, Buffer.concat([good, Buffer.from([0])]))).toBe("isn't a single OpenPGP signature");
    expect(refusal(data, Buffer.from("-----BEGIN PGP SIGNATURE-----\n"))).toBe("isn't an OpenPGP packet");
    // A public key packet where the signature should be.
    expect(refusal(data, Buffer.from([0x99, 0x00, 0x01, 0x04]))).toBe("isn't a single OpenPGP signature");
  });
});
