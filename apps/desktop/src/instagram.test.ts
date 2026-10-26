import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstagramService, type InstagramSecureStorage } from "./instagram";

const TOKEN = "IGAA_VALID_TEST_TOKEN_1234567890";
const OTHER_TOKEN = "IGAA_OTHER_TEST_TOKEN_1234567890";
const PROFILE = { id: "100", user_id: "101", username: "creator.test", account_type: "MEDIA_CREATOR", followers_count: 125 };
const POST = { id: "201", caption: "A Reel", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://www.instagram.com/reel/example/", thumbnail_url: "https://scontent.cdninstagram.com/image.jpg", timestamp: "2026-10-01T12:00:00+0000", like_count: 0, comments_count: 4 };
const INSIGHTS = { data: [{ name: "views", values: [{ value: 0 }] }, { name: "reach", total_value: { value: 35 } }, { name: "shares", values: [{ value: 8 }] }, { name: "ig_reels_avg_watch_time", values: [{ value: 4321.5 }] }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let directory: string;
let time: Date;
let secure: InstagramSecureStorage;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cutroom-instagram-"));
  time = new Date("2026-10-21T12:00:00.000Z");
  secure = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${[...value].reverse().join("")}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice("encrypted:".length).split("").reverse().join("")),
  };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function api(handler?: (url: URL, options: Parameters<typeof fetch>[1]) => Response | Promise<Response> | undefined) {
  return vi.fn(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = new URL(String(input));
    const override = await handler?.(url, options);
    if (override) return override;
    if (url.pathname.endsWith("/me")) return json(PROFILE);
    if (url.pathname.endsWith("/media")) return json({ data: [POST] });
    if (url.pathname.endsWith("/insights")) return json(INSIGHTS);
    throw new Error(`Unexpected test request ${url.pathname}`);
  });
}
function service(request = api()) {
  return new InstagramService({ storageDirectory: directory, secureStorage: secure, fetch: request as typeof fetch, now: () => time });
}

