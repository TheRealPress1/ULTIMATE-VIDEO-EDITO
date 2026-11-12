/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Getting yt-dlp onto this Mac, one release at a time. The official macOS
// build comes from yt-dlp's GitHub releases, checked against the
// SHA2-256SUMS file of the same release before anything is unpacked, and
// run once (`--version` must name the release) before it is used. That file
// counts only with yt-dlp's signature on it (see ./release-signature): GitHub
// alone doesn't vouch for a release.
//
// The artifact is `yt-dlp_macos.zip`, the universal PyInstaller "onedir"
// build: an executable beside an `_internal/` folder, ad-hoc signed by
// PyInstaller. The single-file `yt-dlp_macos` unpacks itself into a temp
// folder on every launch (seconds per call), so it is only the fallback for
// a release whose zip won't run. Nothing is ever changed inside an unpacked
// release: one changed byte voids its signature, and macOS kills the process.
//
// Every request goes to GitHub only: redirects are followed by hand, each hop
// checked against the hosts GitHub serves releases from.

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SignatureError, checkSignature, ytDlpReleaseKeys } from "./release-signature";

import type { Exec } from "./js-runtime";
import type { ReleaseKey } from "./release-signature";

export const RELEASES_URL = "https://github.com/yt-dlp/yt-dlp/releases";

/** The hosts a release download may be redirected through. */
export const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

/** A stable release tag: `2026.10.26`, or `2026.10.26.1` for a same-day fix. */
export const TAG_PATTERN = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;

export const SUMS_NAME = "SHA2-256SUMS";
export const SIGNATURE_NAME = "SHA2-256SUMS.sig";
const SUMS_MAX = 64 * 1024;
const SIGNATURE_MAX = 16 * 1024;
const MAX_REDIRECTS = 5;
const MB = 1024 * 1024;

export type ArtifactKind = "onedir" | "onefile";

/** A release file Cutroom can run, in the order they are tried. */
export type Artifact = { name: string; kind: ArtifactKind; executable: string; maxBytes: number };

export const MACOS_ARTIFACTS: readonly Artifact[] = [
  { name: "yt-dlp_macos.zip", kind: "onedir", executable: "yt-dlp_macos", maxBytes: 200 * MB },
  { name: "yt-dlp_macos", kind: "onefile", executable: "yt-dlp_macos", maxBytes: 120 * MB },
];

/** What the installer fetches with. Redirects are never followed by it. */
export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "manual" }) => Promise<Response>;

export type InstallFailure = "network" | "checksum" | "signature" | "invalid" | "smoke" | "disk";

/** Why an install step failed, in words that finish "couldn't install its downloader: …". */
export class InstallError extends Error {
  readonly reason: InstallFailure;
  constructor(reason: InstallFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InstallError";
    this.reason = reason;
  }
}

/** `a` vs `b` as release tags: negative when `a` is older. */
export function compareTags(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function checkHost(url: URL): void {
  if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== "443")) {
    throw new InstallError("network", `GitHub redirected the download to ${url.hostname || "an unknown host"}, which Blackout doesn't download from`);
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function networkFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return signal.reason instanceof Error ? signal.reason : new InstallError("network", "the download was stopped");
  if (error instanceof InstallError) return error;
  const code = (error as NodeJS.ErrnoException)?.code ?? (error as { cause?: NodeJS.ErrnoException })?.cause?.code;
  return new InstallError("network", `GitHub couldn't be reached${code ? ` (${code})` : ""}`, { cause: error });
}

/** GETs `url`, following up to five redirects, every hop on a GitHub host. */
export async function fetchFollowing(fetch: Fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    checkHost(target);
    let response: Response;
    try {
      response = await fetch(target.href, { signal, headers, redirect: "manual" });
    } catch (error) {
      throw networkFailure(error, signal);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await discard(response);
      if (hop >= MAX_REDIRECTS) throw new InstallError("network", "GitHub redirected the download too many times");
      target = new URL(location, target);
      continue;
    }
    return response;
  }
}

