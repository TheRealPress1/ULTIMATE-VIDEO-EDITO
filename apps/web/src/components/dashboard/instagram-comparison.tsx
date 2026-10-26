import { createMemo, createSignal, For, Show } from 'solid-js';
import type { InstagramPost } from '@desktop/instagram-types';
import { compareInstagramPosts, observedPostAgeHours } from './instagram-comparison-data';
const label = { views: 'Views', reach: 'Reach', likes: 'Likes', comments: 'Comments', saves: 'Saves', shares: 'Shares', averageWatchTimeMs: 'Average watch time (seconds)' };
const number = (value: number | null, watch = false) => value === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: watch ? 2 : 0 }).format(watch ? value / 1000 : value);
export function InstagramComparison(props: { posts: InstagramPost[] }) {
  const [firstId, setFirstId] = createSignal('');
  const [secondId, setSecondId] = createSignal('');
  const first = createMemo(() => props.posts.find((post) => post.id === firstId()) ?? props.posts[0]);
  const second = createMemo(() => props.posts.find((post) => post.id === secondId()) ?? props.posts.find((post) => post.id !== first()?.id));
  const rows = createMemo(() => first() && second() && first()!.id !== second()!.id ? compareInstagramPosts(first()!, second()!) : []);
  const title = (post: InstagramPost) => `${new Date(post.publishedAt).toLocaleDateString()} · ${post.caption.slice(0, 70) || post.id}`;
  return <section class="rounded-lg border border-border p-4 space-y-3" aria-label="Compare Instagram posts">
    <h2 class="font-medium">Compare two posts</h2>
    <p class="text-xs text-muted-foreground">Compare measured lifetime results to inform your next edit. Different post ages and audiences can explain differences; this is not an A/B experiment or proof that an editing choice caused growth.</p>
    <Show when={props.posts.length >= 2} fallback={<p class="text-sm text-muted-foreground">Sync at least two posts to compare their available measurements.</p>}>
      <div class="grid sm:grid-cols-2 gap-3"><For each={['first', 'second'] as const}>{(side) => <label class="block text-xs space-y-1">
        <span>{side === 'first' ? 'Baseline post' : 'Comparison post'}</span>
        <select value={side === 'first' ? first()?.id : second()?.id} onChange={(event) => (side === 'first' ? setFirstId : setSecondId)(event.currentTarget.value)} class="w-full rounded border border-border-input bg-background px-2 py-1.5">
          <For each={props.posts}>{(post) => <option value={post.id}>{title(post)}</option>}</For>
        </select>
      </label>}</For></div>
      <div class="grid sm:grid-cols-2 gap-3 text-xs text-muted-foreground"><For each={[first(), second()].filter((post): post is InstagramPost => !!post)}>{(post) => <p>Measured {new Date(post.syncedAt).toLocaleString()} · {observedPostAgeHours(post) === null ? 'post age unavailable' : `${Math.round(observedPostAgeHours(post)!)} hours after publication`}</p>}</For></div>
      <Show when={rows().length} fallback={<p class="text-sm">Choose two different posts.</p>}>
        <div class="overflow-x-auto"><table class="w-full text-xs text-right"><caption class="sr-only">Latest lifetime measurements for the selected Instagram posts</caption><thead><tr class="border-b border-border"><th class="text-left py-2" scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">Comparison</th><th scope="col">Difference</th></tr></thead><tbody>
          <For each={rows()}>{(row) => <tr class="border-b border-border/50"><th class="text-left py-2 font-normal" scope="row">{label[row.metric]}</th><td>{number(row.first, row.metric === 'averageWatchTimeMs')}</td><td>{number(row.second, row.metric === 'averageWatchTimeMs')}</td><td>{row.difference === null ? '—' : `${row.difference > 0 ? '+' : ''}${number(row.difference, row.metric === 'averageWatchTimeMs')}`}{row.percent !== null ? ` (${row.percent > 0 ? '+' : ''}${row.percent.toFixed(1)}%)` : ''}</td></tr>}</For>
        </tbody></table></div>
      </Show>
      <p class="text-xs text-muted-foreground">— means Instagram did not provide that measurement. Percentage differences are omitted when the baseline is zero. Only the currently synced posts are available.</p>
    </Show>
  </section>;
}