describe("Instagram analytics service", () => {
  it('keeps publishing bound to the exact currently connected account and stops after disconnect', async () => {
    const request = api((url, options) => url.pathname.endsWith('/media') && options?.method === 'POST' ? json({ id: '301' }) : undefined);
    const instance = service(request);
    await instance.connect(TOKEN);
    const before = request.mock.calls.length;
    await expect(instance.publishingRequest('999', { kind: 'create', videoUrl: 'https://media.example.com/reel.mp4', caption: 'Reviewed', shareToFeed: false })).rejects.toThrow('same Instagram account');
    expect(request.mock.calls).toHaveLength(before);
    await expect(instance.publishingRequest('101', { kind: 'create', videoUrl: 'https://media.example.com/reel.mp4', caption: 'Reviewed', shareToFeed: false })).resolves.toEqual({ id: '301' });
    await instance.disconnect();
    const disconnected = request.mock.calls.length;
    await expect(instance.publishingRequest('101', { kind: 'status', containerId: '301' })).rejects.toThrow('same Instagram account');
    expect(request.mock.calls).toHaveLength(disconnected);
  });
  it("reads a professional account and preserves real zeroes, unavailable metrics, and watch time units", async () => {
    const request = api();
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("connected");
    expect(state.account).toEqual({ id: "101", username: "creator.test", accountType: "MEDIA_CREATOR", followers: 125 });
    expect(state.posts[0].metrics).toEqual({ views: 0, reach: 35, likes: 0, comments: 4, saves: null, shares: 8, averageWatchTimeMs: 4321.5 });
    expect(state.posts[0].history).toEqual([{ syncedAt: time.toISOString(), metrics: state.posts[0].metrics }]);
    expect(state.followerHistory).toEqual([{ syncedAt: time.toISOString(), followers: 125 }]);
    for (const [input, options] of request.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://graph.instagram.com");
      expect(url.pathname.startsWith("/v24.0/")).toBe(true);
      expect(String(input)).not.toContain(TOKEN);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(new URL(String(request.mock.calls[1][0])).searchParams.get("limit")).toBe("25");
  });

  it("never exports credentials, encrypts persisted tokens, and reloads only allowlisted cached fields", async () => {
    const instance = service();
    const state = await instance.connect(TOKEN);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(secure.encryptString).toHaveBeenCalledWith(TOKEN);
    for (const name of await readdir(directory)) expect(await readFile(join(directory, name), "utf8")).not.toContain(TOKEN);
    expect((await stat(join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
    const cached = JSON.parse(await readFile(join(directory, "analytics.json"), "utf8"));
    cached.dashboard.accessToken = TOKEN;
    cached.dashboard.account.token = TOKEN;
    cached.dashboard.posts[0].access_token = TOKEN;
    cached.dashboard.error = TOKEN;
    await writeFile(join(directory, "analytics.json"), JSON.stringify(cached));
    const request = api();
    const reloaded = await service(request).snapshot();
    expect(reloaded.posts).toEqual(state.posts);
    expect(JSON.stringify(reloaded)).not.toContain(TOKEN);
    expect(request).not.toHaveBeenCalled();
    reloaded.posts[0].metrics.views = 999;
    expect((await instance.snapshot()).posts[0].metrics.views).toBe(0);
  });

  it("falls back only for unsupported metrics and does not turn missing data into zero", async () => {
    const request = api(url => {
      if (!url.pathname.endsWith("/insights")) return;
      const metric = url.searchParams.get("metric")!;
      if (metric.includes(",") || metric === "saved") return json({ error: { code: 100, message: "Invalid metric: must be one of the supported metrics" } }, 400);
      if (metric === "views") return json({ data: [{ name: metric, values: [{ value: 0 }] }] });
      return json({ data: [] });
    });
    const state = await service(request).connect(TOKEN);
    expect(state.error).toBeNull();
    expect(state.posts[0].metrics.views).toBe(0);
    expect(state.posts[0].metrics.saves).toBeNull();
    expect(state.posts[0].metrics.reach).toBeNull();
    expect(request.mock.calls.filter(([url]) => String(url).includes("/insights"))).toHaveLength(6);
  });

  it("connects old and new posts when insights are unavailable for media posted before professional conversion", async () => {
    const newPost = { ...POST, id: "202", caption: "After conversion", timestamp: "2026-10-21T11:00:00+0000", like_count: 5 };
    const request = api(url => {
      if (url.pathname.endsWith("/media")) return json({ data: [POST, newPost] });
      if (url.pathname.endsWith("/201/insights")) return json({ error: { code: 100, error_subcode: 2108006, message: "Invalid parameter", error_user_title: "Media Posted Before Business Account Conversion" } }, 400);
    });
    const instance = service(request);
    const state = await instance.connect(TOKEN);
    expect(state.status).toBe("connected");
    expect(state.error).toBeNull();
    expect(state.account?.id).toBe("101");
    expect(state.posts).toHaveLength(2);
    expect(state.posts[0].metrics).toEqual({ views: null, reach: null, likes: 0, comments: 4, saves: null, shares: null, averageWatchTimeMs: null });
    expect(state.posts[0].history).toEqual([{ syncedAt: time.toISOString(), metrics: state.posts[0].metrics }]);
    expect(state.posts[1].metrics).toMatchObject({ views: 0, reach: 35, likes: 5, shares: 8, averageWatchTimeMs: 4321.5 });
    expect(request.mock.calls.filter(([url]) => String(url).includes("/insights"))).toHaveLength(2);
    expect(secure.encryptString).toHaveBeenCalledWith(TOKEN);
    expect((await service().snapshot()).posts).toEqual(state.posts);
  });

  it.each(["/me", "/media"])("does not treat a conversion subcode from %s as unavailable post insights", async endpoint => {
    const request = api(url => url.pathname.endsWith(endpoint) ? json({ error: { code: 100, error_subcode: 2108006, message: "Invalid parameter" } }, 400) : undefined);
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("disconnected");
    expect(state.account).toBeNull();
    expect(state.error).toContain("unexpected response");
    expect(state.error).toContain(endpoint === "/me" ? "profile" : "posts");
    expect(state.error).toContain("2108006");
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { code: 190, status: 400, text: "authorization" },
    { code: 10, status: 400, text: "denied" },
    { code: 4, status: 400, text: "limiting" },
    { code: 100, status: 401, text: "authorization" },
    { code: 100, status: 403, text: "denied" },
    { code: 100, status: 429, text: "limiting" },
  ])("keeps HTTP $status and API code $code fatal even with a conversion subcode", async ({ code, status, text }) => {
    const request = api(url => url.pathname.endsWith("/insights") ? json({ error: { code, error_subcode: 2108006, message: `Invalid parameter ${TOKEN}` } }, status) : undefined);
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("disconnected");
    expect(state.account).toBeNull();
    expect(state.error?.toLowerCase()).toContain(text);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/insights"))).toHaveLength(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("falls back when Instagram says its endpoint does not support the requested metrics", async () => {
    const request = api(url => {
      if (!url.pathname.endsWith("/insights")) return;
      const metric = url.searchParams.get("metric")!;
      if (metric.includes(",") || metric === "saved") return json({ error: { code: 100, message: `Instagram Insights Media API endpoint does not support the metrics: ${metric}.` } }, 400);
      return json({ data: [{ name: metric, values: [{ value: metric === "views" ? 0 : 12 }] }] });
    });
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("connected");
    expect(state.error).toBeNull();
    expect(state.posts[0].metrics).toMatchObject({ views: 0, reach: 12, saves: null, shares: 12, averageWatchTimeMs: 12 });
    expect(request.mock.calls.filter(([url]) => String(url).includes("/insights"))).toHaveLength(6);
  });

  it.each([
    { endpoint: "/me", stage: "profile" },
    { endpoint: "/media", stage: "posts" },
    { endpoint: "/insights", stage: "post insights" },
  ])("reports safe numeric diagnostics for an unknown $stage API error", async ({ endpoint, stage }) => {
    const privateId = "98765432109876543210";
    const privateTrace = "private_trace_do_not_export";
    const privateUrl = `https://private.example/${privateId}?access_token=${TOKEN}`;
    const request = api(url => url.pathname.endsWith(endpoint) ? json({ error: { code: 100, error_subcode: 7654321, message: `Unexpected payload at ${privateUrl}`, error_user_title: TOKEN, error_user_msg: privateId, fbtrace_id: privateTrace } }, 400) : undefined);
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("disconnected");
    expect(state.error).toContain("unexpected response");
    expect(state.error).toContain(stage);
    expect(state.error).toContain("400");
    expect(state.error).toContain("100");
    expect(state.error).toContain("7654321");
    for (const secret of [TOKEN, privateId, privateTrace, privateUrl, "Unexpected payload at"]) expect(JSON.stringify(state)).not.toContain(secret);
    expect(await readdir(directory)).toEqual([]);
  });

  it("never exposes non-numeric API codes or treats them as authentication or conversion codes", async () => {
    const request = api(url => url.pathname.endsWith("/insights") ? json({ error: { code: `190 ${TOKEN}`, error_subcode: `2108006 ${OTHER_TOKEN}`, message: `Unexpected failure ${TOKEN}` } }, 400) : undefined);
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("disconnected");
    expect(state.error).toContain("unexpected response");
    expect(state.error).toContain("post insights");
    expect(state.error).toContain("HTTP 400");
    expect(state.error).not.toMatch(/\bcode |\bsubcode /);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(JSON.stringify(state)).not.toContain(OTHER_TOKEN);
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not swallow a conversion subcode when the API error describes missing permission", async () => {
    const request = api(url => url.pathname.endsWith("/insights") ? json({ error: { code: 100, error_subcode: 2108006, message: "Access denied: missing insights permission" } }, 400) : undefined);
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("disconnected");
    expect(state.error).not.toBeNull();
    expect(state.account).toBeNull();
    expect(request.mock.calls.filter(([url]) => String(url).includes("/insights"))).toHaveLength(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("only reassures the user about previously synced stats when a successful sync exists", async () => {
    let broken = true;
    const request = api(url => broken && url.pathname.endsWith("/insights") ? json({ error: { code: 100, message: "Unexpected API failure" } }, 400) : undefined);
    const instance = service(request);
    const first = await instance.connect(TOKEN);
    expect(first.error).toContain("unexpected response");
    expect(first.error).not.toMatch(/previously synced stats/i);
    expect(first.lastSyncedAt).toBeNull();
    broken = false;
    const before = await instance.connect(TOKEN);
    broken = true;
    const after = await instance.sync();
    expect(after.error).toMatch(/previously synced stats/i);
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt);
    expect(after.posts).toEqual(before.posts);
  });

  it.each(["Business", "Media_Creator"])("normalizes the professional profile account type %s", async accountType => {
    const state = await service(api(url => url.pathname.endsWith("/me") ? json({ ...PROFILE, account_type: accountType }) : undefined)).connect(TOKEN);
    expect(state.status).toBe("connected");
    expect(state.account?.accountType).toBe(accountType.toUpperCase());
    expect(state.error).toBeNull();
  });

  it.each([
    { code: 190, status: 400, expected: "reconnect_required", text: "authorization" },
    { code: 10, status: 403, expected: "connected", text: "denied" },
    { code: 4, status: 429, expected: "connected", text: "limiting" },
    { code: 100, status: 400, expected: "connected", text: "unexpected" },
  ])("retains cached stats on API error $code without unsupported-metric retries", async ({ code, status, expected, text }) => {
    let broken = false;
    const request = api(url => broken && url.pathname.endsWith("/insights") ? json({ error: { code, message: `Missing permissions for metric. Secret ${TOKEN}` } }, status) : undefined);
    const instance = service(request);
    const before = await instance.connect(TOKEN);
    broken = true;
    time = new Date("2026-10-22T12:00:00.000Z");
    const after = await instance.sync();
    expect(after.status).toBe(expected);
    expect(after.error?.toLowerCase()).toContain(text);
    expect(JSON.stringify(after)).not.toContain(TOKEN);
    expect(after.posts).toEqual(before.posts);
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/insights"))).toHaveLength(2);
  });

  it("retains cache when the network fails and sanitizes exceptions", async () => {
    let broken = false;
    const request = api(() => { if (broken) throw new Error(`fetch failed for access_token=${TOKEN}`); return undefined; });
    const instance = service(request);
    const before = await instance.connect(TOKEN);
    broken = true;
    const after = await instance.sync();
    expect(after.posts).toEqual(before.posts);
    expect(after.error).toContain("Could not reach Instagram");
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });

  it("classifies HTTP authentication failures even when Instagram returns a non-JSON body", async () => {
    let broken = false;
    const request = api(() => broken ? new Response("Unauthorized", { status: 401 }) : undefined);
    const instance = service(request);
    const before = await instance.connect(TOKEN);
    broken = true;
    const after = await instance.sync();
    expect(after.status).toBe("reconnect_required");
    expect(after.posts).toEqual(before.posts);
  });

  it("does not hide a permission failure encountered during individual metric fallback", async () => {
    let broken = false;
    const request = api(url => {
      if (!broken || !url.pathname.endsWith("/insights")) return;
      const metric = url.searchParams.get("metric")!;
      if (metric.includes(",")) return json({ error: { code: 100, message: "Unsupported metric" } }, 400);
      return json({ error: { code: 10, message: `Missing insights permission ${TOKEN}` } }, 400);
    });
    const instance = service(request);
    const before = await instance.connect(TOKEN);
    broken = true;
    const after = await instance.sync();
    expect(after.error).toContain("denied");
    expect(after.posts).toEqual(before.posts);
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });

  it("rejects an invalid replacement token without losing the existing connection", async () => {
    const request = api((_url, options) => objectHeaders(options).Authorization === `Bearer ${OTHER_TOKEN}` ? json({ error: { code: 190, message: OTHER_TOKEN } }, 400) : undefined);
    const instance = service(request);
    const before = await instance.connect(TOKEN);
    const after = await instance.connect(OTHER_TOKEN);
    expect(after.status).toBe("connected");
    expect(after.account).toEqual(before.account);
    expect(after.posts).toEqual(before.posts);
    expect(after.error).toContain("authorization");
    expect((await instance.sync()).error).toBeNull();
    expect(objectHeaders(request.mock.calls.at(-1)?.[1]).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("does not mix observed history when connecting another account", async () => {
    const request = api((url, options) => {
      if (objectHeaders(options).Authorization === `Bearer ${OTHER_TOKEN}` && url.pathname.endsWith("/me")) return json({ ...PROFILE, user_id: "102", username: "second.creator", followers_count: 500 });
    });
    const instance = service(request);
    await instance.connect(TOKEN);
    time = new Date("2026-10-22T12:00:00.000Z");
    expect((await instance.sync()).posts[0].history).toHaveLength(2);
    time = new Date("2026-10-23T12:00:00.000Z");
    const other = await instance.connect(OTHER_TOKEN);
    expect(other.account?.id).toBe("102");
    expect(other.followerHistory).toEqual([{ syncedAt: time.toISOString(), followers: 500 }]);
    expect(other.posts[0].history).toHaveLength(1);
  });

  it("replaces a day's observation and bounds retained history to 90 days", async () => {
    const instance = service();
    await instance.connect(TOKEN);
    time = new Date("2026-10-21T23:59:00.000Z");
    const sameDay = await instance.sync();
    expect(sameDay.posts[0].history).toHaveLength(1);
    expect(sameDay.posts[0].history[0].syncedAt).toBe(time.toISOString());
    for (let day = 1; day <= 92; day++) {
      time = new Date(Date.UTC(2026, 9, 21 + day, 23, 59));
      await instance.sync();
    }
    const current = await instance.snapshot();
    expect(current.posts[0].history).toHaveLength(90);
    expect(current.followerHistory).toHaveLength(90);
  });

  it.each(["unavailable", "basic_text"])("fails closed when secure storage is %s", async backend => {
    if (backend === "unavailable") secure.isEncryptionAvailable = () => false;
    else secure.getSelectedStorageBackend = () => "basic_text";
    const request = api();
    const state = await service(request).connect(TOKEN);
    expect(state.status).toBe("unavailable");
    expect(state.error).toContain("Secure credential storage");
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves cached data when keychain decryption fails and allows retry after unlock", async () => {
    const before = await service().connect(TOKEN);
    const decrypt = secure.decryptString;
    secure.decryptString = () => { throw new Error(TOKEN); };
    const instance = service();
    const unavailable = await instance.snapshot();
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.posts).toEqual(before.posts);
    expect(JSON.stringify(unavailable)).not.toContain(TOKEN);
    secure.decryptString = decrypt;
    expect((await instance.sync()).status).toBe("connected");
  });

  it("rejects personal accounts without persisting credentials", async () => {
    const state = await service(api(url => url.pathname.endsWith("/me") ? json({ ...PROFILE, account_type: "PERSONAL" }) : undefined)).connect(TOKEN);
    expect(state.status).toBe("disconnected");
    expect(state.error).toContain("Creator or Business");
    expect(await readdir(directory)).toEqual([]);
  });

  it("never follows response pagination URLs or exposes unsafe media URLs", async () => {
    const request = api(url => url.pathname.endsWith("/media") ? json({ data: [{ ...POST, permalink: "https://evil.example/post", thumbnail_url: `https://cdninstagram.com/image?access_token=${TOKEN}` }], paging: { next: `https://evil.example/steal?access_token=${TOKEN}`, cursors: { after: "cursor" } } }) : undefined);
    const state = await service(request).connect(TOKEN);
    expect(state.coverage).toEqual({ fetchedPosts: 1, limit: 25, hasMore: true });
    expect(state.posts[0].permalink).toBeNull();
    expect(state.posts[0].thumbnailUrl).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });

  it("serializes connect, sync, and disconnect and clears cached data and credentials", async () => {
    const instance = service();
    const [connected, synced, disconnected] = await Promise.all([instance.connect(TOKEN), instance.sync(), instance.disconnect()]);
    expect(connected.status).toBe("connected");
    expect(synced.status).toBe("connected");
    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.posts).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
    expect((await service().snapshot()).status).toBe("disconnected");
  });

  it("discards malformed caches while keeping an encrypted connection available to refresh", async () => {
    await service().connect(TOKEN);
    const cache = JSON.parse(await readFile(join(directory, "analytics.json"), "utf8"));
    cache.dashboard.posts[0].metrics.views = "0";
    await writeFile(join(directory, "analytics.json"), JSON.stringify(cache));
    const instance = service();
    const state = await instance.snapshot();
    expect(state.posts).toEqual([]);
    expect(state.error).toContain("Stored analytics");
    expect((await instance.sync()).posts).toHaveLength(1);
  });
});

function objectHeaders(options: Parameters<typeof fetch>[1]): Record<string, string> {
  return options?.headers as Record<string, string> ?? {};
}