/** The newest stable release's tag, read from where /releases/latest redirects (no API, no token, no rate limit). */
export async function latestTag(fetch: Fetch, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${RELEASES_URL}/latest`, { signal, headers, redirect: "manual" });
  } catch (error) {
    throw networkFailure(error, signal);
  }
  await discard(response);
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new InstallError("network", `GitHub answered ${response.status} when asked for the latest yt-dlp release`);
  }
  const path = new URL(location, RELEASES_URL).pathname;
  const tag = /\/releases\/tag\/([^/]+)\/?$/.exec(path)?.[1];
  if (!tag || !TAG_PATTERN.test(decodeURIComponent(tag))) throw new InstallError("invalid", "GitHub named a latest release Blackout doesn't recognize");
  return decodeURIComponent(tag);
}

/**
 * The checksums a SUMS file lists, by file name. A name listed twice with
 * different sums is left out, so it reads as missing rather than trusted.
 */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    const [, sum, name] = match as unknown as [string, string, string];
    const known = sums.get(name);
    if (known && known !== sum.toLowerCase()) conflicted.add(name);
    sums.set(name, sum.toLowerCase());
  }
  for (const name of conflicted) sums.delete(name);
  return sums;
}

/** A response body, refused past `max` bytes; `name` is the file's, for the refusal. */
export async function readCapped(response: Response, max: number, name = SUMS_NAME): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await discard(response);
    throw new InstallError("invalid", `the release's ${name} is unexpectedly large`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > max) throw new InstallError("invalid", `the release's ${name} is unexpectedly large`);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

/** A small file of the release, whole. */
async function fetchReleaseFile(fetch: Fetch, tag: string, name: string, max: number, headers: Record<string, string>, signal: AbortSignal): Promise<Buffer> {
  const response = await fetchFollowing(fetch, `${RELEASES_URL}/download/${tag}/${name}`, headers, signal);
  if (!response.ok) {
    await discard(response);
    if (name === SIGNATURE_NAME && response.status === 404) {
      throw new InstallError("signature", `the release has no ${SIGNATURE_NAME}, the signature its ${SUMS_NAME} is checked with`);
    }
    throw new InstallError("network", `GitHub answered ${response.status} for the release's ${name}`);
  }
  try {
    return await readCapped(response, max, name);
  } catch (error) {
    throw networkFailure(error, signal);
  }
}

/** The release's checksums, once their signature checks out against yt-dlp's release key (or `keys`). */
export async function fetchSums(
  fetch: Fetch, tag: string, headers: Record<string, string>, signal: AbortSignal, keys: readonly ReleaseKey[] = ytDlpReleaseKeys(),
): Promise<Map<string, string>> {
  const sums = await fetchReleaseFile(fetch, tag, SUMS_NAME, SUMS_MAX, headers, signal);
  const signature = await fetchReleaseFile(fetch, tag, SIGNATURE_NAME, SIGNATURE_MAX, headers, signal);
  try {
    checkSignature(sums, signature, keys);
  } catch (error) {
    if (!(error instanceof SignatureError)) throw error;
    throw new InstallError("signature", `the release's ${SUMS_NAME} isn't signed with yt-dlp's release key (its signature ${error.message})`, { cause: error });
  }
  return parseSums(sums.toString("utf8"));
}

