import { batch, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { Computed, FrameRate, getActiveEntity, Name, Root, setPlayhead, stopPlayback, togglePlayback } from '@diffusionstudio/runtime';
import type { Entity } from 'koota';
import { toast } from 'somoto';
import { useProject } from '@/context/project';
import { chatState } from '@/agent-chat/store';
import { applyTranscriptEdit, prepareTranscriptEdit, transcriptDraftRanges } from '@/engine/transcript-edit';
import type { TimelineRange, TranscriptEditSnapshot } from '@/engine/transcript-edit';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import type { EditorToolDialogProps } from './editor-tool-dialog';

/** Review words and quiet-pause suggestions before changing the current scene. */
export function TranscriptEditor(props: EditorToolDialogProps = {}) {
	const world = useWorld(), project = useProject();
	const [open, setOpen] = createSignal(false);
	const [scene, setScene] = createSignal<Entity>();
	const [sceneName, setSceneName] = createSignal('Scene');
	const [snapshot, setSnapshot] = createSignal<TranscriptEditSnapshot>();
	const [order, setOrder] = createSignal<string[]>([]);
	const [selectedWords, setSelectedWords] = createSignal<string[]>([]);
	const [removedWords, setRemovedWords] = createSignal<string[]>([]);
	const [removedSuggestions, setRemovedSuggestions] = createSignal<string[]>([]);
	const [busy, setBusy] = createSignal(false);
	const [progress, setProgress] = createSignal('');
	const [error, setError] = createSignal('');
	const [previewing, setPreviewing] = createSignal(false);
	let mounted = true;
	let controller: AbortController | undefined;
	let previewTimer: ReturnType<typeof setInterval> | undefined;
	let previewScene: Entity | undefined;
	const stopPreview = () => {
		if (previewTimer) clearInterval(previewTimer);
		previewTimer = undefined;
		if (previewScene?.isAlive()) stopPlayback(world, previewScene);
		previewScene = undefined;
		if (mounted) setPreviewing(false);
	};
	onCleanup(() => { mounted = false; controller?.abort(); stopPreview(); });
	const agentRunning = () => (chatState.lists[project.id()] ?? []).some((chat) => chat.status === 'running' || chat.status === 'waiting');
	const ranges = createMemo(() => {
		const current = snapshot();
		if (!current) return [];
		return transcriptDraftRanges(current, order(), removedWords(), removedSuggestions()).filter((range) => Math.round(range.end * current.frameRate) > Math.round(range.start * current.frameRate));
	});
	const duration = createMemo(() => {
		const fps = snapshot()?.frameRate ?? 30;
		return ranges().reduce((sum, range) => sum + Math.round(range.end * fps) - Math.round(range.start * fps), 0) / fps;
	});
	const dirty = createMemo(() => {
		const current = snapshot();
		return !!current && (!!removedWords().length || !!removedSuggestions().length || order().join(',') !== current.passages.map((item) => item.id).join(','));
	});
	const orderedPassages = createMemo(() => {
		const map = new Map(snapshot()?.passages.map((item) => [item.id, item]) ?? []);
		return order().flatMap((id) => map.has(id) ? [map.get(id)!] : []);
	});
	const words = createMemo(() => new Map(snapshot()?.words.map((word) => [word.id, word]) ?? []));
	const resetDraft = () => batch(() => {
		setOrder(snapshot()?.passages.map((item) => item.id) ?? []);
		setSelectedWords([]); setRemovedWords([]); setRemovedSuggestions([]); setError('');
	});
	const inspect = async (target: Entity, refreshTranscript = false) => {
		if (busy() || agentRunning()) return;
		const dir = project.dir(), root = world.get(Root);
		controller = new AbortController();
		const signal = controller.signal;
		setBusy(true); setError(''); setProgress('Reading the current timeline…'); stopPreview();
		const assertCurrent = () => {
			if (!mounted || project.dir() !== dir || world.get(Root) !== root || !target.isAlive()) throw new Error('The project changed. Open the transcript again.');
			if (agentRunning()) throw new Error('Wait for the agent to finish before editing the transcript.');
		};
		try {
			const value = await prepareTranscriptEdit(world, dir, target, { refreshTranscript, signal, assertCurrent, onProgress: (message) => { if (mounted) setProgress(message); } });
			assertCurrent();
			batch(() => { setSnapshot(value); setOrder(value.passages.map((item) => item.id)); setSelectedWords([]); setRemovedWords([]); setRemovedSuggestions([]); });
		} catch (cause) {
			if (mounted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally { if (mounted) { setBusy(false); setProgress(''); } controller = undefined; }
	};
	const show = () => {
		if (busy()) return;
		const target = getActiveEntity(world);
		batch(() => { setScene(target ?? undefined); setSceneName(target?.get(Name)?.value || 'Scene'); setSnapshot(undefined); setOrder([]); setError(''); setOpen(true); });
		if (!target) { setError('Select a scene on the canvas before editing its transcript.'); return; }
		void inspect(target);
	};
	const preview = (range: TimelineRange) => {
		const target = scene();
		if (!target?.isAlive() || busy()) return;
		stopPreview();
		const fps = world.get(FrameRate)?.value ?? 30;
		const start = Math.max(0, range.start - 0.2), end = Math.min(snapshot()?.duration ?? range.end, range.end + 0.2);
		stopPlayback(world, target); setPlayhead(world, target, Math.round(start * fps)); togglePlayback(world, target);
		previewScene = target; setPreviewing(true);
		previewTimer = setInterval(() => {
			if (!mounted || !target.isAlive() || (target.get(Computed)?.localTime ?? 0) / fps >= end) stopPreview();
		}, 50);
	};
	const move = (id: string, delta: number) => setOrder((current) => {
		const index = current.indexOf(id), target = index + delta;
		if (index < 0 || target < 0 || target >= current.length) return current;
		const next = [...current]; [next[index], next[target]] = [next[target]!, next[index]!]; return next;
	});
	const toggleWord = (id: string) => {
		if (removedWords().includes(id)) { setRemovedWords((current) => current.filter((item) => item !== id)); return; }
		setSelectedWords((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
	};
	const apply = async () => {
		const target = scene(), current = snapshot();
		if (!target || !current || busy() || agentRunning() || !dirty() || !ranges().length) return;
		const dir = project.dir(), root = world.get(Root);
		controller = new AbortController(); const signal = controller.signal;
		setBusy(true); setError(''); setProgress('Checking your edit…'); stopPreview();
		try {
			const result = await applyTranscriptEdit(world, dir, target, current.revision, ranges(), {
				signal,
				assertCurrent: () => { if (!mounted || project.dir() !== dir || world.get(Root) !== root) throw new Error('The project changed.'); if (agentRunning()) throw new Error('An agent started editing. Wait for it to finish.'); },
				onProgress: (message) => { if (mounted) setProgress(message); },
			});
			if (mounted) { setOpen(false); setSnapshot(undefined); toast.success('Timeline edited', { description: `${result.previousDuration.toFixed(1)}s → ${result.duration.toFixed(1)}s. One Undo restores the previous edit; a named recovery version is also saved.` }); }
		} catch (cause) { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (mounted) { setBusy(false); setProgress(''); } controller = undefined; }
	};

	props.triggerRef?.(show);
	return <>
		<Show when={!props.triggerRef}><button type="button" class="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={show}>Edit transcript</button></Show>
		<Dialog open={open()} onOpenChange={(value) => { if (!busy()) { setOpen(value); if (!value) stopPreview(); } }}>
			<DialogPortal><DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl" showCloseButton={!busy()} onCloseAutoFocus={props.onCloseAutoFocus}>
				<DialogHeader><DialogTitle>Edit the current timeline by text</DialogTitle><DialogDescription>{sceneName()} · remove words or reorder passages, then review and apply.</DialogDescription></DialogHeader>
				<Show when={agentRunning()}><p class="text-sm text-amber-400">Wait for the agent to finish before editing the transcript.</p></Show>
				<Show when={error()}><div role="alert" class="rounded-md border border-red-400/30 bg-red-400/5 p-3 text-sm text-red-400">{error()}<Show when={!busy() && scene()}><button class="ml-2 underline" onClick={() => void inspect(scene()!)}>Reload transcript</button></Show></div></Show>
				<Show when={busy()}><p role="status" class="text-sm text-muted-foreground">{progress()}</p></Show>
				<Show when={snapshot()}>{(current) => <>
					<div class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-3">
						<p class="mr-auto text-sm tabular-nums"><strong>{current().duration.toFixed(1)}s → {duration().toFixed(1)}s</strong><span class="ml-2 text-muted-foreground">{ranges().length} retained passage{ranges().length === 1 ? '' : 's'}</span></p>
						<Button variant="secondary" disabled={busy() || !selectedWords().length} onClick={() => batch(() => { setRemovedWords((previous) => [...new Set([...previous, ...selectedWords()])]); setSelectedWords([]); })}>Remove {selectedWords().length || ''} selected word{selectedWords().length === 1 ? '' : 's'}</Button>
						<Button variant="outline" disabled={busy() || !dirty()} onClick={resetDraft}>Reset choices</Button>
					</div>
					<p class="text-xs text-muted-foreground">Click words to select them. Removed words appear crossed out; click one to keep it again. Listen plays the original moment with a little surrounding audio.</p>
					<div class="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_15rem]">
						<div class="max-h-[26rem] space-y-2 overflow-y-auto rounded-lg border p-2">
							<For each={orderedPassages()}>{(passage, index) => <article class="rounded-md border bg-background p-3">
								<div class="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><span class="mr-auto tabular-nums">{index() + 1}. {passage.start.toFixed(1)}–{passage.end.toFixed(1)}s</span><button disabled={busy()} class="hover:text-foreground" onClick={() => preview(passage)}>Listen</button><button disabled={busy() || index() === 0} aria-label={`Move passage ${index() + 1} up`} class="px-1 disabled:opacity-30" onClick={() => move(passage.id, -1)}>↑</button><button disabled={busy() || index() === order().length - 1} aria-label={`Move passage ${index() + 1} down`} class="px-1 disabled:opacity-30" onClick={() => move(passage.id, 1)}>↓</button><button disabled={busy()} class="hover:text-red-400" onClick={() => setOrder((items) => items.filter((id) => id !== passage.id))}>Remove passage</button></div>
								<p class="text-sm leading-7"><For each={passage.wordIds}>{(id) => <button type="button" disabled={busy()} title={`${words().get(id)?.start.toFixed(2)}s`} aria-pressed={selectedWords().includes(id)} class={`mr-1 rounded px-0.5 text-left ${removedWords().includes(id) ? 'text-muted-foreground line-through opacity-50' : selectedWords().includes(id) ? 'bg-emerald-500/25 text-emerald-200' : 'hover:bg-accent'}`} onClick={() => toggleWord(id)}>{words().get(id)?.text}</button>}</For></p>
							</article>}</For>
							<Show when={order().length < current().passages.length}><details class="p-2 text-xs text-muted-foreground"><summary class="cursor-pointer">Removed passages</summary><For each={current().passages.filter((item) => !order().includes(item.id))}>{(passage) => <div class="mt-2 flex gap-2"><p class="min-w-0 flex-1">{passage.text}</p><button class="shrink-0 underline" disabled={busy()} onClick={() => setOrder((items) => [...items, passage.id])}>Keep again</button></div>}</For></details></Show>
						</div>
						<aside class="max-h-[26rem] overflow-y-auto rounded-lg border p-3"><h3 class="text-sm font-semibold">Suggestions</h3><p class="mt-1 text-xs text-muted-foreground">Optional filler words and measured quiet pauses. Listen before removing.</p><Show when={current().suggestions.length} fallback={<p class="mt-3 text-xs text-muted-foreground">No conservative removal suggestions were found.</p>}><For each={current().suggestions}>{(suggestion) => <div class="mt-3 rounded-md border p-2"><label class="flex items-start gap-2 text-xs"><input type="checkbox" class="mt-0.5 accent-emerald-500" checked={removedSuggestions().includes(suggestion.id)} disabled={busy()} onChange={() => setRemovedSuggestions((items) => items.includes(suggestion.id) ? items.filter((id) => id !== suggestion.id) : [...items, suggestion.id])} /><span>Remove {suggestion.kind === 'filler' ? `“${suggestion.text}”` : suggestion.text}<span class="mt-1 block text-muted-foreground">{suggestion.start.toFixed(1)}–{suggestion.end.toFixed(1)}s</span></span></label><button class="mt-2 text-xs text-muted-foreground underline" disabled={busy()} onClick={() => preview(suggestion)}>Listen</button></div>}</For></Show></aside>
					</div>
					<Show when={current().warnings.length}><details class="rounded-md border border-amber-400/30 p-3 text-xs text-amber-300"><summary class="cursor-pointer">Transcript review notes</summary><For each={current().warnings}>{(warning) => <p class="mt-2">{warning}</p>}</For></details></Show>
					<div class="flex flex-wrap items-center gap-2"><p class="mr-auto text-xs text-muted-foreground">{current().transcriptSource === 'captions' ? 'Using current caption words and timing.' : 'Transcribed from the current edited audio.'}</p><Button variant="outline" disabled={busy() || agentRunning()} onClick={() => void inspect(scene()!, true)}>Transcribe current audio</Button><Show when={previewing()}><Button variant="outline" onClick={stopPreview}>Stop listening</Button></Show></div>
					<p class="text-xs text-muted-foreground">Applying changes this scene’s video, audio and captions together, resets its export range, and saves a recovery version. One Undo restores the previous timeline.</p>
				</>}</Show>
				<div class="flex justify-end gap-2"><Show when={busy()} fallback={<Button variant="secondary" onClick={() => { stopPreview(); setOpen(false); }}>Close</Button>}><Button variant="secondary" onClick={() => controller?.abort()}>Cancel operation</Button></Show><Button disabled={busy() || agentRunning() || !dirty() || !ranges().length} onClick={() => void apply()}>Apply timeline edit</Button></div>
			</DialogContent></DialogPortal>
		</Dialog>
	</>;
}
