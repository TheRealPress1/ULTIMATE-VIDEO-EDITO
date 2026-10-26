import { useNavigate } from "@solidjs/router";
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import type { InstagramDashboard, InstagramMetric, InstagramPost } from "@desktop/instagram-types";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { mainBridge } from "@/lib/ipc";
import {
  filterPublishedPosts, instagramPermalink, metricValue, observedMetricTrend, postMetricPoints, sortPosts, summarizeMetric,
  type PostSort,
} from "./analytics-data";
import { AnalyticsChange, AnalyticsSparkline } from "./analytics-charts";
import { PublishingActivity } from "./analytics-activity";
import { InstagramComparison } from './instagram-comparison';
import "./analytics.css";

const SUMMARY_METRICS = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "saves", label: "Saves" },
  { key: "shares", label: "Shares" },
] as const satisfies readonly { key: InstagramMetric; label: string }[];

const countFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const timestampFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const count = (value: number | null | undefined) => metricValue(value) === null ? "—" : countFormat.format(value!);
const dateLabel = (date: string | null | undefined, time = false) => {
  if (!date || !Number.isFinite(Date.parse(date))) return "Not available";
  return (time ? timestampFormat : dateFormat).format(new Date(date));
};

export function AnalyticsIcon(props: { class?: string }) {
  return (
    <svg class={props.class} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 19V5m0 14h16M8 15v-4m5 4V7m5 8v-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function InstagramMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="1.6" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" />
    </svg>
  );
}

