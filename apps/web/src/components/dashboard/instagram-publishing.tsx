import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { InstagramAccount } from '@desktop/instagram-types';
import type { InstagramPublishItem, InstagramPublishQueue } from '@desktop/instagram-publishing-types';
import { mainBridge } from '@/lib/ipc';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from '../ui/dialog';

const displayTime = (value: string) => new Date(value).toLocaleString();
const inputStyle = 'w-full rounded border border-border-input bg-transparent px-2 py-1.5 text-sm focus-ring';

export function InstagramPublishing(props: { account: InstagramAccount | null | undefined }) {
  const [open, setOpen] = createSignal(false);
  const [queue, setQueue] = createSignal<InstagramPublishQueue>({ items: [], error: null });
  const [url, setUrl] = createSignal('');
  const [caption, setCaption] = createSignal('');
  const [time, setTime] = createSignal('');
  const [share, setShare] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [review, setReview] = createSignal<InstagramPublishItem>();
  let generation = 0;
  const refresh = async () => {
    const request = generation;
    try { const result = await mainBridge.call(MAIN_CHANNELS.INSTAGRAM_QUEUE_GET, undefined); if (request === generation) setQueue(result); }
    catch (cause) { if (request === generation) setError(cause instanceof Error ? cause.message : 'Could not load the publishing queue.'); }
  };
  createEffect(() => {
    if (!open()) return;
    generation++;
    void refresh();
    const timer = setInterval(() => { if (!busy()) void refresh(); }, 5000);
    onCleanup(() => { generation++; clearInterval(timer); setReview(undefined); });
  });
  const act = async (operation: () => Promise<InstagramPublishQueue>) => {
    if (busy()) return;
    const request = generation; setBusy(true); setError(undefined);
    try { const result = await operation(); if (request === generation) { setQueue(result); setReview(undefined); } }
    catch (cause) { if (request === generation) setError(cause instanceof Error ? cause.message : 'Could not update the publishing queue.'); }
    finally { setBusy(false); }
  };
  const create = async (event: SubmitEvent) => {
    event.preventDefault(); const account = props.account;
    if (!account) return;
    const scheduled = time() ? new Date(time()) : new Date();
    if (!Number.isFinite(scheduled.getTime())) { setError('Choose a valid publishing time.'); return; }
    await act(() => mainBridge.call(MAIN_CHANNELS.INSTAGRAM_QUEUE_CREATE, { accountId: account.id, videoUrl: url(), caption: caption(), scheduledAt: scheduled.toISOString(), shareToFeed: share() }));
  };
  const items = () => queue().items.filter((item) => !props.account || item.accountId === props.account.id).slice().reverse();
  return <>
    <Button variant="secondary" onClick={() => setOpen(true)}>Publishing queue</Button>
    <Dialog open={open()} onOpenChange={setOpen}>
      <DialogPortal><DialogContent class="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Instagram publishing queue</DialogTitle><DialogDescription>Prepare Reels, review the exact account and caption, then approve publishing. Keep UVE open and online for scheduled items.</DialogDescription></DialogHeader>
        <p class="text-xs text-muted-foreground">Instagram must fetch an already hosted, public HTTPS MP4/MOV. UVE does not upload your exports to a hosting service. Use a durable URL that remains available until publishing finishes. A developer connection needs <code>instagram_business_content_publish</code>.</p>
        <Show when={props.account} fallback={<p class="text-sm">Connect a Creator or Business account to prepare a publishing draft.</p>}>
          <form onSubmit={(event) => void create(event)} class="space-y-3 border border-border rounded-lg p-3">
            <p class="text-sm font-medium">New draft for @{props.account?.username}</p>
            <label class="block text-xs space-y-1"><span>Public video URL</span><input type="url" required value={url()} onInput={(event) => setUrl(event.currentTarget.value)} maxLength={4096} placeholder="https://your-host.example/export.mp4" class={inputStyle} /></label>
            <label class="block text-xs space-y-1"><span>Caption</span><textarea value={caption()} onInput={(event) => setCaption(event.currentTarget.value)} maxLength={2200} rows={3} class={inputStyle} /></label>
            <label class="block text-xs space-y-1"><span>Publish at (your local time; empty means after approval)</span><input type="datetime-local" value={time()} onInput={(event) => setTime(event.currentTarget.value)} class={inputStyle} /></label>
            <label class="flex gap-2 items-center text-xs"><input type="checkbox" checked={share()} onChange={(event) => setShare(event.currentTarget.checked)} />Also share to Instagram Feed</label>
            <Button type="submit" disabled={busy() || !url().trim()}>Save draft for review</Button>
          </form>
        </Show>
        <Show when={error() || queue().error}><p role="alert" class="text-sm text-destructive">{error() || queue().error}</p></Show>
        <Show when={review()}>{(row) => <div role="region" aria-label="Review Instagram publication" class="border border-amber-500/60 rounded-lg p-4 space-y-3">
          <h3 class="font-medium">Approve this public Reel?</h3>
          <dl class="text-sm space-y-1"><div><dt class="text-muted-foreground">Account</dt><dd>@{props.account?.username} · {row().accountId}</dd></div>
            <div><dt class="text-muted-foreground">Video</dt><dd class="break-all">{row().videoUrl}</dd></div><div><dt class="text-muted-foreground">Publish time</dt><dd>{displayTime(row().scheduledAt)}{Date.parse(row().scheduledAt) <= Date.now() ? ' · as soon as Instagram processes it' : ''}</dd></div>
            <div><dt class="text-muted-foreground">Caption</dt><dd class="whitespace-pre-wrap break-words">{row().caption || '(No caption)'}</dd></div><div><dt class="text-muted-foreground">Feed</dt><dd>{row().shareToFeed ? 'Also share to Feed' : 'Reels tab only'}</dd></div>
          </dl>
          <p class="text-xs text-muted-foreground">Approving allows UVE to send this video URL and caption to Instagram and publish automatically when due. Closed or offline apps can publish late after reopening; items more than 24 hours late stop for review. Cancel from the queue before publishing starts.</p>
          <div class="flex gap-2"><Button disabled={busy() || props.account?.id !== row().accountId} onClick={() => void act(() => mainBridge.call(MAIN_CHANNELS.INSTAGRAM_QUEUE_APPROVE, { id: row().id, revision: row().revision }))}>Approve and schedule</Button><Button variant="ghost" disabled={busy()} onClick={() => setReview(undefined)}>Back</Button></div>
        </div>}</Show>
        <div class="flex justify-between items-center"><h3 class="font-medium text-sm">Saved items</h3><Button variant="ghost" disabled={busy()} onClick={() => void refresh()}>Refresh</Button></div>
        <Show when={items().length} fallback={<p class="text-sm text-muted-foreground">No publishing drafts yet.</p>}>
          <div class="space-y-3"><For each={items()}>{(row) => <article class="border border-border rounded-lg p-3 space-y-2 text-sm">
            <div class="flex justify-between gap-2"><strong>{row.state.replaceAll('_', ' ')}</strong><span class="text-xs text-muted-foreground">{displayTime(row.scheduledAt)}</span></div>
            <p class="break-words whitespace-pre-wrap">{row.caption || '(No caption)'}</p>
            <p class="break-all text-xs text-muted-foreground">{row.videoUrl}</p>
            <Show when={row.mediaId}><p class="text-xs text-muted-foreground">Published media ID: {row.mediaId}</p></Show>
            <Show when={row.error}><p class="text-xs text-destructive">{row.error}</p></Show>
            <div class="flex flex-wrap gap-2">
              <Show when={row.state === 'draft'}><Button size="small" disabled={busy() || props.account?.id !== row.accountId} onClick={() => setReview({ ...row })}>Review and approve</Button></Show>
              <Show when={row.containerId && ['needs_review', 'processing'].includes(row.state)}><Button size="small" variant="outline" disabled={busy()} onClick={() => void act(() => mainBridge.call(MAIN_CHANNELS.INSTAGRAM_QUEUE_RECONCILE, { id: row.id }))}>Check Instagram status</Button></Show>
              <Show when={!['published', 'publishing', 'cancelled'].includes(row.state)}><Button size="small" variant="ghost" disabled={busy()} onClick={() => void act(() => mainBridge.call(MAIN_CHANNELS.INSTAGRAM_QUEUE_CANCEL, { id: row.id }))}>Cancel item</Button></Show>
              <Show when={['draft', 'published', 'cancelled', 'failed'].includes(row.state)}><Button size="small" variant="ghost" disabled={busy()} onClick={() => void act(() => mainBridge.call(MAIN_CHANNELS.INSTAGRAM_QUEUE_REMOVE, { id: row.id }))}>Remove from queue</Button></Show>
            </div>
          </article>}</For></div>
        </Show>
      </DialogContent></DialogPortal>
    </Dialog>
  </>;
}
