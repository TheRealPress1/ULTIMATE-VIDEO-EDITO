/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DapiError } from "@diffusionstudio/dapi";
import { fetchMyInstantsSound, myInstantsPage, parseInstantPage, parseSearchPage, searchMyInstants } from "./media-download-myinstants";
import { BOT_SCREEN, MYINSTANTS_PAGE, MYINSTANTS_PAGE_OFFSITE, MYINSTANTS_SEARCH } from "./media-fixtures";

import type { PageFetch } from "./media-download-myinstants";

const root = mkdtempSync(join(tmpdir(), "myinstants-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const temp = () => join(root, `sound-${++n}.mp3`);

const PUBLIC = async () => [{ address: "104.21.0.1", family: 4 as const }];
const PAGE = "https://www.myinstants.com/en/instant/boing-spring-123/";
const MP3 = Buffer.concat([Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000", "latin1"), Buffer.alloc(2000, 7)]);

function site(routes: Record<string, () => Response>) {
  const fetch = vi.fn<PageFetch>(async (url) => routes[url]?.() ?? new Response("missing", { status: 404 }));
  return { fetch, deps: { fetch, resolve: PUBLIC, signal: new AbortController().signal } };
}

describe("MyInstants pages", () => {
  it.each([
    [PAGE, { slug: "boing-spring-123", url: PAGE }],
    ["http://myinstants.com/instant/Boing-Spring-123", { slug: "boing-spring-123", url: "https://www.myinstants.com/instant/boing-spring-123/" }],
    ["https://www.myinstants.com/en/instant/boing/?utm=x#y", { slug: "boing", url: "https://www.myinstants.com/en/instant/boing/" }],
  ])("%s is a sound page", (url, page) => expect(myInstantsPage(url)).toEqual(page));

  it.each([
    "https://www.myinstants.com.evil.example/en/instant/boing/", "https://evilmyinstants.com/en/instant/boing/", "https://www.myinstants.com:8443/en/instant/boing/",
    "https://user@www.myinstants.com/en/instant/boing/", "https://www.myinstants.com/en/search/?name=boing", "https://www.myinstants.com/en/instant/",
    "https://www.myinstants.com/a/b/instant/boing/", "ftp://www.myinstants.com/en/instant/boing/", "https://www.myinstants.com/en/instant/%zz/",
  ])("%s isn't one", (url) => expect(myInstantsPage(url)).toBeNull());

  it("finds the sound the page plays, only on the site and under /media/sounds/", () => {
    expect(parseInstantPage(MYINSTANTS_PAGE, PAGE)).toEqual({ title: "Boing & Spring", soundUrl: "https://www.myinstants.com/media/sounds/boing-spring.mp3" });
    expect(() => parseInstantPage(MYINSTANTS_PAGE_OFFSITE, PAGE)).toThrow(/doesn't name a sound file/);
  });

  it("lists a search page's instants once each, in order", () => {
    expect(parseSearchPage(MYINSTANTS_SEARCH, "https://www.myinstants.com/en/search/?name=b", 20).map((sound) => sound.slug)).toEqual(["boing-123", "vine-boom-456", "sad-trombone-789"]);
    expect(parseSearchPage(MYINSTANTS_SEARCH, "https://www.myinstants.com/en/search/?name=b", 1)).toHaveLength(1);
  });
});

describe("fetching MyInstants", () => {
  it("downloads the page's MP3, asking only MyInstants and never following a redirect for itself", async () => {
    const { fetch, deps } = site({
      [PAGE]: () => new Response(MYINSTANTS_PAGE),
      "https://www.myinstants.com/media/sounds/boing-spring.mp3": () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } }),
    });
    const path = temp();
    const sound = await fetchMyInstantsSound(PAGE, path, deps);
    expect(sound).toMatchObject({ slug: "boing-spring-123", title: "Boing & Spring", pageUrl: PAGE, bytes: MP3.byteLength });
    expect(readFileSync(path)).toEqual(MP3);
    expect(fetch.mock.calls.every(([, init]) => init.redirect === "manual")).toBe(true);
  });

  it("follows a redirect that stays on MyInstants, and refuses one that leaves", async () => {
    const stays = site({
      "https://www.myinstants.com/en/search/?name=boing": () => new Response(null, { status: 302, headers: { location: "/en/search/?name=boing&page=1" } }),
      "https://www.myinstants.com/en/search/?name=boing&page=1": () => new Response(MYINSTANTS_SEARCH),
    });
    expect(await searchMyInstants("boing", 2, stays.deps)).toHaveLength(2);

    const leaves = site({ "https://www.myinstants.com/en/search/?name=boing": () => new Response(null, { status: 301, headers: { location: "https://evil.example/" } }) });
    await expect(searchMyInstants("boing", 2, leaves.deps)).rejects.toThrow(/leads away from MyInstants/);
    expect(leaves.fetch).toHaveBeenCalledOnce();
  });

  it("refuses a private address before asking", async () => {
    const { fetch } = site({});
    const deps = { fetch, resolve: async () => [{ address: "10.0.0.5", family: 4 as const }], signal: new AbortController().signal };
    await expect(searchMyInstants("boing", 2, deps)).rejects.toThrow(/private network/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names a bot screen as one", async () => {
    const screen = site({ [PAGE]: () => new Response(BOT_SCREEN) });
    await expect(fetchMyInstantsSound(PAGE, temp(), screen.deps)).rejects.toThrow(/MyInstants refused the request \(it may be showing a bot check\)/);
    const forbidden = site({ [PAGE]: () => new Response("no", { status: 403 }) });
    await expect(fetchMyInstantsSound(PAGE, temp(), forbidden.deps)).rejects.toThrow(/bot check/);
  });

  it("refuses an oversized sound and a body that isn't one", async () => {
    const big = site({
      [PAGE]: () => new Response(MYINSTANTS_PAGE),
      "https://www.myinstants.com/media/sounds/boing-spring.mp3": () => new Response(MP3),
    });
    const path = temp();
    await expect(fetchMyInstantsSound(PAGE, path, { ...big.deps, cap: 1000 })).rejects.toThrow(/larger than/);

    const html = site({
      [PAGE]: () => new Response(MYINSTANTS_PAGE),
      "https://www.myinstants.com/media/sounds/boing-spring.mp3": () => new Response(BOT_SCREEN),
    });
    await expect(fetchMyInstantsSound(PAGE, temp(), html.deps)).rejects.toThrow(/something other than a sound file/);
  });

  it("gives up on a page that never answers, without waiting for the caller", async () => {
    // A fetch that answers only by failing once its signal stops it, as a stalled bot screen does.
    const fetch = vi.fn<PageFetch>((_url, init) => new Promise((_settle, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const deps = { fetch, resolve: PUBLIC, signal: new AbortController().signal, pageTimeoutMs: 20 };
    const search = await searchMyInstants("boing", 2, deps).catch((thrown: DapiError) => thrown);
    expect(search).toMatchObject({ code: "canceled" });
    expect((search as Error).message).toMatch(/^MyInstants took longer than \d+ seconds to answer/);
    await expect(fetchMyInstantsSound(PAGE, temp(), deps)).rejects.toThrow(/took longer than .* to answer/);

    // A body that stalls after the headers is stopped the same way.
    const stalled = vi.fn<PageFetch>(async () => new Response(new ReadableStream({ start: (stream) => stream.enqueue(new TextEncoder().encode("<html>")) })));
    await expect(searchMyInstants("boing", 2, { ...deps, fetch: stalled })).rejects.toThrow(/took longer than/);

    // The caller's own cancel still reads as a cancel.
    const caller = new AbortController();
    const pending = searchMyInstants("boing", 2, { fetch, resolve: PUBLIC, signal: caller.signal });
    caller.abort(new DapiError("canceled", "The search was canceled."));
    await expect(pending).rejects.toThrow("The search was canceled.");
  });

  it("says when a sound page is gone", async () => {
    const gone = site({});
    await expect(fetchMyInstantsSound(PAGE, temp(), gone.deps)).rejects.toThrow(/no such sound \(404\)/);
    expect(existsSync(join(root, "never"))).toBe(false);
  });
});
