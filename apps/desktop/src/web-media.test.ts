/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import { NO_PAGE_MEDIA, RESULT_MOVED, WebMediaService, environmentProxy, pinnedFetch, retryAfter, scutilProxy, slugFor } from "./web-media";
import { openverseUrl, wikimediaUrl } from "./web-media-providers";
import { PRIVATE_ADDRESS } from "./web-media-url";
import { OPENVERSE_IMAGES, WIKIMEDIA_IMAGES } from "./web-media-fixtures";

import type { AddressInfo } from "node:net";
import type { ToolInput } from "@diffusionstudio/dapi";
import type { WebFetch, WebMediaOptions } from "./web-media";
import type { ResolvedAddress } from "./web-media-url";
import type { WebMediaLedger } from "./web-media-types";

const root = mkdtempSync(join(tmpdir(), "web-media-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PUBLIC: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];
const jpeg = (size = 600, seed = 1) => {
  const out = new Uint8Array(size).map((_, i) => (i * 31 + seed * 7) & 255);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  return out;
};
const png = (size = 300) => {
  const out = new Uint8Array(size).fill(9);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return out;
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const file = (bytes: Uint8Array, type = "image/jpeg", headers: Record<string, string> = {}) => () =>
  new Response(bytes, { headers: { "content-type": type, "content-length": String(bytes.byteLength), ...headers } });
const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const json = (value: unknown) => () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

type Route = (init: { signal: AbortSignal; headers: Record<string, string> }) => Response | Promise<Response>;

let routes: Record<string, Route>;
let hosts: Record<string, ResolvedAddress[]>;
let fetch: ReturnType<typeof vi.fn<WebFetch>>;
let resolve: ReturnType<typeof vi.fn<(host: string) => Promise<ResolvedAddress[]>>>;
let noteContent: ReturnType<typeof vi.fn<(path: string, text: string | null) => void>>;
let project: string;

beforeEach(() => {
  routes = {};
  hosts = {};
  fetch = vi.fn<WebFetch>(async (url, init) => {
    const route = routes[url];
    return route ? route(init) : new Response("missing", { status: 404 });
  });
  resolve = vi.fn(async (host: string) => hosts[host] ?? PUBLIC);
  noteContent = vi.fn();
  project = mkdtempSync(join(root, "project-"));
});
afterEach(() => vi.useRealTimers());

// No proxy unless a test sets one: the machine running the tests may have one.
const service = (options: WebMediaOptions = {}) =>
  new WebMediaService({ version: "1.2.3", fetch, resolve, noteContent, now: () => new Date("2026-10-26T12:00:00Z"), proxy: () => undefined, ...options });
const searchArgs = (input: Partial<ToolInput<"web_media_search">> = {}) => toolByName("web_media_search").input.parse({ query: "apollo launch", ...input });
const signal = () => new AbortController().signal;
let sequence = 0;
const download = (media: WebMediaService, url: string, extra: { name?: string; prefer?: "image" | "video"; signal?: AbortSignal } = {}) =>
  media.download({ id: `job-${++sequence}`, dir: project, url, prefer: extra.prefer ?? "image", ...(extra.name ? { name: extra.name } : {}) }, extra.signal ?? signal());
const webFiles = () => (existsSync(join(project, "assets", "web")) ? readdirSync(join(project, "assets", "web")).sort() : []);
const partial = () => webFiles().some((name) => name.startsWith(".dstmp-"));
/** A file that sends its first bytes and then waits: for the caller's abort, or for `finish`. */
const slowFile = (control: { finish?: () => void } = {}): Route => ({ signal }) => new Response(new ReadableStream({
  start(stream) {
    stream.enqueue(jpeg(5000));
    control.finish = () => { stream.enqueue(jpeg(100, 2)); stream.close(); };
    signal.addEventListener("abort", () => stream.error(signal.reason));
  },
}));
/** What a promise rejected with. */
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a failure"); }, (error: Error & { code?: string }) => error);
const ledger = (): WebMediaLedger => JSON.parse(readFileSync(join(project, ".cutroom", "web-media.json"), "utf8"));
const credits = () => readFileSync(join(project, "CREDITS.md"), "utf8");

/** Routes for one search over both providers, with Openverse's and Commons' thumbnails. */
function searchRoutes(args = searchArgs()) {
  routes[openverseUrl(args)!] = json(OPENVERSE_IMAGES);
  routes[wikimediaUrl(args)] = json(WIKIMEDIA_IMAGES);
}

describe("web media search", () => {
  it("asks both providers as Cutroom, interleaves their results and inlines the leading thumbnails", async () => {
    const args = searchArgs({ preview: 2, limit: 5 });
    searchRoutes(args);
    routes["https://api.openverse.org/v1/images/f9384235-b72e-4f1e-9b05-e1b116262a29/thumb/"] = file(jpeg(500));
    routes["https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Kennedy_Space_Center_panorama.tif/lossy-page1-500px-Kennedy_Space_Center_panorama.tif.jpg"] = file(png(), "image/png");

    const result = await service().search(args, signal());
    expect(result.warnings).toEqual([]);
    expect(result.results.map((item) => [item.index, item.provider])).toEqual([
      [1, "openverse"], [2, "wikimedia"], [3, "openverse"], [4, "wikimedia"], [5, "openverse"],
    ]);
    expect(result.previews.map(({ index, mimeType, bytes }) => [index, mimeType, bytes.byteLength])).toEqual([[1, "image/jpeg", 500], [2, "image/png", 300]]);
    for (const call of fetch.mock.calls) {
      expect(call[1].headers["user-agent"]).toBe("Cutroom/1.2.3 (desktop video editor; https://github.com/diffusionstudio/editor)");
    }
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(result.results[2]!.thumbnailUrl);
    expect(toolByName("web_media_search").result!.safeParse(result).success).toBe(true);
  });

  it("leaves out previews that are not small web images, without warnings", async () => {
    const args = searchArgs({ preview: 4, sources: ["openverse"] });
    routes[openverseUrl(args)!] = json(OPENVERSE_IMAGES);
    const thumbs = parseThumbs();
    routes[thumbs[0]!] = file(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]), "image/jpeg"); // TIFF bytes
    routes[thumbs[1]!] = file(jpeg(2 * 1024 * 1024)); // over 1 MiB, declared
    routes[thumbs[2]!] = () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 300; i++) controller.enqueue(jpeg(4096)); controller.close(); } })); // over 1 MiB, undeclared
    routes[thumbs[3]!] = redirect("http://169.254.169.254/latest/meta-data/");
    const result = await service().search(args, signal());
    expect(result.previews).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain("http://169.254.169.254/latest/meta-data/");
  });

  function parseThumbs(): string[] {
    return OPENVERSE_IMAGES.results.filter((row) => row.url && row.license !== "by-nd" && row.license !== "all-rights-reserved").map((row) => row.thumbnail);
  }

  it("reports a failing provider as a warning, and fails only when every provider does", async () => {
    const args = searchArgs({ preview: 0 });
    routes[openverseUrl(args)!] = () => new Response(JSON.stringify({ detail: "Request was throttled." }), { status: 429 });
    routes[wikimediaUrl(args)] = json(WIKIMEDIA_IMAGES);
    const partial = await service().search(args, signal());
    expect(partial.results.every((item) => item.provider === "wikimedia")).toBe(true);
    expect(partial.warnings).toEqual(["Openverse: api.openverse.org is rate limiting requests (429). Wait a minute or pick another result."]);

    routes[wikimediaUrl(args)] = () => new Response("<html>oops</html>", { status: 503 });
    await expect(service().search(args, signal())).rejects.toThrow(/^Web media search failed\. Openverse: .*429.* Wikimedia Commons: commons\.wikimedia\.org answered 503/);
  });

  it("gives up on a provider that does not answer in time", async () => {
    const args = searchArgs({ preview: 0 });
    routes[openverseUrl(args)!] = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    routes[wikimediaUrl(args)] = json(WIKIMEDIA_IMAGES);
    const result = await service({ timeouts: { provider: 20 } }).search(args, signal());
    expect(result.warnings).toEqual([expect.stringMatching(/^Openverse: didn't answer within/)]);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("rests a provider that timed out for a few minutes when another can answer, but still tries it when asked alone", async () => {
    const args = searchArgs({ preview: 0 });
    let clock = new Date("2026-10-26T12:00:00Z").getTime();
    const media = service({ timeouts: { provider: 20 }, now: () => new Date(clock) });
    routes[openverseUrl(args)!] = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    routes[wikimediaUrl(args)] = json(WIKIMEDIA_IMAGES);
    await media.search(args, signal());
    const openverseCalls = () => fetch.mock.calls.filter(([url]) => String(url).startsWith("https://api.openverse.org/")).length;
    expect(openverseCalls()).toBe(1);

    clock += 60_000;
    const rested = await media.search(args, signal());
    expect(openverseCalls()).toBe(1);
    expect(rested.warnings).toEqual([expect.stringMatching(/^Openverse was too slow a moment ago/)]);
    expect(rested.results.length).toBeGreaterThan(0);

    routes[openverseUrl(searchArgs({ preview: 0, sources: ["openverse"] }))!] = json(OPENVERSE_IMAGES);
    const alone = await media.search(searchArgs({ preview: 0, sources: ["openverse"] }), signal());
    expect(alone.results.length).toBeGreaterThan(0);

    clock += 5 * 60_000;
    routes[openverseUrl(args)!] = json(OPENVERSE_IMAGES);
    const back = await media.search(args, signal());
    expect(back.warnings).toEqual([]);
    expect(back.results.some((item) => item.provider === "openverse")).toBe(true);
  });

  it("searches Commons alone for video, and says so", async () => {
    const args = searchArgs({ kind: "video", preview: 0 });
    routes[wikimediaUrl(args)] = json({ batchcomplete: true });
    const result = await service().search(args, signal());
    expect(result).toEqual({ results: [], warnings: ["Openverse has no video; these results are from Wikimedia Commons only."], previews: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(service().search(searchArgs({ kind: "video", sources: ["openverse"] }), signal())).rejects.toThrow(/Openverse has no video/);
  });

  it("stops when the caller cancels", async () => {
    const args = searchArgs();
    routes[openverseUrl(args)!] = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    routes[wikimediaUrl(args)] = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const controller = new AbortController();
    const pending = service().search(args, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
  });
});

describe("web media download", () => {
  it("downloads a search result's file with its provenance, and records it only on commit", async () => {
    const media = service();
    const args = searchArgs({ preview: 0 });
    searchRoutes(args);
    const { results } = await media.search(args, signal());
    const apollo = results.find((item) => item.title === "Apollo 11 Launch")!;
    const bytes = jpeg(2048);
    routes[apollo.url] = file(bytes);

    // The result's page URL downloads the result's file.
    const downloaded = await download(media, apollo.pageUrl);
    const name = `apollo-11-launch-${sha(bytes).slice(0, 8)}.jpg`;
    expect(downloaded).toEqual({
      id: expect.any(String),
      source: `assets/web/${name}`,
      path: join(project, "assets", "web", name),
      kind: "image",
      mimeType: "image/jpeg",
      bytes: 2048,
      sha256: sha(bytes),
      title: "Apollo 11 Launch",
      creator: "NASA on The Commons",
      provider: "openverse",
      pageUrl: apollo.pageUrl,
      fileUrl: apollo.url,
      requestedUrl: apollo.pageUrl,
      license: apollo.license,
      attribution: apollo.attribution,
      deduplicated: false,
      creditsFile: join(project, "CREDITS.md"),
    });
    expect(readFileSync(downloaded.path)).toEqual(Buffer.from(bytes));
    expect(webFiles()).toEqual([name]);
    expect(existsSync(join(project, ".cutroom", "web-media.json"))).toBe(false);
    expect(existsSync(join(project, "CREDITS.md"))).toBe(false);

    const { creditsFile } = await media.commit({ id: downloaded.id, assetId: "a1b2c3d4e5f60718", src: `web/${name}`, source: downloaded.source });
    expect(creditsFile).toBe(join(project, "CREDITS.md"));
    expect(ledger().items).toEqual([expect.objectContaining({
      file: downloaded.source, sha256: sha(bytes), assetId: "a1b2c3d4e5f60718", src: `web/${name}`, provider: "openverse", fileUrl: apollo.url,
      requestedUrl: apollo.pageUrl, downloadedAt: "2026-10-26T12:00:00.000Z", license: expect.objectContaining({ code: "pdm", verified: true }),
    })]);
    const text = credits();
    expect(text).toMatch(/^# Credits\n\n<!-- cutroom:web-media:start -->\n## Web media\n/);
    expect(text).toContain(`- **Apollo 11 Launch**: \`web/${name}\``);
    expect(text).toContain(`  Credit: "Apollo 11 Launch" by NASA on The Commons (https://www.flickr.com/photos/nasacommons/9460707453), in the public domain (Public Domain Mark 1.0).`);
    expect(text).toContain("  License: Public Domain Mark 1.0 (<https://creativecommons.org/publicdomain/mark/1.0/>). Found on Openverse.");
    // The watcher is told first, so the project does not reload for the app's own write.
    expect(noteContent).toHaveBeenCalledWith(join(project, "CREDITS.md"), text);
  });

  it("resolves a web page to the image it shares, with an unverified license", async () => {
    routes["https://news.example/story"] = html(`<!doctype html><html><head><title>ignored</title>
      <meta property="og:title" content="Crowds watch the launch"><meta property="og:image" content="/images/crowd.jpg?w=1200"></head></html>`);
    const bytes = jpeg(900, 2);
    routes["https://news.example/images/crowd.jpg?w=1200"] = file(bytes);
    const downloaded = await download(service(), "https://news.example/story");
    expect(downloaded).toMatchObject({
      source: `assets/web/crowds-watch-the-launch-${sha(bytes).slice(0, 8)}.jpg`,
      title: "Crowds watch the launch",
      pageUrl: "https://news.example/story",
      fileUrl: "https://news.example/images/crowd.jpg?w=1200",
      license: { code: "unknown", verified: false, commercialUse: false, modificationsAllowed: false },
      attribution: "\"Crowds watch the launch\" (https://news.example/story), license not verified: confirm the rights before publishing.",
    });
    expect(downloaded).not.toHaveProperty("provider");
  });

  it("takes a page's video when preferred, and its picture when the video is only a player", async () => {
    const mp4 = new Uint8Array(700).fill(3);
    mp4.set([0, 0, 0, 24, ...[..."ftypisom"].map((char) => char.charCodeAt(0))]);
    routes["https://video.example/watch"] = html(`<meta property="og:video" content="https://video.example/clip.mp4"><meta property="og:image" content="https://video.example/poster.jpg">`);
    routes["https://video.example/clip.mp4"] = file(mp4, "video/mp4");
    routes["https://video.example/poster.jpg"] = file(jpeg(800, 3));
    expect(await download(service(), "https://video.example/watch", { prefer: "video" })).toMatchObject({ kind: "video", mimeType: "video/mp4", source: expect.stringMatching(/\.mp4$/) });
    expect(await download(service(), "https://video.example/watch")).toMatchObject({ kind: "image", fileUrl: "https://video.example/poster.jpg" });

    routes["https://tube.example/watch?v=1"] = html(`<meta property="og:video:url" content="https://tube.example/embed/1"><meta property="og:image" content="https://img.tube.example/1/maxres.jpg">`);
    routes["https://tube.example/embed/1"] = html("<html><body><script>player()</script></body></html>");
    routes["https://img.tube.example/1/maxres.jpg"] = file(jpeg(640, 4));
    expect(await download(service(), "https://tube.example/watch?v=1", { prefer: "video" })).toMatchObject({ kind: "image", fileUrl: "https://img.tube.example/1/maxres.jpg" });
  });

  it("refuses a search result whose file now answers with a web page, rather than credit what that page shares", async () => {
    const media = service();
    const args = searchArgs({ preview: 0, sources: ["openverse"] });
    routes[openverseUrl(args)!] = json(OPENVERSE_IMAGES);
    const { results } = await media.search(args, signal());
    const result = results[0]!;
    const logo = new URL("/static/site-logo.png", result.url).href;
    routes[result.url] = html(`<html><head><title>Not found</title><meta property="og:image" content="/static/site-logo.png"></head></html>`);
    routes[logo] = file(png(), "image/png");
    for (const url of [result.url, result.pageUrl]) {
      expect(await failure(download(media, url))).toMatchObject({ code: "not-found", message: RESULT_MOVED });
    }
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(logo);
    expect(webFiles()).toEqual([]);
  });

  it("says why a page's shared media would not download, keeping its error's code", async () => {
    routes["https://blog.example/post"] = html(`<meta property="og:image" content="https://cdn.example/hero.jpg"><meta name="twitter:image" content="https://cdn.example/card.jpg">`);
    routes["https://cdn.example/hero.jpg"] = () => new Response("Forbidden", { status: 403 });
    routes["https://cdn.example/card.jpg"] = () => new Response("Not found", { status: 404 });
    expect(await failure(download(service(), "https://blog.example/post"))).toMatchObject({
      code: "invalid-input",
      message: "The page shares media at cdn.example, but downloading it failed: cdn.example refused the download (403); it may need a sign-in or block downloads. Pick another result or link.",
    });
    routes["https://cdn.example/hero.jpg"] = () => new Response("Slow down", { status: 429 });
    expect(await failure(download(service(), "https://blog.example/post"))).toMatchObject({
      code: "busy", message: expect.stringMatching(/^The page shares media at cdn\.example, but downloading it failed: cdn\.example is rate limiting requests \(429\)/),
    });
    routes["https://blog.example/lan"] = html(`<meta property="og:image" content="http://192.168.1.20/hero.jpg">`);
    expect((await failure(download(service(), "https://blog.example/lan"))).message).toBe(`The page shares media at 192.168.1.20, but downloading it failed: ${PRIVATE_ADDRESS}`);
    expect(webFiles()).toEqual([]);
  });

  it("explains a page that shares nothing downloadable", async () => {
    routes["https://social.example/reel/1"] = html("<html><head><title>Reel</title></head><body><video src=blob:x></video></body></html>");
    await expect(download(service(), "https://social.example/reel/1")).rejects.toThrow(NO_PAGE_MEDIA);
    routes["https://social.example/reel/2"] = html(`<meta property="og:image" content="https://social.example/login">`);
    routes["https://social.example/login"] = html("<!doctype html><html></html>");
    await expect(download(service(), "https://social.example/reel/2")).rejects.toThrow(NO_PAGE_MEDIA);
    expect(webFiles()).toEqual([]);
  });

  it("follows redirects, checking every hop before requesting it", async () => {
    const bytes = jpeg(400, 5);
    routes["https://short.example/a"] = redirect("https://cdn.example/b", 301);
    routes["https://cdn.example/b"] = redirect("/c.jpg", 307);
    routes["https://cdn.example/c.jpg"] = file(bytes);
    expect(await download(service(), "https://short.example/a")).toMatchObject({ fileUrl: "https://cdn.example/c.jpg", requestedUrl: "https://short.example/a" });

    routes["https://short.example/local"] = redirect("http://127.0.0.1:43127/mcp");
    await expect(download(service(), "https://short.example/local")).rejects.toThrow(PRIVATE_ADDRESS);
    routes["https://short.example/lan"] = redirect("https://router.example/admin.jpg");
    hosts["router.example"] = [{ address: "192.168.1.1", family: 4 }];
    await expect(download(service(), "https://short.example/lan")).rejects.toThrow(PRIVATE_ADDRESS);
    routes["https://short.example/creds"] = redirect("https://user:pw@cdn.example/c.jpg");
    await expect(download(service(), "https://short.example/creds")).rejects.toThrow(/user name or password/);
    routes["https://short.example/file"] = redirect("file:///etc/passwd");
    await expect(download(service(), "https://short.example/file")).rejects.toThrow(/http and https/);
    for (let i = 0; i < 7; i++) routes[`https://loop.example/${i}`] = redirect(`https://loop.example/${i + 1}`);
    await expect(download(service(), "https://loop.example/0")).rejects.toThrow("That link redirects more than 5 times.");
    const requested = fetch.mock.calls.map(([url]) => url);
    expect(requested).not.toContain("http://127.0.0.1:43127/mcp");
    expect(requested).not.toContain("https://router.example/admin.jpg");
  });

  it("refuses private, local and credentialed links before any request", async () => {
    hosts["rebind.example"] = [{ address: "93.184.216.34", family: 4 }, { address: "::ffff:10.0.0.1", family: 6 }];
    for (const url of [
      "http://localhost:43127/mcp", "http://127.0.0.1/a.jpg", "http://[::1]/a.jpg", "http://[::ffff:127.0.0.1]/a.jpg", "http://10.0.0.1/a.jpg",
      "http://169.254.169.254/latest", "http://nas.local/a.jpg", "http://intranet/a.jpg", "https://rebind.example/a.jpg",
    ]) await expect(download(service(), url), url).rejects.toThrow(PRIVATE_ADDRESS);
    await expect(download(service(), "https://me:secret@example.com/a.jpg")).rejects.toThrow(/user name or password/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("judges files by their bytes, not their declared type", async () => {
    routes["https://e.example/scan.jpg"] = file(new Uint8Array([0x49, 0x49, 0x2a, 0x00, ...new Array(100).fill(1)]));
    await expect(download(service(), "https://e.example/scan.jpg")).rejects.toThrow("Choose a JPEG/PNG/WebP rendition of this image.");
    routes["https://e.example/doc.jpg"] = file(new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj"));
    await expect(download(service(), "https://e.example/doc.jpg")).rejects.toThrow(/isn't an image, video or audio file/);
    routes["https://e.example/empty.jpg"] = file(new Uint8Array(0));
    await expect(download(service(), "https://e.example/empty.jpg")).rejects.toThrow(/isn't an image, video or audio file/);
    routes["https://e.example/mislabeled"] = file(png(), "text/plain");
    expect(await download(service(), "https://e.example/mislabeled")).toMatchObject({ kind: "image", mimeType: "image/png", source: expect.stringMatching(/^assets\/web\/mislabeled-[0-9a-f]{8}\.png$/) });
    routes["https://e.example/gone.jpg"] = () => new Response("gone", { status: 410 });
    await expect(download(service(), "https://e.example/gone.jpg")).rejects.toMatchObject({ code: "not-found" });
    expect(webFiles().filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("caps each kind: by declared length before writing, then by counting what streams", async () => {
    const media = service({ caps: { image: 1000 } });
    routes["https://e.example/declared.jpg"] = file(jpeg(500), "image/jpeg", { "content-length": "5000" });
    await expect(download(media, "https://e.example/declared.jpg")).rejects.toThrow(/This image is larger than 0 MB/);
    routes["https://e.example/streamed.jpg"] = () => new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < 4; i++) controller.enqueue(jpeg(800, i)); controller.close(); },
    }));
    await expect(download(media, "https://e.example/streamed.jpg")).rejects.toThrow(/larger than/);
    expect(webFiles()).toEqual([]);
  });

  it("reuses the same bytes: a recorded file, and one still being imported", async () => {
    const media = service();
    const bytes = jpeg(1200, 6);
    routes["https://a.example/one.jpg"] = file(bytes);
    routes["https://b.example/two.jpg"] = file(bytes);
    routes["https://c.example/three.jpg"] = file(bytes);
    const first = await download(media, "https://a.example/one.jpg", { name: "Launch pad" });
    const second = await download(media, "https://b.example/two.jpg");
    expect(second).toMatchObject({ source: first.source, deduplicated: true });
    await media.commit({ id: first.id, assetId: "asset", src: "web/x.jpg", source: first.source });
    await media.commit({ id: second.id, assetId: "asset", src: "web/x.jpg", source: second.source });
    const third = await download(media, "https://c.example/three.jpg");
    expect(third).toMatchObject({ source: first.source, deduplicated: true });
    expect(third).not.toHaveProperty("title");
    expect(webFiles()).toEqual([`launch-pad-${sha(bytes).slice(0, 8)}.jpg`]);
    expect(ledger().items).toHaveLength(1);
  });

  it("lands the bytes again when the earlier download's file was edited since", async () => {
    const media = service();
    const bytes = jpeg(1200, 14);
    const stem = `pier-${sha(bytes).slice(0, 8)}`;
    routes["https://e.example/pier.jpg"] = file(bytes);
    const first = await download(media, "https://e.example/pier.jpg");
    await media.commit({ id: first.id, assetId: "1", src: "web/pier.jpg", source: first.source });
    // Converted in place: another size, another kind.
    writeFileSync(first.path, png(100));
    const second = await download(media, "https://e.example/pier.jpg");
    expect(second).toMatchObject({ deduplicated: false, bytes: 1200, mimeType: "image/jpeg", source: `assets/web/${stem}-2.jpg` });
    expect(readFileSync(second.path)).toEqual(Buffer.from(bytes));
    expect(readFileSync(first.path)).toEqual(Buffer.from(png(100)));
    // An untouched one, still pending, is reused; one edited to the same size is not.
    expect(await download(media, "https://e.example/pier.jpg")).toMatchObject({ deduplicated: true, source: second.source });
    writeFileSync(second.path, jpeg(1200, 16));
    const third = await download(media, "https://e.example/pier.jpg");
    expect(third).toMatchObject({ deduplicated: false, source: `assets/web/${stem}-3.jpg` });
    expect(readFileSync(third.path)).toEqual(Buffer.from(bytes));
  });

  it("lands one file for the same bytes downloaded at once, and the last download out cleans it up", async () => {
    const media = service();
    const bytes = jpeg(1300, 12);
    routes["https://a.example/x.jpg"] = file(bytes);
    routes["https://b.example/y.jpg"] = file(bytes);
    const [first, second] = await Promise.all([
      download(media, "https://a.example/x.jpg", { name: "first" }),
      download(media, "https://b.example/y.jpg", { name: "second" }),
    ]);
    expect(second.source).toBe(first.source);
    expect([first.deduplicated, second.deduplicated].sort()).toEqual([false, true]);
    expect(webFiles()).toHaveLength(1);
    const [owner, reuser] = first.deduplicated ? [second, first] : [first, second];
    await media.discard(owner.id);
    expect(existsSync(owner.path)).toBe(true);
    await media.discard(reuser.id);
    expect(webFiles()).toEqual([]);
  });

  it("names a different file that collides on name and hash prefix with a suffix", async () => {
    const bytes = jpeg(1100, 13);
    mkdirSync(join(project, "assets", "web"), { recursive: true });
    writeFileSync(join(project, "assets", "web", `pad-${sha(bytes).slice(0, 8)}.jpg`), "someone else's file");
    routes["https://e.example/pad.jpg"] = file(bytes);
    expect(await download(service(), "https://e.example/pad.jpg")).toMatchObject({ source: `assets/web/pad-${sha(bytes).slice(0, 8)}-2.jpg`, deduplicated: false });
    // The same bytes already under that name are reused even without a record.
    routes["https://f.example/pad.jpg"] = file(bytes);
    expect(await download(service(), "https://f.example/pad.jpg")).toMatchObject({ source: `assets/web/pad-${sha(bytes).slice(0, 8)}-2.jpg`, deduplicated: true });
  });

  it("explains a connection that breaks off mid-download", async () => {
    routes["https://flaky.example/a.jpg"] = () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(jpeg(5000)); },
      pull(stream) { stream.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })); },
    }));
    await expect(download(service(), "https://flaky.example/a.jpg")).rejects.toThrow("The connection to flaky.example broke off mid-download. Try again.");
    expect(webFiles()).toEqual([]);
  });

  it("waits out a provider host's rate limit as it asks, at most twice and 30 seconds in all", async () => {
    const original = "https://upload.wikimedia.org/wikipedia/commons/2/25/Apollo.jpg";
    const limited = (status: number, headers: Record<string, string> = {}) => () => new Response("slow down", { status, headers });
    const answers = (...list: Route[]): Route => (init) => (list.length > 1 ? list.shift()! : list[0]!)(init);
    const calls = (url: string) => fetch.mock.calls.filter(([called]) => called === url).length;
    const media = service({ timeouts: { backoff: 5 } });

    // Retry-After honored, then the file.
    routes[original] = answers(limited(429, { "retry-after": "0" }), limited(503), file(jpeg(700, 21)));
    expect(await download(media, original)).toMatchObject({ bytes: 700 });
    expect(calls(original)).toBe(3);

    // Twice at most, then the host's answer.
    const busy = "https://upload.wikimedia.org/wikipedia/commons/3/3c/Busy.jpg";
    routes[busy] = limited(429, { "retry-after": "0" });
    expect(await failure(download(media, busy))).toMatchObject({ code: "busy", message: expect.stringMatching(/upload\.wikimedia\.org is rate limiting requests \(429\)/) });
    expect(calls(busy)).toBe(3);

    // A wait past the budget isn't waited: the agent hears how long.
    const later = "https://upload.wikimedia.org/wikipedia/commons/4/4d/Later.jpg";
    routes[later] = limited(429, { "retry-after": "120" });
    expect(await failure(download(media, later))).toMatchObject({ code: "busy", message: expect.stringMatching(/Wait 120 seconds or pick another result/) });
    expect(calls(later)).toBe(1);

    // Any other host's 429 is its answer.
    routes["https://e.example/limited.jpg"] = limited(429, { "retry-after": "0" });
    await expect(download(media, "https://e.example/limited.jpg")).rejects.toMatchObject({ code: "busy" });
    expect(calls("https://e.example/limited.jpg")).toBe(1);

    // A search's previews aren't retried: one that isn't there at once is left out.
    const args = searchArgs({ preview: 2, sources: ["wikimedia"] });
    routes[wikimediaUrl(args)] = json(WIKIMEDIA_IMAGES);
    const thumb = "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Kennedy_Space_Center_panorama.tif/lossy-page1-500px-Kennedy_Space_Center_panorama.tif.jpg";
    routes[thumb] = limited(429, { "retry-after": "0" });
    expect((await media.search(args, signal())).previews.map((preview) => preview.index)).not.toContain(1);
    expect(calls(thumb)).toBe(1);

    expect(retryAfter("7", 0)).toBe(7000);
    expect(retryAfter("Mon, 26 Oct 2026 12:00:30 GMT", Date.parse("2026-10-26T12:00:00Z"))).toBe(30_000);
    expect(retryAfter("soon", 0)).toBeUndefined();
    expect(retryAfter(null, 0)).toBeUndefined();
  });

  it("downloads from one host two at a time, the rest waiting their turn", async () => {
    const media = service();
    const host = "https://upload.wikimedia.org/wikipedia/commons";
    const controls: Array<{ finish?: () => void }> = [{}, {}, {}, {}];
    controls.forEach((control, i) => { routes[`${host}/${i}/0${i}/F${i}.jpg`] = slowFile(control); });
    const started = () => fetch.mock.calls.filter(([url]) => url.startsWith(host)).length;
    const first = download(media, `${host}/0/00/F0.jpg`);
    const second = download(media, `${host}/1/01/F1.jpg`);
    await vi.waitFor(() => expect(started()).toBe(2));
    const waiting = new AbortController();
    const third = download(media, `${host}/2/02/F2.jpg`, { signal: waiting.signal });
    const fourth = download(media, `${host}/3/03/F3.jpg`);
    // Another host isn't held up, while these two wait.
    routes["https://e.example/free.jpg"] = file(jpeg(650, 22));
    await expect(download(media, "https://e.example/free.jpg")).resolves.toMatchObject({ bytes: 650 });
    expect(started()).toBe(2);

    // One that waits can be canceled without ever starting, and gives up no one's turn.
    waiting.abort();
    expect(await failure(third)).toMatchObject({ code: "canceled" });
    controls[0]!.finish!();
    await first;
    await vi.waitFor(() => expect(started()).toBe(3));
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(`${host}/2/02/F2.jpg`);
    controls[1]!.finish!();
    controls[3]!.finish!();
    await expect(Promise.all([second, fourth])).resolves.toHaveLength(2);
  });

  it("explains a Commons rendition at a width Commons doesn't render, without suggesting a retry", async () => {
    const odd = "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/Apollo_16.tif/lossless-page1-1237px-Apollo_16.tif.png";
    routes[odd] = () => new Response("Error: 400, Use thumbnail sizes listed on https://w.wiki/GHai", { status: 400 });
    const error = await failure(download(service(), odd));
    expect(error).toMatchObject({ code: "invalid-input", message: expect.stringMatching(/^thumb\.wikimedia\.org doesn't render this image at that width \(400\).*120, 250, 330, 500, 960, 1280, 1920, 3840 px/) });
    expect(error.message).not.toMatch(/try again/i);
    routes["https://e.example/bad"] = () => new Response("no", { status: 400 });
    await expect(download(service(), "https://e.example/bad")).rejects.toThrow("e.example refused the request (400). Check the link or pick another result.");
  });

  it("names a configured proxy when a host can't be reached, and only then", async () => {
    const refused = () => { throw Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), { code: "ECONNREFUSED" }); };
    routes["https://e.example/a.jpg"] = refused;
    const proxied = service({ proxy: () => "HTTPS_PROXY is set" });
    await expect(download(proxied, "https://e.example/a.jpg")).rejects.toThrow(
      "Couldn't reach e.example (ECONNREFUSED). This Mac is set up to use a proxy (HTTPS_PROXY is set), which Cutroom's downloader doesn't go through: allow direct connections to e.example, or download the file in a browser and import it.",
    );
    await expect(download(service({ proxy: () => undefined }), "https://e.example/a.jpg")).rejects.toThrow("Couldn't reach e.example (ECONNREFUSED). Check the link or try again.");
    // A name that doesn't resolve, the way a proxy-only network answers.
    resolve.mockImplementation(async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); });
    await expect(download(proxied, "https://e.example/a.jpg")).rejects.toMatchObject({
      code: "not-found", message: expect.stringMatching(/^Couldn't find the server e\.example \(ENOTFOUND\)\. Check the link\. This Mac is set up to use a proxy/),
    });
    // A refused private address is not a proxy's doing.
    resolve.mockImplementation(async () => [{ address: "10.0.0.1", family: 4 }]);
    await expect(download(proxied, "https://e.example/a.jpg")).rejects.toThrow(PRIVATE_ADDRESS);
    expect(environmentProxy({ https_proxy: "http://proxy.corp:3128" })).toBe("https_proxy is set");
    expect(environmentProxy({ HTTP_PROXY: " " })).toBeUndefined();
  });

  it("names a configured proxy when a host never answers, as on a network that drops direct connections", async () => {
    const silent: Route = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    routes["https://e.example/a.jpg"] = silent;
    const asked: string[] = [];
    // Electron's session.resolveProxy answers later.
    const proxied = service({ timeouts: { header: 20 }, proxy: async (url) => { asked.push(url.href); return "HTTPS proxy proxy.corp:3128 in System Settings"; } });
    await expect(download(proxied, "https://e.example/a.jpg")).rejects.toMatchObject({
      code: "canceled",
      message: "e.example didn't answer within 0 seconds. This Mac is set up to use a proxy (HTTPS proxy proxy.corp:3128 in System Settings), which Cutroom's downloader doesn't go through: allow direct connections to e.example, or download the file in a browser and import it.",
    });
    expect(asked).toEqual(["https://e.example/a.jpg"]);
    await expect(download(service({ timeouts: { header: 20 } }), "https://e.example/a.jpg")).rejects.toThrow("e.example didn't answer within 0 seconds. Try again later or pick another result.");
    // A proxy lookup that fails says nothing about a proxy.
    await expect(download(service({ timeouts: { header: 20 }, proxy: async () => { throw new Error("no session"); } }), "https://e.example/a.jpg"))
      .rejects.toThrow("e.example didn't answer within 0 seconds. Try again later or pick another result.");

    // A search whose providers never answer names the proxy too, with advice for a search.
    const args = searchArgs({ preview: 0 });
    routes[openverseUrl(args)!] = silent;
    routes[wikimediaUrl(args)] = silent;
    const error = await service({ timeouts: { provider: 20 }, proxy: () => "HTTPS_PROXY is set" }).search(args, signal()).catch((failure: Error) => failure);
    expect(error).toMatchObject({
      code: "unsupported",
      message: "Web media search failed. Openverse: didn't answer within 0 seconds. This Mac is set up to use a proxy (HTTPS_PROXY is set), which Cutroom's web media search doesn't go through: allow direct connections to api.openverse.org. Wikimedia Commons: didn't answer within 0 seconds. This Mac is set up to use a proxy (HTTPS_PROXY is set), which Cutroom's web media search doesn't go through: allow direct connections to commons.wikimedia.org.",
    });
    // As does a provider that refuses the connection.
    routes[wikimediaUrl(args)] = () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
    const refused = await service({ proxy: () => "HTTPS_PROXY is set" }).search(searchArgs({ preview: 0, sources: ["wikimedia"] }), signal()).catch((failure: Error) => failure);
    expect((refused as Error).message).toBe(
      "Web media search failed. Wikimedia Commons: Couldn't reach commons.wikimedia.org (ECONNREFUSED). This Mac is set up to use a proxy (HTTPS_PROXY is set), which Cutroom's web media search doesn't go through: allow direct connections to commons.wikimedia.org.",
    );
  });

  it("reads the proxy macOS's network settings turn on", () => {
    const settings = (lines: string[]) => `<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n  }\n  FTPPassive : 1\n${lines.map((line) => `  ${line}\n`).join("")}}\n`;
    expect(scutilProxy(settings(["HTTPEnable : 1", "HTTPPort : 8080", "HTTPProxy : web.corp", "HTTPSEnable : 1", "HTTPSPort : 3128", "HTTPSProxy : proxy.corp"])))
      .toBe("HTTPS proxy proxy.corp:3128 in System Settings");
    expect(scutilProxy(settings(["HTTPEnable : 1", "HTTPPort : 8080", "HTTPProxy : web.corp", "HTTPSEnable : 0", "HTTPSProxy : proxy.corp"]))).toBe("HTTP proxy web.corp:8080 in System Settings");
    expect(scutilProxy(settings(["SOCKSEnable : 1", "SOCKSProxy : 127.0.0.1", "SOCKSPort : 1080"]))).toBe("SOCKS proxy 127.0.0.1:1080 in System Settings");
    expect(scutilProxy(settings(["ProxyAutoConfigEnable : 1", "ProxyAutoConfigURLString : http://wpad.corp/proxy.pac"]))).toBe("automatic proxy configuration in System Settings");
    // A Mac with no proxy: macOS lists the off switches, or nothing.
    expect(scutilProxy(settings(["HTTPEnable : 0", "HTTPSEnable : 0", "ProxyAutoDiscoveryEnable : 1", "SOCKSEnable : 0"]))).toBeUndefined();
    expect(scutilProxy("<dictionary> {\n}\n")).toBeUndefined();
    expect(scutilProxy(settings(["HTTPSEnable : 1"]))).toBeUndefined();
  });

  it("finds a search result by its URL with or without Commons' tracking parameters", async () => {
    const media = service();
    const args = searchArgs({ preview: 0, sources: ["wikimedia"] });
    const tagged = structuredClone(WIKIMEDIA_IMAGES);
    const apollo = tagged.query.pages.find((page) => page.pageid === 1532211)!.imageinfo[0]!;
    const plain = apollo.url;
    apollo.url = `${plain}?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original`;
    routes[wikimediaUrl(args)] = json(tagged);
    const { results } = await media.search(args, signal());
    expect(results.find((item) => item.id === "wikimedia:1532211")!.url).toBe(apollo.url);
    // The file is fetched as the result gave it; the link without the parameters still carries its license.
    routes[apollo.url] = file(jpeg(720, 23));
    expect(await download(media, plain)).toMatchObject({ fileUrl: apollo.url, requestedUrl: plain, provider: "wikimedia", license: { verified: true } });
  });

  it("upgrades an unverified record when a search result turns out to be the same file", async () => {
    const media = service();
    const args = searchArgs({ preview: 0, sources: ["openverse"] });
    routes[openverseUrl(args)!] = json(OPENVERSE_IMAGES);
    const bytes = jpeg(1500, 7);
    routes["https://mirror.example/apollo.jpg"] = file(bytes);
    const raw = await download(media, "https://mirror.example/apollo.jpg");
    await media.commit({ id: raw.id, assetId: "asset", src: "web/a.jpg", source: raw.source });
    expect(ledger().items[0]!.license.verified).toBe(false);

    const { results } = await media.search(args, signal());
    routes[results[0]!.url] = file(bytes);
    const found = await download(media, results[0]!.url);
    expect(found).toMatchObject({ deduplicated: true, source: raw.source, license: { verified: true, code: "pdm" } });
    await media.commit({ id: found.id, assetId: "asset", src: "web/a.jpg", source: found.source });
    expect(ledger().items).toEqual([expect.objectContaining({ file: raw.source, provider: "openverse", license: expect.objectContaining({ verified: true }) })]);
    expect(credits()).not.toContain("not verified");

    // And not the other way round: the unverified link keeps the verified record.
    const again = await download(media, "https://mirror.example/apollo.jpg");
    expect(again.license.verified).toBe(true);
  });

  it("stops on cancel and leaves no partial file", async () => {
    const controller = new AbortController();
    routes["https://slow.example/big.jpg"] = ({ signal }) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(jpeg(5000));
        signal.addEventListener("abort", () => stream.error(signal.reason));
      },
    }));
    const pending = download(service(), "https://slow.example/big.jpg", { signal: controller.signal });
    await vi.waitFor(() => expect(webFiles().some((name) => name.startsWith(".dstmp-"))).toBe(true));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
    expect(webFiles()).toEqual([]);
  });

  it("holds no write into the project while it fetches, so a duplicate need not wait for the network", async () => {
    const atRelease: string[][] = [];
    const startWrite = vi.fn((_dir: string) => () => void atRelease.push(webFiles()));
    const media = service({ startWrite });
    const control: { finish?: () => void } = {};
    routes["https://slow.example/big.jpg"] = slowFile(control);
    const pending = download(media, "https://slow.example/big.jpg");
    await vi.waitFor(() => expect(partial()).toBe(true));
    expect(startWrite).not.toHaveBeenCalled();
    // Landing is a write: claimed for it alone, and let go of once the file has its name.
    control.finish!();
    const downloaded = await pending;
    expect(startWrite).toHaveBeenCalledTimes(1);
    expect(atRelease).toEqual([[basename(downloaded.path)]]);
  });

  it("is stopped by a save of the project, which waits until its partial file is gone", async () => {
    const atRelease: string[][] = [];
    const startWrite = vi.fn((_dir: string) => () => void atRelease.push(webFiles()));
    const media = service({ startWrite });
    routes["https://slow.example/big.jpg"] = slowFile();
    const pending = download(media, "https://slow.example/big.jpg");
    await vi.waitFor(() => expect(partial()).toBe(true));
    media.cancelDownloads(join(root, "another-project"));
    expect(startWrite).not.toHaveBeenCalled();
    // A write from the moment it is stopped, before the save looks for writes to wait on.
    media.cancelDownloads(project);
    expect(startWrite).toHaveBeenCalledWith(project);
    expect(atRelease).toEqual([]);
    expect(await failure(pending)).toMatchObject({ code: "no-project", message: expect.stringMatching(/saved or moved during the download/) });
    // Let go of only once the partial file was gone, so the save moves a clean folder.
    expect(atRelease).toEqual([[]]);

    // Stopped while landing: the landed file goes again before the save goes on.
    routes["https://e.example/late.jpg"] = file(jpeg(800, 17));
    const landing: WebMediaService = service({ startWrite, now: () => { landing.cancelDownloads(project); return new Date("2026-10-26T12:00:00Z"); } });
    expect(await failure(download(landing, "https://e.example/late.jpg"))).toMatchObject({ code: "no-project" });
    expect(atRelease.at(-1)).toEqual([]);
  });

  it("removes its partial file at once when the app quits", async () => {
    const media = service();
    routes["https://slow.example/big.jpg"] = slowFile();
    const pending = download(media, "https://slow.example/big.jpg");
    await vi.waitFor(() => expect(partial()).toBe(true));
    media.dispose();
    expect(webFiles()).toEqual([]);
    expect(await failure(pending)).toMatchObject({ code: "canceled", message: "Cutroom quit during the download." });
  });

  it("reports a project folder that moved away mid-download as the project's, and never makes it again", async () => {
    const control: { finish?: () => void } = {};
    routes["https://slow.example/big.jpg"] = slowFile(control);
    const pending = download(service(), "https://slow.example/big.jpg");
    await vi.waitFor(() => expect(partial()).toBe(true));
    const moved = `${project}-moved`;
    renameSync(project, moved);
    control.finish!();
    expect(await failure(pending)).toMatchObject({ code: "no-project", message: expect.stringMatching(/moved or closed during the download/) });
    expect(existsSync(project)).toBe(false);

    // Gone before there was an assets/web to write into: the old folder is not made again for it.
    const later = mkdtempSync(join(root, "project-"));
    project = later;
    routes["https://e.example/late.jpg"] = () => {
      renameSync(later, `${later}-moved`);
      return file(jpeg(700, 15))();
    };
    expect(await failure(download(service(), "https://e.example/late.jpg"))).toMatchObject({ code: "no-project" });
    expect(existsSync(later)).toBe(false);
  });

  it("times out a server that stalls before answering or mid-file", async () => {
    const media = service({ timeouts: { header: 25, idle: 25 } });
    routes["https://stall.example/headers.jpg"] = () => new Promise<Response>(() => {});
    await expect(download(media, "https://stall.example/headers.jpg")).rejects.toThrow(/stall\.example didn't answer within/);
    routes["https://stall.example/body.jpg"] = () => new Response(new ReadableStream({ start(stream) { stream.enqueue(jpeg(5000)); } }));
    await expect(download(media, "https://stall.example/body.jpg")).rejects.toThrow(/stall\.example stopped sending data/);
    expect(webFiles()).toEqual([]);
    const overall = service({ timeouts: { overall: 25 } });
    await expect(download(overall, "https://stall.example/body.jpg")).rejects.toThrow(/took longer than/);
  });

  it("refuses an assets/web that leads outside the project", async () => {
    const outside = mkdtempSync(join(root, "outside-"));
    mkdirSync(join(project, "assets"));
    symlinkSync(outside, join(project, "assets", "web"));
    routes["https://e.example/a.jpg"] = file(jpeg());
    await expect(download(service(), "https://e.example/a.jpg")).rejects.toThrow(/leads outside the project/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("keeps the user's own CREDITS.md and rewrites only its section, listing files still there", async () => {
    writeFileSync(join(project, "CREDITS.md"), "# Credits\n\nMusic: our own band.\n");
    const media = service();
    routes["https://e.example/one.jpg"] = file(jpeg(700, 8));
    routes["https://e.example/two.png"] = file(png(400), "image/png");
    const one = await download(media, "https://e.example/one.jpg");
    await media.commit({ id: one.id, assetId: "1", src: "web/one.jpg", source: one.source });
    const two = await download(media, "https://e.example/two.png");
    rmSync(one.path);
    await media.commit({ id: two.id, assetId: "2", src: "web/two.png", source: two.source });
    const text = credits();
    expect(text.startsWith("# Credits\n\nMusic: our own band.\n\n<!-- cutroom:web-media:start -->")).toBe(true);
    expect(text.match(/cutroom:web-media:start/g)).toHaveLength(1);
    expect(text).toContain("`web/two.png`");
    expect(text).not.toContain("`web/one.jpg`");
    expect(text).toContain("License: not verified. Confirm the rights before publishing.");
    expect(ledger().items.map((item) => item.src)).toEqual(["web/one.jpg", "web/two.png"]);
  });

  it("discards a download the library refused, but never a file the project already had", async () => {
    const media = service();
    const bytes = jpeg(900, 9);
    routes["https://e.example/a.jpg"] = file(bytes);
    const kept = await download(media, "https://e.example/a.jpg");
    await media.commit({ id: kept.id, assetId: "1", src: "web/a.jpg", source: kept.source });
    const again = await download(media, "https://e.example/a.jpg");
    await media.discard(again.id);
    expect(existsSync(kept.path)).toBe(true);

    routes["https://e.example/b.png"] = file(png(500), "image/png");
    const refused = await download(media, "https://e.example/b.png");
    await media.discard(refused.id);
    expect(existsSync(refused.path)).toBe(false);
    await expect(media.commit({ id: refused.id, assetId: "", src: "", source: refused.source })).rejects.toThrow(/no longer pending/);
  });

  it("credits the library's own asset when it already held the bytes, and drops the duplicate", async () => {
    const media = service();
    routes["https://e.example/a.jpg"] = file(jpeg(950, 10));
    const downloaded = await download(media, "https://e.example/a.jpg");
    await media.commit({ id: downloaded.id, assetId: "same", src: "Footage/a.jpg", source: "/Users/someone/Pictures/a.jpg" });
    expect(existsSync(downloaded.path)).toBe(false);
    expect(ledger().items[0]).toMatchObject({ file: "/Users/someone/Pictures/a.jpg", src: "Footage/a.jpg" });
    await expect(media.commit({ id: "nope", assetId: "", src: "", source: "../escape.jpg" })).rejects.toThrow(/no longer pending/);
  });

  it("records a download the renderer never answered for", async () => {
    const media = service({ timeouts: { pending: 20 } });
    routes["https://e.example/a.jpg"] = file(jpeg(700, 11));
    const downloaded = await download(media, "https://e.example/a.jpg");
    await vi.waitFor(() => expect(existsSync(join(project, ".cutroom", "web-media.json"))).toBe(true));
    expect(ledger().items).toEqual([expect.objectContaining({ file: downloaded.source })]);
    expect(ledger().items[0]).not.toHaveProperty("assetId");
  });

  it("names files from the given name, the title, or the URL", () => {
    expect(slugFor("Apollo 11: Liftoff! (1969)")).toBe("apollo-11-liftoff-1969");
    expect(slugFor(undefined, "Café Señor — Ünïcode")).toBe("cafe-senor-unicode");
    expect(slugFor("   ", "", "IMG_2041")).toBe("img-2041");
    expect(slugFor("火箭")).toBe("web-media");
    expect(slugFor("a".repeat(80))).toHaveLength(48);
  });
});

describe("pinnedFetch", () => {
  const server = createServer((request, response) => {
    if (request.url === "/gz") {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(gzipSync(JSON.stringify({ ok: true })));
    } else if (request.url === "/redirect") {
      response.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "text/plain", "x-agent": String(request.headers["user-agent"]) });
      response.end("plain");
    }
  });
  let port = 0;
  beforeEach(async () => {
    if (!server.listening) await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it("refuses at connect time a name that now resolves to this machine", async () => {
    const rebinding = pinnedFetch(async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(rebinding(`http://rebind.example:${port}/`, { signal: signal(), headers: {} })).rejects.toThrow(PRIVATE_ADDRESS);
  });

  it("speaks HTTP: headers out, decoded bodies back, redirects left to the caller", async () => {
    const transport = pinnedFetch(async () => PUBLIC);
    // An address needs no lookup; the service has already refused private ones.
    const plain = await transport(`http://127.0.0.1:${port}/`, { signal: signal(), headers: { "user-agent": "Cutroom/test" } });
    expect([plain.status, plain.headers.get("x-agent"), await plain.text()]).toEqual([200, "Cutroom/test", "plain"]);
    const gz = await transport(`http://127.0.0.1:${port}/gz`, { signal: signal(), headers: {} });
    expect(await gz.json()).toEqual({ ok: true });
    const moved = await transport(`http://127.0.0.1:${port}/redirect`, { signal: signal(), headers: {} });
    expect([moved.status, moved.headers.get("location")]).toEqual([302, "http://127.0.0.1/elsewhere"]);
  });
});
