import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { requestInstagramPublishing } from './instagram-publishing-api';
import type { InstagramPublishOperation, InstagramPublishResponse } from './instagram-publishing-types';

import { INSTAGRAM_METRICS, type InstagramAccount, type InstagramDashboard, type InstagramFreshPost, type InstagramMetrics, type InstagramPost } from "./instagram-types";
import { sameInstagramLink } from "./platform-url";

const API_VERSION = "v24.0";
const POST_LIMIT = 25;
const HISTORY_DAYS = 90;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
/** What a post's file is asked of Instagram with: no metrics, so one request answers for one post. */
const FILE_FIELDS = "id,caption,media_type,media_product_type,permalink,media_url";
/** A post the cache doesn't know is looked for in this many pages of the account's recent posts (300), and for no longer than FIND_BUDGET_MS. */
const FIND_PAGES = 3;
const FIND_BUDGET_MS = 15_000;
const FIND_PAGE_SIZE = "100";

export interface InstagramSecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface InstagramServiceOptions {
  storageDirectory: string;
  secureStorage: InstagramSecureStorage;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

type ErrorKind = "auth" | "permission" | "rate" | "unsupported" | "media_unavailable" | "network" | "response" | "storage" | "account";
type RequestStage = "profile" | "posts" | "post insights";
interface ErrorContext { stage: RequestStage; status?: number; code?: number | null; subcode?: number | null }

function errorCode(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

class InstagramError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string, context?: ErrorContext) {
    // Only fixed stage labels and numeric codes cross IPC. API text can echo credentials.
    const details = context ? [context.stage,
      ...(context.status === undefined ? [] : [`HTTP ${context.status}`]),
      ...(context.code == null ? [] : [`code ${context.code}`]),
      ...(context.subcode == null ? [] : [`subcode ${context.subcode}`]),
    ] : [];
    super(`${message}${details.length ? ` Details: ${details.join(", ")}.` : ""}`);
    this.kind = kind;
  }
}

const messages = {
  auth: "Instagram authorization has expired or is invalid. Reconnect with a new access token.",
  permission: "Instagram denied access to insights. Check that your token has the basic and insights permissions.",
  rate: "Instagram is limiting requests. Wait a while, then sync again.",
  unsupported: "This metric is unavailable for this Instagram post.",
  media_unavailable: "Insights are unavailable for this post from before the account became a Creator or Business account.",
  network: "Could not reach Instagram.",
  response: "Instagram returned an unexpected response.",
  storage: "Secure credential storage is unavailable. Unlock your system keychain and try again.",
  account: "Instagram analytics requires a Creator or Business account using an Instagram Login access token.",
} satisfies Record<ErrorKind, string>;

/**
 * What a failed request for one post's file comes to, in a sentence for the
 * person or agent that asked. The API's own text is never passed on (it can
 * echo credentials); the fixed stage and numeric codes are.
 */
function fileFailure(error: unknown): string {
  const kind: ErrorKind = error instanceof InstagramError ? error.kind : "response";
  const details = error instanceof InstagramError ? / Details: .*$/.exec(error.message)?.[0] ?? "" : "";
  switch (kind) {
    case "auth": return `Instagram authorization has expired or is invalid. Reconnect your account in Analytics, then try again.${details}`;
    case "permission": return `Instagram denied access to this post. Check that the access token has the basic permission, then try again.${details}`;
    case "rate": return `Instagram is limiting requests. Wait a while, then try again.${details}`;
    case "network": return "Couldn't reach Instagram. Check the internet connection, then try again.";
    case "storage": return messages.storage;
    default: return `Instagram returned an unexpected response. Try once more in a moment.${details}`;
  }
}

