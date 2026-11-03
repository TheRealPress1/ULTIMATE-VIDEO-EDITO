/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DapiError } from "@diffusionstudio/dapi";
import { EgressProxy } from "./egress-proxy";
import { classifyYtDlpError, configureYtDlp } from "./index";
import { YtDlpManager, installNextStep, parseState } from "./manager";
import { InstallError, isMachO, MACOS_ARTIFACTS } from "./yt-dlp-install";
import { testSigner } from "./release-signature-fixtures";

import type { Server } from "node:http";
import type { ManagerOptions } from "./manager";
import type { Artifact, Fetch } from "./yt-dlp-install";

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases";
const ASSETS = "https://release-assets.githubusercontent.com/github-production-release-asset";
const darwin = process.platform === "darwin";

let work: string;
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "uve-ytdlp-manager-")); });
afterAll(async () => { await rm(work, { recursive: true, force: true }); });

const managers: YtDlpManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });

let serial = 0;
async function fresh(name: string): Promise<string> {
  const dir = join(work, `${name}-${++serial}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A stand-in yt-dlp: names its release for `--version`, else prints its arguments one per line. */
function fakeYtDlp(version: string, body = ""): string {
  return [
    "#!/bin/sh",
    `for a in "$@"; do if [ "$a" = "--version" ]; then echo '${version}'; exit 0; fi; done`,
    body,
    `for a in "$@"; do printf '%s\\n' "$a"; done`,
    "",
  ].join("\n");
}

/** The onedir zip of a stand-in release, built the way the release workflow zips its folder. */
async function onedirZip(version: string, options: { extra?: (dir: string) => Promise<void>; body?: string } = {}): Promise<Buffer> {
  const source = await fresh("release");
  await writeFile(join(source, "yt-dlp_macos"), fakeYtDlp(version, options.body), { mode: 0o755 });
  await mkdir(join(source, "_internal"));
  await writeFile(join(source, "_internal", "base_library.zip"), "stand-in");
  await options.extra?.(source);
  const zip = join(await fresh("zip"), "yt-dlp_macos.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", source, zip]);
  return readFile(zip);
}

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The stand-in release key every stand-in release is signed with, unless it says otherwise. */
const signer = testSigner();

/** `sig` is what SHA2-256SUMS.sig serves (null for none); unless given, the served sums signed with the stand-in key. */
type Release = { zip?: Buffer; onefile?: Buffer; sums?: string; sig?: Buffer | null };

function sumsFor(release: Release): string {
  return [
    `${"0".repeat(64)}  yt-dlp.exe`,
    ...(release.zip ? [`${sha(release.zip)}  yt-dlp_macos.zip`] : []),
    ...(release.onefile ? [`${sha(release.onefile)}  yt-dlp_macos`] : []),
    `${"1".repeat(64)}  yt-dlp_linux`,
  ].join("\n") + "\n";
}

/** GitHub as the installer sees it: /latest redirects to the tag, downloads redirect to the asset host. */
function github(releases: Map<string, Release>, latest: { tag: string }, options: { assetHost?: string; offline?: () => boolean } = {}) {
  const hits: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hits.push(url.replace(/\?.*$/, ""));
    if (init?.redirect !== "manual") throw new Error("The installer must not let fetch follow redirects.");
    if (options.offline?.()) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    if (url === `${RELEASES}/latest`) return new Response(null, { status: 302, headers: { location: `${RELEASES}/tag/${latest.tag}` } });
    const download = /^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\/([^/]+)\/(.+)$/.exec(url);
    if (download) {
      const host = options.assetHost ?? ASSETS;
      return new Response(null, { status: 302, headers: { location: `${host}/${download[1]}/${download[2]}?sp=r&sig=SECRET` } });
    }
    const asset = /^https:\/\/release-assets\.githubusercontent\.com\/github-production-release-asset\/([^/]+)\/([^?]+)/.exec(url);
    const release = asset ? releases.get(asset[1]!) : undefined;
    const sums = release ? (release.sums ?? sumsFor(release)) : undefined;
    const body = asset?.[2] === "SHA2-256SUMS" ? sums
      : asset?.[2] === "SHA2-256SUMS.sig" ? (release?.sig === undefined ? (sums === undefined ? undefined : signer.sign(Buffer.from(sums))) : release.sig ?? undefined)
      : asset?.[2] === "yt-dlp_macos.zip" ? release?.zip
      : asset?.[2] === "yt-dlp_macos" ? release?.onefile : undefined;
    if (body === undefined) return new Response("Not Found", { status: 404 });
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-length": String(bytes.length) } });
  }) as typeof globalThis.fetch;
  const asFetch: Fetch = (url, init) => fetch(url, init);
  return { fetch: asFetch, raw: fetch, hits, count: (suffix: string) => hits.filter((url) => url.endsWith(suffix)).length };
}

/** Stand-in releases are shell scripts; the real check wants Mach-O. */
const acceptScripts = (header: Buffer) => isMachO(header) || header.subarray(0, 2).toString() === "#!";

async function manager(root: string, fetch: Fetch, extra: Partial<ManagerOptions> = {}): Promise<YtDlpManager> {
  const instance = new YtDlpManager({
    root,
    fetch,
    ffmpegDir: join(root, "no-ffmpeg"),
    appExecPath: process.execPath,
    version: "0.217.0",
    isExecutable: acceptScripts,
    releaseKeys: signer.keys,
    log: () => {},
    ...extra,
  });
  managers.push(instance);
  return instance;
}

async function releaseDirs(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => /^\d{4}\./.test(name)).sort();
}

describe.skipIf(!darwin)("installing", () => {
  it("installs the latest release on first use, verified and smoke-tested", async () => {
    const root = await fresh("root");
    const zip = await onedirZip("2026.10.26");
    const hub = github(new Map([["2026.10.26", { zip }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    expect(ytdlp.status().state).toBe("missing");

    const installed = await ytdlp.ensure();
    expect(installed).toEqual({ path: join(root, "2026.10.26", "yt-dlp_macos"), version: "2026.10.26" });
    expect(ytdlp.status()).toMatchObject({ state: "ready", version: "2026.10.26", path: installed.path });
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.current).toMatchObject({ tag: "2026.10.26", dir: "2026.10.26", kind: "onedir", sha256: sha(zip), okRuns: 0 });
    expect(state.jsRuntime.status.kind).toBe("node");
    expect(await readFile(join(root, "node-shim"), "utf8")).toContain("ELECTRON_RUN_AS_NODE=1 exec");
    expect(await releaseDirs(root)).toEqual(["2026.10.26"]);
    expect(await readdir(join(root, "downloads"))).toEqual([]);
    expect(ytdlp.details()).toMatchObject({ supported: true, latest: "2026.10.26", jsRuntime: { kind: "node" } });
    expect(ytdlp.details().message).toContain("yt-dlp 2026.10.26 is installed");

    // Installed: no more requests.
    const before = hub.hits.length;
    await ytdlp.ensure();
    expect(hub.hits.length).toBe(before);
    // A new launch reads the state back.
    expect((await manager(root, hub.fetch)).status()).toMatchObject({ state: "ready", version: "2026.10.26" });
  });

  it("shares one install between concurrent callers", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    const results = await Promise.all([ytdlp.ensure(), ytdlp.ensure(), ytdlp.ensure()]);
    expect(new Set(results.map((result) => result.path)).size).toBe(1);
    expect(hub.count("/yt-dlp_macos.zip")).toBe(2); // the download URL and the asset it redirects to, once each
  });

  it("refuses an archive that doesn't match its checksum", async () => {
    const root = await fresh("root");
    const zip = await onedirZip("2026.10.26");
    const hub = github(new Map([["2026.10.26", { zip, sums: `${sha("something else")}  yt-dlp_macos.zip\n` }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    const failure = await ytdlp.ensure().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DapiError);
    expect((failure as DapiError).code).toBe("unsupported");
    expect((failure as DapiError).message).toMatch(/couldn't install its downloader \(yt-dlp\) from GitHub: yt-dlp_macos\.zip doesn't match the checksum/);
    // The network did its job; checking it wouldn't help.
    expect((failure as DapiError).message).toMatch(/checksum its release publishes\. Try again later;/);
    expect((failure as DapiError).message).not.toContain("Check the network");
    expect(ytdlp.status()).toMatchObject({ state: "failed", error: expect.stringContaining("checksum") });
    expect(await releaseDirs(root)).toEqual([]);
    expect(await readdir(join(root, "downloads"))).toEqual([]);
    expect(hub.count("/yt-dlp_macos")).toBe(0); // a mismatch is not a reason to try the other build
  });

  it("refuses checksums that aren't signed with the release key, before downloading anything", async () => {
    const zip = await onedirZip("2026.10.26");
    const sums = sumsFor({ zip });
    for (const [release, why] of [
      [{ zip, sig: testSigner().sign(Buffer.from(sums)) }, /its signature is by a key Cutroom doesn't know/],
      [{ zip, sums: sums.replace(sha(zip), sha("something else")), sig: signer.sign(Buffer.from(sums)) }, /its signature doesn't match the file/],
      [{ zip, sig: Buffer.from("not a signature") }, /its signature isn't an OpenPGP packet/],
      [{ zip, sig: null }, /the release has no SHA2-256SUMS\.sig/],
    ] as const) {
      const root = await fresh("root");
      const hub = github(new Map([["2026.10.26", release]]), { tag: "2026.10.26" });
      const ytdlp = await manager(root, hub.fetch);
      const failure = await ytdlp.ensure().then(() => new Error("the install succeeded"), (error: unknown) => error as DapiError);
      expect(failure).toBeInstanceOf(DapiError);
      expect(failure.message).toMatch(why);
      expect(failure.message).toMatch(/Cutroom installs only yt-dlp releases signed with yt-dlp's release key/);
      expect(failure.message).not.toContain("Check the network");
      expect(ytdlp.status()).toMatchObject({ state: "failed" });
      expect(hub.count("/yt-dlp_macos.zip") + hub.count("/yt-dlp_macos")).toBe(0);
      expect(await releaseDirs(root)).toEqual([]);
    }
  });

  it("refuses a release whose sums don't list the build", async () => {
    const root = await fresh("root");
    const zip = await onedirZip("2026.10.26");
    const hub = github(new Map([["2026.10.26", { zip, sums: `${sha(zip)}  yt-dlp_linux.zip\n${sha(zip)}  yt-dlp_macos.zip\n${sha("other")}  yt-dlp_macos.zip\n` }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    await expect(ytdlp.ensure()).rejects.toThrow(/has no single entry for yt-dlp_macos/);
    expect(hub.count("/yt-dlp_macos.zip")).toBe(0);
  });

  it("follows redirects only through GitHub's hosts", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" }, { assetHost: "https://downloads.example.com/assets" });
    const ytdlp = await manager(root, hub.fetch);
    await expect(ytdlp.ensure()).rejects.toThrow(/redirected the download to downloads\.example\.com/);
    expect(hub.hits.some((url) => url.startsWith("https://downloads.example.com"))).toBe(false);
  });

  it("refuses an archive larger than expected", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const small: Artifact[] = [{ ...MACOS_ARTIFACTS[0]!, maxBytes: 64 }];
    const ytdlp = await manager(root, hub.fetch, { artifacts: small });
    await expect(ytdlp.ensure()).rejects.toThrow(/larger than/);
    expect(await readdir(join(root, "downloads"))).toEqual([]);
  });

  it("refuses a link that leaves the release folder", async () => {
    const root = await fresh("root");
    const zip = await onedirZip("2026.10.26", { extra: (dir) => symlink("../../../outside", join(dir, "_internal", "escape")) });
    const hub = github(new Map([["2026.10.26", { zip }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch, { artifacts: [MACOS_ARTIFACTS[0]!] });
    await expect(ytdlp.ensure()).rejects.toThrow(/link that leaves its folder/);
    expect(await releaseDirs(root)).toEqual([]);
  });

  it("refuses an executable that isn't Mach-O", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch, { isExecutable: isMachO, artifacts: [MACOS_ARTIFACTS[0]!] });
    await expect(ytdlp.ensure()).rejects.toThrow(/isn't a macOS executable/);
  });

  it("falls back to the single-file build when the folder build won't run", async () => {
    const root = await fresh("root");
    const zip = await onedirZip("2026.10.25"); // reports the wrong release
    const onefile = Buffer.from(fakeYtDlp("2026.10.26"));
    const hub = github(new Map([["2026.10.26", { zip, onefile }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    const installed = await ytdlp.ensure();
    expect(installed.path).toBe(join(root, "2026.10.26-onefile", "yt-dlp_macos"));
    expect(ytdlp.snapshot().current).toMatchObject({ kind: "onefile", dir: "2026.10.26-onefile" });
    expect((await lstat(installed.path)).mode & 0o111).toBeTruthy();
  });

  it("works offline once installed", async () => {
    const root = await fresh("root");
    let offline = false;
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" }, { offline: () => offline });
    await (await manager(root, hub.fetch)).ensure();
    offline = true;
    const relaunched = await manager(root, hub.fetch);
    await expect(relaunched.ensure()).resolves.toMatchObject({ version: "2026.10.26" });
    expect((await relaunched.run(["--simulate", "https://www.youtube.com/watch?v=XajaJYraODs"], {})).code).toBe(0);
    // A check while offline fails without touching the install.
    await expect(relaunched.checkNow()).rejects.toThrow(/GitHub couldn't be reached \(ENOTFOUND\)/);
    expect(relaunched.status()).toMatchObject({ state: "ready", version: "2026.10.26", error: expect.stringContaining("ENOTFOUND") });
  });

  it("fails a first use while offline with the install error", async () => {
    const hub = github(new Map(), { tag: "2026.10.26" }, { offline: () => true });
    const ytdlp = await manager(await fresh("root"), hub.fetch);
    await expect(ytdlp.run(["x"], {})).rejects.toThrow(/couldn't install its downloader.*Check the network, then try again\./);
    expect(ytdlp.status().state).toBe("failed");
  });

  it("installs again when the release folder disappeared", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    await ytdlp.ensure();
    await rm(join(root, "2026.10.26"), { recursive: true });
    await expect(ytdlp.ensure()).resolves.toMatchObject({ version: "2026.10.26" });
    expect(existsSync(join(root, "2026.10.26", "yt-dlp_macos"))).toBe(true);
  });

  it("reinstalls the same release in place", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    await ytdlp.ensure();
    await writeFile(join(root, "2026.10.26", "_internal", "base_library.zip"), "damaged");
    await expect(ytdlp.reinstall()).resolves.toEqual({ version: "2026.10.26", changed: true });
    expect(await readFile(join(root, "2026.10.26", "_internal", "base_library.zip"), "utf8")).toBe("stand-in");
    expect(await releaseDirs(root)).toEqual(["2026.10.26"]);
    expect(ytdlp.snapshot().previous).toBeUndefined();
  });
});

describe.skipIf(!darwin)("updating", () => {
  it("keeps the current release when the new one fails its smoke test", async () => {
    const root = await fresh("root");
    const latest = { tag: "2026.10.26" };
    const releases = new Map<string, Release>([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]);
    const hub = github(releases, latest);
    const ytdlp = await manager(root, hub.fetch);
    await ytdlp.ensure();
    latest.tag = "2026.11.02";
    releases.set("2026.11.02", { zip: await onedirZip("not-it"), onefile: Buffer.from(fakeYtDlp("not-it")) });
    const failure = await ytdlp.checkNow().then(() => new Error("the check succeeded"), (error: unknown) => error as Error);
    expect(failure.message).toMatch(/yt-dlp 2026\.11\.02 didn't run on this Mac \(it reported not-it\)\. Reinstall it from Settings > Downloads;.*Privacy & Security/);
    expect(failure.message).not.toContain("Check the network");
    expect(ytdlp.status()).toMatchObject({ state: "ready", version: "2026.10.26" });
    expect(await releaseDirs(root)).toEqual(["2026.10.26"]);
    expect((await ytdlp.run(["ok"], {})).code).toBe(0);
  });

  it("keeps the current release when the new one isn't signed with the release key", async () => {
    const root = await fresh("root");
    const latest = { tag: "2026.10.26" };
    const releases = new Map<string, Release>([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]);
    const hub = github(releases, latest);
    const ytdlp = await manager(root, hub.fetch);
    await ytdlp.ensure();
    latest.tag = "2026.11.02";
    const zip = await onedirZip("2026.11.02");
    releases.set("2026.11.02", { zip, sig: testSigner().sign(Buffer.from(sumsFor({ zip }))) });
    await expect(ytdlp.checkNow()).rejects.toThrow(/the release's SHA2-256SUMS isn't signed with yt-dlp's release key \(its signature is by a key Cutroom doesn't know/);
    expect(ytdlp.status()).toMatchObject({ state: "ready", version: "2026.10.26", error: expect.stringContaining("isn't signed") });
    expect(await releaseDirs(root)).toEqual(["2026.10.26"]);
    expect(hub.count("/2026.11.02/yt-dlp_macos.zip")).toBe(0);
    expect((await ytdlp.run(["ok"], {})).code).toBe(0);
  });

  it("asks GitHub at most every 30 minutes after an outdated failure, and keeps the previous release until the new one has run", async () => {
    const root = await fresh("root");
    let clock = new Date("2026-11-03T10:00:00Z");
    const latest = { tag: "2026.10.26" };
    const releases = new Map<string, Release>([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]);
    const hub = github(releases, latest);
    const ytdlp = await manager(root, hub.fetch, { now: () => clock });
    await ytdlp.ensure();
    expect((await ytdlp.run(["first"], {})).code).toBe(0);

    // Just checked at install: no request.
    const checks = () => hub.count("/releases/latest");
    expect(checks()).toBe(1);
    expect(await ytdlp.update()).toEqual({ version: "2026.10.26", changed: false });
    expect(checks()).toBe(1);

    clock = new Date(clock.getTime() + 31 * 60_000);
    expect(await ytdlp.update()).toEqual({ version: "2026.10.26", changed: false });
    expect(checks()).toBe(2);
    // The forced check throttles the next one.
    clock = new Date(clock.getTime() + 10 * 60_000);
    latest.tag = "2026.11.02";
    releases.set("2026.11.02", { zip: await onedirZip("2026.11.02") });
    expect(await ytdlp.update()).toEqual({ version: "2026.10.26", changed: false });
    expect(checks()).toBe(2);

    clock = new Date(clock.getTime() + 31 * 60_000);
    expect(await ytdlp.update()).toEqual({ version: "2026.11.02", changed: true });
    expect(ytdlp.status().version).toBe("2026.11.02");
    expect(ytdlp.snapshot().previous?.tag).toBe("2026.10.26");
    expect(await releaseDirs(root)).toEqual(["2026.10.26", "2026.11.02"]);

    expect((await ytdlp.run(["first on the new release"], {})).code).toBe(0);
    await new Promise((settle) => setTimeout(settle, 100));
    expect(await releaseDirs(root)).toEqual(["2026.11.02"]);
    expect(ytdlp.snapshot().previous).toBeUndefined();
  });

  it("removes a replaced release only once its last run ends", async () => {
    const root = await fresh("root");
    const latest = { tag: "2026.10.26" };
    const hold = 'for a in "$@"; do if [ "$a" = hold ]; then sleep 1; fi; done';
    const releases = new Map<string, Release>([["2026.10.26", { zip: await onedirZip("2026.10.26", { body: hold }) }]]);
    const ytdlp = await manager(root, github(releases, latest).fetch);
    await ytdlp.ensure();
    expect((await ytdlp.run(["first"], {})).code).toBe(0);
    const long = ytdlp.run(["hold"], {});
    await new Promise((settle) => setTimeout(settle, 200));
    latest.tag = "2026.11.02";
    releases.set("2026.11.02", { zip: await onedirZip("2026.11.02") });
    expect(await ytdlp.checkNow()).toEqual({ version: "2026.11.02", changed: true });
    expect((await ytdlp.run(["on the new release"], {})).code).toBe(0);
    await new Promise((settle) => setTimeout(settle, 100));
    expect(await releaseDirs(root)).toEqual(["2026.10.26", "2026.11.02"]); // still running
    expect((await long).code).toBe(0);
    await new Promise((settle) => setTimeout(settle, 100));
    expect(await releaseDirs(root)).toEqual(["2026.11.02"]);
    expect(ytdlp.snapshot().previous).toBeUndefined();
  });

  it("checks in the background at most daily, and only for recent users", async () => {
    const root = await fresh("root");
    let clock = new Date("2026-11-03T10:00:00Z");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch, { now: () => clock });
    expect(ytdlp.dueForCheck()).toBe(false); // nothing installed: first use installs
    await ytdlp.ensure();
    expect(ytdlp.dueForCheck()).toBe(false); // never used
    await ytdlp.run(["x"], {});
    expect(ytdlp.dueForCheck()).toBe(false); // checked at install
    clock = new Date(clock.getTime() + 23 * 3_600_000);
    expect(ytdlp.dueForCheck()).toBe(false);
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    expect(ytdlp.dueForCheck()).toBe(true);
    clock = new Date(clock.getTime() + 31 * 24 * 3_600_000);
    expect(ytdlp.dueForCheck()).toBe(false); // not used for a month
  });
});

describe.skipIf(!darwin)("running", () => {
  it("starts every run with the safe base arguments", async () => {
    const root = await fresh("root");
    const ffmpegDir = await fresh("audio-tools");
    await writeFile(join(ffmpegDir, "ffmpeg"), "", { mode: 0o755 });
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch, { ffmpegDir });
    const result = await ytdlp.run(["-J", "ytsearch1:blinding lights instrumental"], {});
    const args = result.stdout.trim().split("\n");
    expect(args.slice(0, 2)).toEqual(["--ignore-config", "--no-plugin-dirs"]);
    expect(args.slice(-2)).toEqual(["-J", "ytsearch1:blinding lights instrumental"]);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--proxy")).toMatch(/^http:\/\/run-[0-9a-f]+:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    expect(value("--cache-dir")).toBe(join(root, "cache"));
    expect(value("--ffmpeg-location")).toBe(ffmpegDir);
    expect(value("--downloader")).toBe("native");
    expect(args).toEqual(expect.arrayContaining(["--no-cookies", "--no-cookies-from-browser", "--no-js-runtimes"]));
    expect(args.indexOf("--no-js-runtimes")).toBeLessThan(args.indexOf("--js-runtimes"));
    expect(value("--js-runtimes")).toBe(`node:${join(root, "node-shim")}`);
    expect(args).not.toContain("--no-warnings");
    expect(ytdlp.snapshot().lastUsedAt).toBeTruthy();
  });

  it("goes out only through the egress gate", async () => {
    // The stand-in fetches through the proxy it was given, like yt-dlp does.
    const body = [
      'proxy=""; next=0',
      'for a in "$@"; do if [ "$next" = 1 ]; then proxy="$a"; next=0; fi; if [ "$a" = "--proxy" ]; then next=1; fi; done',
      'target=""; for a in "$@"; do target="$a"; done',
      'if ! /usr/bin/curl -sf --max-time 5 --proxy "$proxy" "$target"; then echo "ERROR: [generic] Unable to download webpage: Tunnel connection failed: 403 Forbidden" >&2; exit 1; fi',
      "exit 0",
    ].join("\n");
    const origin: Server = createHttpServer((_request, response) => response.end("public media"));
    await new Promise<void>((settle) => origin.listen(0, "127.0.0.1", settle));
    const port = (origin.address() as { port: number }).port;
    const egress = new EgressProxy({
      resolve: async (host) => host === "media.example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.1.2.3", family: 4 }],
      dial: () => connect({ host: "127.0.0.1", port }),
    });
    try {
      const root = await fresh("root");
      const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26", { body }) }]]), { tag: "2026.10.26" });
      const ytdlp = await manager(root, hub.fetch, { egress });
      const ok = await ytdlp.run(["http://media.example.com/clip"], {});
      expect(ok).toMatchObject({ code: 0, stdout: "public media" });
      const refused = await ytdlp.run(["http://router.example.com/admin"], {});
      expect(refused.code).toBe(1);
      expect(classifyYtDlpError(refused.stderr, refused.code, refused.signal)).toMatchObject({ category: "unavailable", reason: "private-address" });
    } finally {
      egress.dispose();
      origin.closeAllConnections();
      await new Promise((settle) => origin.close(settle));
    }
  });

  it("sweeps what a killed single-file build left in tmp", async () => {
    const root = await fresh("root");
    // Like PyInstaller's single file: unpacks into $TMPDIR/_MEI…, and only removes it when it ends on its own.
    const body = 'dir="${TMPDIR%/}/_MEI$$"; mkdir -p "$dir"; for a in "$@"; do if [ "$a" = hold ]; then echo started; sleep 30; fi; done; rm -rf "$dir"';
    const hub = github(new Map([["2026.10.26", { onefile: Buffer.from(fakeYtDlp("2026.10.26", body)) }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch, { artifacts: [MACOS_ARTIFACTS[1]!] });
    await ytdlp.ensure();
    expect(ytdlp.snapshot().current?.kind).toBe("onefile");
    const tmp = join(root, "tmp");
    await writeFile(join(tmp, "keep.txt"), "not the build's");
    const controller = new AbortController();
    let unpacked: string[] = [];
    const result = await ytdlp.run(["hold"], {
      signal: controller.signal,
      onStdoutLine: () => {
        unpacked = readdirSync(tmp).filter((name) => name.startsWith("_MEI"));
        controller.abort();
      },
    });
    expect(classifyYtDlpError(result.stderr, result.code, result.signal).category).toBe("canceled");
    expect(unpacked).toHaveLength(1);
    await new Promise((settle) => setTimeout(settle, 100));
    expect(readdirSync(tmp).sort()).toEqual(["keep.txt"]);
    // A run that ends on its own cleans up after itself, and the sweep leaves the rest.
    expect((await ytdlp.run(["ok"], {})).code).toBe(0);
    await new Promise((settle) => setTimeout(settle, 100));
    expect(readdirSync(tmp)).toEqual(["keep.txt"]);
  });

  it("leaves tmp alone while a run is going, and sweeps it at the next launch", async () => {
    const root = await fresh("root");
    const body = 'for a in "$@"; do if [ "$a" = hold ]; then mkdir -p "${TMPDIR%/}/_MEIlive"; sleep 1; fi; done';
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26", { body }) }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    await ytdlp.ensure();
    await new Promise((settle) => setTimeout(settle, 50));
    const tmp = join(root, "tmp");
    await mkdir(join(tmp, "_MEIold", "lib"), { recursive: true });
    await writeFile(join(tmp, "keep.txt"), "not the build's");
    const running = ytdlp.run(["hold"], {});
    await new Promise((settle) => setTimeout(settle, 300));
    ytdlp.startBackgroundChecks();
    await new Promise((settle) => setTimeout(settle, 100));
    expect(readdirSync(tmp).sort()).toEqual(["_MEIlive", "_MEIold", "keep.txt"]);
    expect((await running).code).toBe(0);
    ytdlp.dispose();
    const relaunched = await manager(root, hub.fetch);
    relaunched.startBackgroundChecks();
    await new Promise((settle) => setTimeout(settle, 100));
    expect(readdirSync(tmp)).toEqual(["keep.txt"]);
  });

  it("can be canceled while it runs", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26", { body: "echo started; sleep 30" }) }]]), { tag: "2026.10.26" });
    const ytdlp = await manager(root, hub.fetch);
    await ytdlp.ensure();
    const controller = new AbortController();
    const result = await ytdlp.run(["x"], { signal: controller.signal, onStdoutLine: () => controller.abort() });
    expect(classifyYtDlpError(result.stderr, result.code, result.signal).category).toBe("canceled");
  });
});

describe("contract", () => {
  it("is unsupported off macOS", async () => {
    const ytdlp = await manager(await fresh("root"), github(new Map(), { tag: "2026.10.26" }).fetch, { platform: "linux" });
    expect(ytdlp.status()).toMatchObject({ state: "failed", error: expect.stringContaining("macOS") });
    expect(ytdlp.details().supported).toBe(false);
    await expect(ytdlp.ensure()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("suggests a next step that fits why the install failed", () => {
    expect(installNextStep(new InstallError("network", "GitHub couldn't be reached (ENOTFOUND)"))).toBe("Check the network, then try again.");
    expect(installNextStep(new InstallError("disk", "the disk is full"))).toBe("Free some disk space, then try again.");
    expect(installNextStep(Object.assign(new Error("ENOSPC: no space left on device, mkdir"), { code: "ENOSPC" }))).toBe("Free some disk space, then try again.");
    expect(installNextStep(new InstallError("checksum", "x"))).toMatch(/^Try again later;/);
    expect(installNextStep(new InstallError("signature", "x"))).toMatch(/signed with yt-dlp's release key.*next release.*needs an update\.$/);
    expect(installNextStep(new InstallError("smoke", "x"))).toMatch(/Settings > Downloads.*Privacy & Security/);
    expect(installNextStep(new InstallError("invalid", "x"))).toMatch(/next release.*Settings > Downloads/);
    expect(installNextStep(new Error("EACCES: permission denied"))).toBe("Try again, or reinstall it from Settings > Downloads.");
    for (const reason of ["disk", "checksum", "signature", "smoke", "invalid"] as const) expect(installNextStep(new InstallError(reason, "x"))).not.toMatch(/network/i);
  });

  it("reads a damaged state file as nothing installed", () => {
    expect(parseState("{nope")).toEqual({ version: 1 });
    expect(parseState(JSON.stringify({ version: 1, current: { tag: "2026.10.26", dir: "../../etc", executable: "yt-dlp_macos" } })).current).toBeUndefined();
    expect(parseState(JSON.stringify({ version: 1, current: { tag: "2026.10.26", dir: "2026.10.26", executable: "yt-dlp_macos", okRuns: 2 } })).current?.okRuns).toBe(2);
  });

  it.skipIf(!darwin)("configures one instance with a standard fetch", async () => {
    const root = await fresh("root");
    const hub = github(new Map([["2026.10.26", { zip: await onedirZip("2026.10.26") }]]), { tag: "2026.10.26" });
    const ytdlp = configureYtDlp({ root, fetch: hub.raw, ffmpegDir: join(root, "none"), appExecPath: process.execPath, version: "0.217.0", releaseKeys: signer.keys });
    try {
      // The real executable check refuses the stand-in script, which proves the fetch path ran to the end.
      await expect(ytdlp.ensure()).rejects.toThrow(/isn't a macOS executable/);
    } finally {
      ytdlp.dispose();
    }
  });

  // Opt-in (CUTROOM_NETWORK_TESTS=1): the real latest release from GitHub, installed and run.
  it.skipIf(!darwin || !process.env.CUTROOM_NETWORK_TESTS)("installs the real release", async () => {
    const root = await fresh("live");
    const ytdlp = configureYtDlp({ root, ffmpegDir: join(root, "none"), appExecPath: process.execPath, version: "0.217.0" });
    try {
      const installed = await ytdlp.ensure();
      expect(installed.version).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
      const result = await ytdlp.run(["--version"], {});
      expect(result.stdout.trim()).toBe(installed.version);
      expect(ytdlp.details().jsRuntime?.kind).toBe("node");
    } finally {
      ytdlp.dispose();
    }
  }, 300_000);
});