function PostDetails(props: { post: InstagramPost }) {
  const [error, setError] = createSignal<string | null>(null);
  const watchTime = () => {
    const value = metricValue(props.post.metrics.averageWatchTimeMs);
    return value === null ? "—" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / 1_000)} sec`;
  };
  const openPost = async () => {
    const url = instagramPermalink(props.post.permalink);
    if (!url) return;
    setError(null);
    try {
      await mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not open this post.");
    }
  };
  return (
    <div class="cutroom-analytics-detail">
      <div class="cutroom-analytics-detail-copy">
        <p class="cutroom-analytics-caption">{props.post.caption || "This post has no caption."}</p>
        <dl class="cutroom-analytics-detail-metrics">
          <div><dt>Accounts reached</dt><dd>{count(props.post.metrics.reach)}</dd></div>
          <div><dt>Average watch time</dt><dd>{watchTime()}</dd></div>
        </dl>
        <p class="cutroom-analytics-note">Post metrics last synced {dateLabel(props.post.syncedAt, true)}. A dash means Instagram did not provide a metric.</p>
        <Show when={instagramPermalink(props.post.permalink)}>
          <Button variant="secondary" onClick={() => void openPost()}>View on Instagram ↗</Button>
        </Show>
        <Show when={error()}><p class="cutroom-analytics-inline-error" role="alert">{error()}</p></Show>
      </div>
      <div class="cutroom-analytics-detail-chart">
        <h3>Views recorded over time</h3>
        <AnalyticsSparkline
          label="Lifetime post views"
          points={props.post.history.flatMap((point) => {
            const value = metricValue(point.metrics.views);
            return value === null ? [] : [{ date: point.syncedAt, value }];
          })}
          empty="View history starts with your first available measurement."
        />
        <p class="cutroom-analytics-note">Lifetime totals observed at each sync, not views earned that day.</p>
      </div>
    </div>
  );
}

export function DashboardAnalyticsView() {
  const navigate = useNavigate();
  const desktop = !!window.desktop;
  const [dashboard, setDashboard] = createSignal<InstagramDashboard | null>(null);
  const [loading, setLoading] = createSignal(desktop);
  const [syncing, setSyncing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [days, setDays] = createSignal(0);
  const [sort, setSort] = createSignal<PostSort>("views");
  const [ascending, setAscending] = createSignal(false);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const busy = () => loading() || syncing();
  const account = () => dashboard()?.account;
  const hasAccount = () => !!account() && dashboard()?.status !== "disconnected";
  const settings = () => navigate("/?dashboard=settings&section=instagram");
  const shownPosts = createMemo(() => filterPublishedPosts(dashboard()?.posts ?? [], days()));
  const sorted = createMemo(() => sortPosts(shownPosts(), sort(), ascending()));
  const mostViews = createMemo(() => Math.max(0, ...shownPosts().map((post) => metricValue(post.metrics.views) ?? 0)));
  const followerPoints = createMemo(() => (dashboard()?.followerHistory ?? []).map((point) => ({ date: point.syncedAt, value: point.followers })));
  const errorMessage = () => error() || dashboard()?.error;

  const load = async (sync = false) => {
    if (!desktop || syncing() || (sync && loading())) return;
    if (sync) setSyncing(true); else setLoading(true);
    setError(null);
    try {
      setDashboard(await mainBridge.call(sync ? MAIN_CHANNELS.INSTAGRAM_SYNC : MAIN_CHANNELS.INSTAGRAM_GET, undefined));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load Instagram analytics.");
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  };
  onMount(() => void load());

  const changeSort = (key: PostSort) => {
    if (sort() === key) setAscending(!ascending());
    else { setSort(key); setAscending(false); }
  };
  const direction = (key: PostSort) => sort() === key ? (ascending() ? "ascending" : "descending") : "none";

  return (
    <div class="cutroom-analytics-scroll">
      <div class="cutroom-analytics">
        <header class="cutroom-analytics-header">
          <div><p class="cutroom-analytics-eyebrow">Your audience</p><h1>Analytics</h1><p>See how your Instagram content performs.</p></div>
          <Show when={hasAccount()}>
            <div class="cutroom-analytics-header-actions">
              <Button variant="ghost" onClick={settings}>Manage connection</Button>
              <Button variant="secondary" disabled={busy() || dashboard()?.status !== "connected"} onClick={() => void load(true)}>
                <Show when={syncing()}><Icon name="spinner-loader" class="size-4 animate-spin" /></Show>
                {syncing() ? "Syncing…" : "Refresh stats"}
              </Button>
            </div>
          </Show>
        </header>

        <Show when={errorMessage()}>
          <div class="cutroom-analytics-error" role="alert">
            <div><strong>{hasAccount() ? "Some stats may be out of date" : "Could not load analytics"}</strong><p>{errorMessage()}</p></div>
            <Show when={dashboard()?.status === "reconnect_required"} fallback={
              <Button variant="secondary" disabled={busy()} onClick={() => void load(hasAccount() || dashboard()?.status === "connected" || dashboard()?.status === "unavailable")}>Retry</Button>
            }><Button variant="secondary" onClick={settings}>Reconnect Instagram</Button></Show>
          </div>
        </Show>

        <Switch>
          <Match when={!desktop}>
            <section class="cutroom-analytics-empty">
              <div class="cutroom-analytics-empty-icon"><AnalyticsIcon /></div>
              <h2>Open analytics in the desktop app</h2>
              <p>Your Instagram connection and saved statistics live in Cutroom on your Mac. They aren’t available in this browser preview.</p>
            </section>
          </Match>
          <Match when={dashboard()?.status === "unavailable" && !hasAccount()}>
            <section class="cutroom-analytics-empty">
              <div class="cutroom-analytics-empty-icon"><InstagramMark /></div>
              <h2>Instagram connection unavailable</h2>
              <p>Cutroom can’t access your secure Instagram connection. Check the connection message above, then open settings to reconnect.</p>
              <Button onClick={settings}>Manage connection</Button>
            </section>
          </Match>
          <Match when={loading() && !dashboard()}>
            <div class="cutroom-analytics-loading" role="status"><Icon name="spinner-loader" class="animate-spin" /><p>Loading Instagram analytics…</p></div>
          </Match>
          <Match when={!hasAccount()}>
            <section class="cutroom-analytics-empty">
              <div class="cutroom-analytics-empty-icon"><InstagramMark /></div>
              <span class="cutroom-analytics-badge">Instagram</span>
              <h2>Get to know what connects</h2>
              <p>Connect a Creator or Business account to compare your posts, see engagement, and track your audience as it grows.</p>
              <Button onClick={settings}>Connect Instagram</Button>
              <span class="cutroom-analytics-empty-footnote">Personal accounts don’t provide analytics through Instagram’s API.</span>
              <div class="cutroom-analytics-feature-list"><span>Post performance</span><span>Follower history</span><span>Saved locally</span></div>
            </section>
          </Match>
          <Match when={hasAccount()}>
            <div class="cutroom-analytics-account">
              <div class="cutroom-analytics-account-icon"><InstagramMark /></div>
              <div><strong>@{account()?.username}</strong><span>{dashboard()?.status === "reconnect_required" ? "Reconnect to update statistics" : "Instagram"} · {account()?.accountType.replaceAll("_", " ").toLowerCase()}</span></div>
              <span class="cutroom-analytics-last-sync">{dashboard()?.lastSyncedAt ? `Last synced ${dateLabel(dashboard()?.lastSyncedAt, true)}` : "No sync recorded yet"}</span>
            </div>

            <section class="cutroom-analytics-performance">
              <div class="cutroom-analytics-section-heading cutroom-analytics-filter-heading">
                <div><h2>Post performance</h2><p>Lifetime totals. Each point on a line is one post, from oldest to newest.</p></div>
                <label class="cutroom-analytics-filter">Published<select aria-label="Filter posts by publication date" value={days()} onChange={(event) => setDays(Number(event.currentTarget.value))}>
                  <option value="0">All loaded posts</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
                </select></label>
              </div>
              <div class="cutroom-analytics-metrics">
                <For each={SUMMARY_METRICS}>{(metric) => {
                  const summary = () => summarizeMetric(shownPosts(), metric.key);
                  const observations = createMemo(() => observedMetricTrend(shownPosts(), metric.key));
                  return <div class="cutroom-analytics-metric">
                    <span>{metric.label}<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 11 6 7l3 3 5-6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
                    <strong>{count(summary().value)}</strong>
                    <AnalyticsSparkline compact byPost points={postMetricPoints(shownPosts(), metric.key)} label={`Lifetime ${metric.label.toLowerCase()} by post, oldest to newest`} empty="No measurements yet" />
                    <small>{summary().measured === 0 ? "Not available" : `${summary().measured} of ${shownPosts().length} posts reporting`}</small>
                    <AnalyticsChange points={observations().points} context="since first shared sync" />
                  </div>;
                }}</For>
              </div>
              <p class="cutroom-analytics-coverage">
                Showing {shownPosts().length} of {dashboard()?.coverage.fetchedPosts ?? 0} loaded posts. Sync covers up to the latest {dashboard()?.coverage.limit ?? 25} posts{dashboard()?.coverage.hasMore ? "; older posts are not included" : ""}.
                {days() > 0 ? ` Filtered by publication in the last ${days()} days; metrics still include each post’s full lifetime.` : " Totals include only available measurements."}
              </p>

              <PublishingActivity posts={dashboard()?.posts ?? []} hasMore={dashboard()?.coverage.hasMore ?? false} />
              <InstagramComparison posts={dashboard()?.posts ?? []} />

              <section class="cutroom-analytics-audience">
                <div class="cutroom-analytics-audience-number"><span><i class="cutroom-analytics-live-dot" />Followers</span><strong>{count(account()?.followers)}</strong><p>Current account total</p><AnalyticsChange points={followerPoints()} context="since first recorded sync" /></div>
                <div class="cutroom-analytics-audience-chart">
                  <div class="cutroom-analytics-section-heading"><h2>Audience over time</h2><span>{followerPoints().length < 2 ? "First observation recorded" : "Recorded in Cutroom"}</span></div>
                  <AnalyticsSparkline label="Followers" points={followerPoints()} empty="Follower history will appear after your first measurement." />
                  <p class="cutroom-analytics-note">{followerPoints().length < 2 ? "Your starting point is saved. Refresh on another day to see your growth." : "Actual follower counts recorded at each sync. Earlier history is not backfilled."}</p>
                </div>
              </section>

              <div class="cutroom-analytics-section-heading cutroom-analytics-posts-heading"><h2>Your posts</h2><span>{shownPosts().length} loaded posts · select a post for details</span></div>

              <Show when={sorted().length > 0} fallback={
                <div class="cutroom-analytics-no-posts"><h3>{days() ? "No loaded posts in this period" : "No posts to show yet"}</h3><p>{days() ? "Try all loaded posts or refresh to check for newer content." : "Refresh after publishing to start comparing your content."}</p></div>
              }>
                <div class="cutroom-analytics-table-wrap">
                  <table class="cutroom-analytics-table">
                    <caption class="sr-only">Instagram posts and their latest lifetime metrics. Select a post to see details.</caption>
                    <thead><tr><th scope="col">Post</th><For each={SUMMARY_METRICS}>{(metric) => <th scope="col" aria-sort={direction(metric.key)}><button type="button" onClick={() => changeSort(metric.key)}>{metric.label}<span aria-hidden="true">{sort() === metric.key ? ascending() ? " ↑" : " ↓" : " ↕"}</span></button></th>}</For><th scope="col" aria-sort={direction("publishedAt")}><button type="button" onClick={() => changeSort("publishedAt")}>Published<span aria-hidden="true">{sort() === "publishedAt" ? ascending() ? " ↑" : " ↓" : " ↕"}</span></button></th></tr></thead>
                    <tbody><For each={sorted()}>{(post) => <>
                      <tr classList={{ "is-expanded": expanded() === post.id }}>
                        <th scope="row"><button type="button" class="cutroom-analytics-post" aria-expanded={expanded() === post.id} aria-controls={`instagram-post-${post.id}`} onClick={() => setExpanded(expanded() === post.id ? null : post.id)}>
                          <div class="cutroom-analytics-thumbnail"><Icon name="film-video-export" class="size-5" /><Show when={post.thumbnailUrl}><img src={post.thumbnailUrl!} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} /></Show></div>
                          <div><strong>{post.caption || "Untitled post"}</strong><span>{(post.mediaProductType || post.mediaType).replaceAll("_", " ").toLowerCase()} · {expanded() === post.id ? "Hide details" : "View details"}</span></div>
                        </button></th>
                        <For each={SUMMARY_METRICS}>{(metric) => <td title={metricValue(post.metrics[metric.key]) === null ? "Not provided by Instagram" : undefined}>
                          <div classList={{ "cutroom-analytics-view-value": metric.key === "views" }}>
                            <span>{count(post.metrics[metric.key])}</span>
                            <Show when={metric.key === "views" && metricValue(post.metrics.views) !== null && mostViews() > 0}><span class="cutroom-analytics-view-bar" aria-hidden="true"><i style={{ width: `${(post.metrics.views ?? 0) / mostViews() * 100}%` }} /></span></Show>
                          </div>
                        </td>}</For>
                        <td class="cutroom-analytics-published">{dateLabel(post.publishedAt)}</td>
                      </tr>
                      <Show when={expanded() === post.id}><tr class="cutroom-analytics-detail-row"><td colSpan={7}><div id={`instagram-post-${post.id}`}><PostDetails post={post} /></div></td></tr></Show>
                    </>}</For></tbody>
                  </table>
                </div>
              </Show>
              <p class="cutroom-analytics-note cutroom-analytics-table-note">— means unavailable, not zero. Reach is shown per post in its details; it isn’t added across posts because audiences can overlap.</p>
            </section>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