function emptyDashboard(): InstagramDashboard {
  return { status: "disconnected", account: null, lastSyncedAt: null, error: null, posts: [], followerHistory: [], coverage: { fetchedPosts: 0, limit: POST_LIMIT, hasMore: false } };
}
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,40}$/.test(value) ? value : null;
}
function date(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function blankMetrics(): InstagramMetrics {
  return { views: null, reach: null, likes: null, comments: null, saves: null, shares: null, averageWatchTimeMs: null };
}
function metrics(value: unknown): InstagramMetrics | null {
  const row = object(value);
  if (!row || INSTAGRAM_METRICS.some(key => row[key] !== null && numberOrNull(row[key]) === null)) return null;
  return Object.fromEntries(INSTAGRAM_METRICS.map(key => [key, row[key]])) as InstagramMetrics;
}
function safeUrl(value: unknown, thumbnail = false): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    const hosts = thumbnail ? ["instagram.com", "cdninstagram.com", "fbcdn.net"] : ["instagram.com"];
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.searchParams.has("access_token")) return null;
    return hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null;
  } catch { return null; }
}

/** Strict allowlisting also prevents accidentally returning token fields from a stored/API payload. */
function account(value: unknown): InstagramAccount | null {
  const row = object(value);
  const id = identifier(row?.id);
  if (!row || !id || typeof row.username !== "string" || !/^[A-Za-z0-9._]{1,100}$/.test(row.username)) return null;
  if (!["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(String(row.accountType))) return null;
  if (row.followers !== null && numberOrNull(row.followers) === null) return null;
  return { id, username: row.username, accountType: row.accountType as string, followers: numberOrNull(row.followers) };
}

function cachedDashboard(value: unknown): InstagramDashboard | null {
  const envelope = object(value);
  const row = object(envelope?.dashboard);
  if (envelope?.version !== 1 || !row) return null;
  const owner = account(row.account);
  const synced = date(row.lastSyncedAt);
  if (!owner || !synced || !Array.isArray(row.posts) || row.posts.length > POST_LIMIT || !Array.isArray(row.followerHistory) || row.followerHistory.length > HISTORY_DAYS) return null;
  const posts: InstagramPost[] = [];
  for (const candidate of row.posts) {
    const post = object(candidate);
    const id = identifier(post?.id), publishedAt = date(post?.publishedAt), syncedAt = date(post?.syncedAt), values = metrics(post?.metrics);
    if (!post || !id || !publishedAt || !syncedAt || !values || typeof post.caption !== "string" || post.caption.length > 10_000 || typeof post.mediaType !== "string" || post.mediaType.length > 30 || typeof post.mediaProductType !== "string" || post.mediaProductType.length > 30 || !Array.isArray(post.history) || post.history.length > HISTORY_DAYS) return null;
    const history: InstagramPost["history"] = [];
    for (const sample of post.history) {
      const item = object(sample), at = date(item?.syncedAt), values = metrics(item?.metrics);
      if (!at || !values) return null;
      history.push({ syncedAt: at, metrics: values });
    }
    posts.push({ id, caption: post.caption, mediaType: post.mediaType, mediaProductType: post.mediaProductType, permalink: safeUrl(post.permalink), thumbnailUrl: safeUrl(post.thumbnailUrl, true), mediaUrl: safeUrl(post.mediaUrl, true), publishedAt, syncedAt, metrics: values, history });
  }
  if (new Set(posts.map(post => post.id)).size !== posts.length) return null;
  const followerHistory: InstagramDashboard["followerHistory"] = [];
  for (const candidate of row.followerHistory) {
    const sample = object(candidate), at = date(sample?.syncedAt), followers = numberOrNull(sample?.followers);
    if (!at || followers === null) return null;
    followerHistory.push({ syncedAt: at, followers });
  }
  const coverage = object(row.coverage);
  if (coverage?.fetchedPosts !== posts.length || coverage.limit !== POST_LIMIT || typeof coverage.hasMore !== "boolean") return null;
  // Errors are intentionally not loaded from disk; they are recomputed for this session.
  return { status: "connected", account: owner, posts, followerHistory, lastSyncedAt: synced, error: null, coverage: { fetchedPosts: posts.length, limit: POST_LIMIT, hasMore: coverage.hasMore } };
}

/** One actual reading per UTC day, bounded to the most recent 90 days. */
function appendHistory<T extends { syncedAt: string }>(history: T[], sample: T): T[] {
  const earliest = Date.parse(sample.syncedAt) - (HISTORY_DAYS - 1) * 86_400_000;
  const day = sample.syncedAt.slice(0, 10);
  const days = new Map(history.filter(item => Date.parse(item.syncedAt) >= earliest && item.syncedAt.slice(0, 10) !== day).map(item => [item.syncedAt.slice(0, 10), item]));
  days.set(day, sample);
  return [...days.values()].sort((a, b) => a.syncedAt.localeCompare(b.syncedAt)).slice(-HISTORY_DAYS);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export class InstagramService {
  private readonly options: InstagramServiceOptions;
  private readonly request: typeof globalThis.fetch;
  private readonly now: () => Date;
  private current = emptyDashboard();
  private token: string | null = null;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: InstagramServiceOptions) {
    this.options = options;
    this.request = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action);
    this.queue = run.catch(() => {});
    return run;
  }
  private path(name: string): string { return join(this.options.storageDirectory, name); }
  private copy(): InstagramDashboard { return structuredClone(this.current); }
  private secure(): void {
    if (!this.options.secureStorage.isEncryptionAvailable() || this.options.secureStorage.getSelectedStorageBackend?.() === "basic_text") throw new InstagramError("storage", messages.storage);
  }
  private fail(error: unknown, reconnect = false): InstagramDashboard {
    const known = error instanceof InstagramError ? error : new InstagramError("storage", "Could not save Instagram settings. Check the app's local storage and try again.");
    const cached = this.current.lastSyncedAt && ["network", "response"].includes(known.kind) ? " Your previously synced stats are still available." : "";
    this.current = { ...this.current, error: known.message + cached, status: known.kind === "storage" ? "unavailable" : reconnect && known.kind === "auth" ? "reconnect_required" : this.current.status };
    return this.copy();
  }

  private async read(name: string, maxBytes: number): Promise<unknown> {
    const path = this.path(name);
    if ((await stat(path)).size > maxBytes) throw new Error("Invalid stored data");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let cached: InstagramDashboard | null = null;
    try { cached = cachedDashboard(await this.read("analytics.json", MAX_CACHE_BYTES)); } catch { /* Missing or corrupt caches never become API data. */ }
    let stored: Record<string, unknown> | null;
    try { stored = object(await this.read("credentials.json", 64 * 1024)); }
    catch (error) {
      if (object(error)?.code !== "ENOENT") this.current = { ...emptyDashboard(), error: "Stored Instagram credentials could not be read. Reconnect your account." };
      return;
    }
    const id = identifier(stored?.accountId);
    if (!stored || stored.version !== 1 || !id || typeof stored.encryptedToken !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(stored.encryptedToken)) {
      this.current = { ...emptyDashboard(), error: "Stored Instagram credentials could not be read. Reconnect your account." };
      return;
    }
    if (cached?.account?.id === id) this.current = cached;
    try {
      this.secure();
      const token = this.options.secureStorage.decryptString(Buffer.from(stored.encryptedToken, "base64"));
      if (!this.validToken(token)) throw new InstagramError("storage", messages.storage);
      this.token = token;
      this.current.status = "connected";
      if (!this.current.account) this.current.error = "Stored analytics are unavailable. Sync to fetch your account and stats.";
    } catch { this.current = { ...this.current, status: "unavailable", error: messages.storage }; }
  }

  private validToken(token: string): boolean { return /^[A-Za-z0-9._~-]{20,8192}$/.test(token); }

  snapshot(): Promise<InstagramDashboard> {
    return this.serialized(async () => { await this.load(); return this.copy(); });
  }

  /** Narrow private-token boundary for the separately approved publishing queue. */
  publishingRequest(accountId: string, operation: InstagramPublishOperation): Promise<InstagramPublishResponse> {
    return this.serialized(async () => {
      await this.load();
      this.secure();
      if (!this.token || this.current.status !== 'connected' || this.current.account?.id !== accountId) {
        throw new Error('Connect the same Instagram account that approved this queue item before publishing.');
      }
      return requestInstagramPublishing(this.request, this.token, accountId, operation);
    });
  }

  connect(accessToken: string): Promise<InstagramDashboard> {
    return this.serialized(async () => {
      await this.load();
      const token = typeof accessToken === "string" ? accessToken.trim() : "";
      if (!this.validToken(token)) return this.fail(new InstagramError("auth", "Enter a valid Instagram Login access token. Do not enter your Instagram password."));
      try {
        this.secure();
        const next = await this.collect(token);
        const encryptedToken = this.options.secureStorage.encryptString(token).toString("base64");
        await mkdir(this.options.storageDirectory, { recursive: true, mode: 0o700 });
        // Account IDs bind the separate files: interrupted writes cannot mix accounts on restart.
        await atomicWrite(this.path("credentials.json"), { version: 1, accountId: next.account!.id, encryptedToken });
        this.token = token;
        this.current = next;
        await atomicWrite(this.path("analytics.json"), { version: 1, dashboard: next });
        return this.copy();
      } catch (error) { return this.fail(error); }
    });
  }

  sync(): Promise<InstagramDashboard> {
    return this.serialized(async () => {
      await this.load();
      if (!this.token && this.current.status === "unavailable") { this.loaded = false; await this.load(); }
      if (!this.token) return this.copy();
      try {
        this.secure();
        const next = await this.collect(this.token);
        await atomicWrite(this.path("analytics.json"), { version: 1, dashboard: next });
        this.current = next;
        return this.copy();
      } catch (error) { return this.fail(error, true); }
    });
  }

  /**
   * One of the connected account's posts a link names (a permalink in any of
   * its forms, or one of its file links), as Instagram describes it now. The
   * file link a cached post holds is only as new as the last sync, predates
   * links being kept, or has expired; the analytics tools only read that
   * cache. A post the cache knows is asked for by its id, one request; any
   * other is looked for in the account's recent posts. Nothing is written:
   * the cache stays as the last sync left it.
   */
  freshPost(link: string, signal?: AbortSignal): Promise<InstagramFreshPost> {
    return this.serialized(async (): Promise<InstagramFreshPost> => {
      await this.load();
      const token = this.token;
      // No token: either no account is connected, or the stored credentials couldn't be read, and then the reason is already known.
      if (!token) return this.current.error ? { kind: "failed", reason: this.current.error } : { kind: "none" };
      try {
        this.secure();
        const budget = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(FIND_BUDGET_MS)]);
        const names = (row: Record<string, unknown>) => [row.permalink, row.media_url].some(value => typeof value === "string" && sameInstagramLink(value, link));
        const known = this.current.posts.find(post => [post.permalink, post.mediaUrl].some(value => !!value && sameInstagramLink(value, link)));
        let username = this.current.account?.username ?? null;
        let row: Record<string, unknown> | null = null;
        if (known) {
          row = await this.get(token, known.id, { fields: FILE_FIELDS }, budget);
        } else {
          let ownerId = this.current.account?.id ?? null;
          if (!ownerId) {
            const profile = await this.get(token, "me", { fields: "id,user_id,username" }, budget);
            ownerId = identifier(profile.user_id) ?? identifier(profile.id);
            if (!ownerId) throw new InstagramError("response", messages.response, { stage: "profile" });
            if (typeof profile.username === "string" && /^[A-Za-z0-9._]{1,100}$/.test(profile.username)) username = profile.username;
          }
          let after: string | null = null;
          for (let page = 0; page < FIND_PAGES && !row; page++) {
            const response = await this.get(token, `${ownerId}/media`, { fields: FILE_FIELDS, limit: FIND_PAGE_SIZE, ...(after ? { after } : {}) }, budget);
            if (!Array.isArray(response.data)) throw new InstagramError("response", messages.response, { stage: "posts" });
            row = response.data.map(object).find((candidate): candidate is Record<string, unknown> => !!candidate && names(candidate)) ?? null;
            const paging = object(response.paging);
            const cursor = object(paging?.cursors)?.after;
            after = typeof paging?.next === "string" && typeof cursor === "string" && cursor ? cursor : null;
            if (!after) break;
          }
        }
        if (!row) return { kind: "none" };
        const id = identifier(row.id);
        if (!id || typeof row.media_type !== "string") throw new InstagramError("response", messages.response, { stage: "posts" });
        return {
          kind: "post",
          post: {
            id,
            permalink: safeUrl(row.permalink),
            caption: typeof row.caption === "string" ? row.caption.slice(0, 10_000) : "",
            mediaType: row.media_type.slice(0, 30),
            mediaUrl: safeUrl(row.media_url, true),
            username,
          },
        };
      } catch (error) {
        return { kind: "failed", reason: fileFailure(error) };
      }
    });
  }

  disconnect(): Promise<InstagramDashboard> {
    return this.serialized(async () => {
      await this.load();
      try {
        // Remove credentials first; stale cache alone cannot resurrect a connection.
        await rm(this.path("credentials.json"), { force: true });
        this.token = null;
        this.current = emptyDashboard();
        await rm(this.path("analytics.json"), { force: true });
        return this.copy();
      } catch { return this.fail(new InstagramError("storage", "Could not remove all local Instagram data. Try disconnecting again.")); }
    });
  }

  private async get(token: string, path: string, params: Record<string, string> = {}, syncSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const stage: RequestStage = path === "me" ? "profile" : path.endsWith("/insights") ? "post insights" : "posts";
    const url = new URL(`https://graph.instagram.com/${API_VERSION}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    let payload: Record<string, unknown> | null = null;
    try {
      syncSignal?.throwIfAborted();
      response = await this.request(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: syncSignal ? AbortSignal.any([syncSignal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    } catch { throw new InstagramError("network", messages.network, { stage }); }
    try { payload = object(await response.json()); } catch { /* HTTP auth/rate errors still retain their meaning without a JSON body. */ }
    const error = object(payload?.error);
    if (!response.ok || error) {
      const code = errorCode(error?.code);
      const subcode = errorCode(error?.error_subcode);
      const message = typeof error?.message === "string" ? error.message : "";
      let kind: ErrorKind = "response";
      if (response.status === 401 || code === 190 || code === 102) kind = "auth";
      else if (response.status === 403 || code === 10 || code === 200) kind = "permission";
      else if (response.status === 429 || [4, 17, 32, 613, 80000, 80001].includes(code ?? -1)) kind = "rate";
      else if (stage === "post insights" && code === 100 && !/permission|denied|privilege|access token/i.test(message)) {
        // Older posts may have no API insights after a Personal → professional conversion.
        // This specific per-media failure must not prevent connecting the account.
        if (subcode === 2108006) kind = "media_unavailable";
        else if (/metrics?/i.test(message) && /unsupported|not supported|does not support|invalid|must be one|not available/i.test(message)) kind = "unsupported";
      }
      throw new InstagramError(kind, messages[kind], { stage, status: response.status, code, subcode });
    }
    if (!payload) throw new InstagramError("response", messages.response, { stage, status: response.status });
    return payload;
  }

  private async collect(token: string): Promise<InstagramDashboard> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
    try { return await this.collectData(token, signal); }
    finally { controller.abort(); }
  }

  private async collectData(token: string, signal: AbortSignal): Promise<InstagramDashboard> {
    const profile = await this.get(token, "me", { fields: "id,user_id,username,account_type,followers_count" }, signal);
    const owner = account({ id: identifier(profile.user_id) ?? profile.id, username: profile.username, accountType: typeof profile.account_type === "string" ? profile.account_type.toUpperCase() : profile.account_type, followers: numberOrNull(profile.followers_count) });
    if (!owner) throw new InstagramError("account", messages.account);
    const sameAccount = owner.id === this.current.account?.id;
    const syncedAt = this.now().toISOString();
    const response = await this.get(token, `${owner.id}/media`, { fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count", limit: String(POST_LIMIT) }, signal);
    if (!Array.isArray(response.data) || response.data.length > POST_LIMIT) throw new InstagramError("response", messages.response, { stage: "posts" });
    const oldPosts = new Map(sameAccount ? this.current.posts.map(post => [post.id, post]) : []);
    const parsePost = async (value: unknown): Promise<InstagramPost> => {
      const row = object(value), id = identifier(row?.id), publishedAt = date(row?.timestamp);
      if (!row || !id || !publishedAt || typeof row.media_type !== "string") throw new InstagramError("response", messages.response, { stage: "posts" });
      const values = blankMetrics();
      values.likes = numberOrNull(row.like_count);
      values.comments = numberOrNull(row.comments_count);
      const insight = await this.insights(token, id, row.media_product_type === "REELS", signal);
      values.views = insight.views;
      values.reach = insight.reach;
      values.saves = insight.saved;
      values.shares = insight.shares;
      values.averageWatchTimeMs = insight.ig_reels_avg_watch_time;
      return { id, caption: typeof row.caption === "string" ? row.caption.slice(0, 10_000) : "", mediaType: row.media_type.slice(0, 30), mediaProductType: typeof row.media_product_type === "string" ? row.media_product_type.slice(0, 30) : "", permalink: safeUrl(row.permalink), thumbnailUrl: safeUrl(row.thumbnail_url ?? (row.media_type === "IMAGE" ? row.media_url : null), true), mediaUrl: safeUrl(row.media_url, true), publishedAt, syncedAt, metrics: values, history: appendHistory(oldPosts.get(id)?.history ?? [], { syncedAt, metrics: values }) };
    };
    const posts: InstagramPost[] = [];
    // Bound load on the API while avoiding 25 serial round trips. The whole sync has a 45 s budget.
    for (let start = 0; start < response.data.length; start += 3) {
      posts.push(...await Promise.all(response.data.slice(start, start + 3).map(parsePost)));
    }
    if (new Set(posts.map(post => post.id)).size !== posts.length) throw new InstagramError("response", messages.response, { stage: "posts" });
    const paging = object(response.paging);
    const hasMore = typeof paging?.next === "string" && paging.next.length > 0;
    return { status: "connected", account: owner, lastSyncedAt: syncedAt, error: null, posts, followerHistory: owner.followers === null ? sameAccount ? this.current.followerHistory : [] : appendHistory(sameAccount ? this.current.followerHistory : [], { syncedAt, followers: owner.followers }), coverage: { fetchedPosts: posts.length, limit: POST_LIMIT, hasMore } };
  }

  private async insights(token: string, id: string, reels: boolean, signal: AbortSignal): Promise<Record<string, number | null>> {
    const names = ["views", "reach", "saved", "shares", ...(reels ? ["ig_reels_avg_watch_time"] : [])];
    const values: Record<string, number | null> = { views: null, reach: null, saved: null, shares: null, ig_reels_avg_watch_time: null };
    const parse = (payload: Record<string, unknown>) => {
      if (!Array.isArray(payload.data)) throw new InstagramError("response", messages.response, { stage: "post insights" });
      for (const item of payload.data) {
        const row = object(item);
        if (!row || typeof row.name !== "string" || !names.includes(row.name)) continue;
        const first = Array.isArray(row.values) ? object(row.values[0]) : null;
        values[row.name] = numberOrNull(object(row.total_value)?.value ?? first?.value);
      }
    };
    try { parse(await this.get(token, `${id}/insights`, { metric: names.join(",") }, signal)); }
    catch (error) {
      if (error instanceof InstagramError && error.kind === "media_unavailable") return values;
      if (!(error instanceof InstagramError) || error.kind !== "unsupported") throw error;
      for (const metric of names) {
        try { parse(await this.get(token, `${id}/insights`, { metric }, signal)); }
        catch (error) {
          if (error instanceof InstagramError && error.kind === "media_unavailable") return values;
          if (!(error instanceof InstagramError) || error.kind !== "unsupported") throw error;
        }
      }
    }
    return values;
  }
}

let singleton: InstagramService | undefined;
/** Electron is loaded only when requested, keeping import-time tests independent of the desktop runtime. */
export function instagramService(): InstagramService {
  if (!singleton) {
    const { app, safeStorage } = createRequire(join(process.resourcesPath, "package.json"))("electron") as typeof import("electron");
    singleton = new InstagramService({ storageDirectory: join(app.getPath("userData"), "instagram"), secureStorage: safeStorage });
  }
  return singleton;
}