/** Streams a body into `path` (created, never replaced), hashing it as it goes. */
export async function saveBody(response: Response, path: string, maxBytes: number, signal: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw new InstallError("invalid", `the download is larger than the ${Math.round(maxBytes / MB)} MB Blackout expects`);
  }
  if (!response.body) throw new InstallError("network", "GitHub sent an empty download");
  const hash = createHash("sha256");
  let bytes = 0;
  const file = await open(path, "wx");
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > maxBytes) throw new InstallError("invalid", `the download is larger than the ${Math.round(maxBytes / MB)} MB Blackout expects`);
      hash.update(chunk);
      await file.write(chunk);
    }
    await file.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new InstallError("disk", "the disk is full", { cause: error });
    throw networkFailure(error, signal);
  } finally {
    await file.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

const MACH_O = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

/** Whether a file's first bytes are a Mach-O executable's (thin or universal). */
export function isMachO(header: Buffer): boolean {
  return header.length >= 4 && MACH_O.has(header.readUInt32BE(0));
}

/** Unpacks a zip with ditto, which keeps modes and symlinks and leaves quarantine off. */
export async function unpackZip(zip: string, destination: string, exec: Exec): Promise<void> {
  const result = await exec("/usr/bin/ditto", ["-x", "-k", "--noqtn", zip, destination], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 180_000 });
  if (result.code !== 0) {
    const why = result.error?.message ?? result.stderr.trim().split("\n").at(-1) ?? `exit ${result.code}`;
    throw new InstallError(/No space left/i.test(why) ? "disk" : "invalid", `the release archive couldn't be unpacked (${why.slice(0, 160)})`);
  }
}

const within = (base: string, path: string) => path === base || path.startsWith(`${base}${sep}`);

/**
 * Checks an unpacked release: the executable is a regular file of the right
 * format, every link is relative and stays inside, and nothing but files,
 * folders and links is there.
 */
export async function checkTree(dir: string, executable: string, isExecutable: (header: Buffer) => boolean = isMachO): Promise<void> {
  const root = resolve(dir);
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !within(root, resolve(dirname(path), target))) {
          throw new InstallError("invalid", `the release archive has a link that leaves its folder (${relative(root, path)})`);
        }
      } else if (entry.isDirectory()) await walk(path);
      else if (!entry.isFile()) throw new InstallError("invalid", `the release archive has an unexpected entry (${relative(root, path)})`);
    }
  };
  await walk(root);
  const exe = join(root, executable);
  const info = await lstat(exe).catch(() => null);
  if (!info?.isFile()) throw new InstallError("invalid", `the release archive has no ${executable}`);
  const handle = await open(exe, "r");
  const header = Buffer.alloc(4);
  try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
  if (!isExecutable(header)) throw new InstallError("invalid", `${executable} in the release isn't a macOS executable`);
}

/** Runs `--version`: a release that can't name itself isn't used. */
export async function smokeTest(exe: string, tag: string, exec: Exec, env: NodeJS.ProcessEnv, timeoutMs = 90_000): Promise<void> {
  const result = await exec(exe, ["--ignore-config", "--version"], { env, timeoutMs });
  const printed = result.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (result.code === 0 && printed === tag) return;
  const why = result.error ? (result.error as NodeJS.ErrnoException).code ?? result.error.message
    : result.code === null ? "it was stopped" : printed ? `it reported ${printed.slice(0, 40)}` : (result.stderr.trim().split("\n").at(-1) ?? "").slice(0, 160) || `exit ${result.code}`;
  throw new InstallError("smoke", `yt-dlp ${tag} didn't run on this Mac (${why})`);
}

/** A fresh suffix for working names beside a release folder. */
export const suffix = () => randomBytes(6).toString("hex");

/** Puts `partial` at `target` in one rename, moving whatever was there aside first and removing it after. */
export async function swapInto(partial: string, target: string): Promise<void> {
  const aside = `${target}.trash-${suffix()}`;
  const moved = await rename(target, aside).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  try {
    await rename(partial, target);
  } catch (error) {
    if (moved) await rename(aside, target).catch(() => {});
    throw error;
  }
  if (moved) await rm(aside, { recursive: true, force: true }).catch(() => {});
}

/** Makes the executable executable (the zip keeps modes; the single file arrives without them). */
export async function markExecutable(path: string): Promise<void> {
  await chmod(path, 0o755);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
