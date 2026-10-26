import { createSignal } from 'solid-js';
import { ReframeDialog } from './reframe-dialog';
import { TranscriptEditor } from './transcript-editor';
import { AudioFinishingDialog } from './audio-finishing-dialog';
import { QualityReviewDialog } from './quality-review-dialog';
import { ReferenceStyleDialog } from './reference-style-dialog';
import { Icon } from './ui/icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuTrigger } from './ui/dropdown-menu';

type Tool = 'reference' | 'reframe' | 'transcript' | 'audio' | 'review';

/** Dialogs stay mounted when the menu closes, preserving their work and cancellation lifecycle. */
export function EditorTools() {
  const [open, setOpen] = createSignal(false);
  const launchers: Partial<Record<Tool, () => void>> = {};
  let trigger: HTMLButtonElement | undefined;
  let launching = false;
  const launch = (tool: Tool) => {
    launching = true;
    setOpen(false);
    trigger?.focus();
    queueMicrotask(() => launchers[tool]?.());
  };
  const restoreFocus = (event: Event) => { event.preventDefault(); trigger?.focus(); };
  return <>
    <DropdownMenu open={open()} onOpenChange={setOpen} placement="bottom-end">
      <DropdownMenuTrigger ref={trigger} class="cutroom-editor-tools" aria-label="Edit tools">
        Edit tools <Icon name="chevron-down" class="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal><DropdownMenuContent class="w-60 gap-1" onCloseAutoFocus={(event) => {
        if (launching) { event.preventDefault(); launching = false; }
      }}>
        <DropdownMenuItem class="h-auto py-2" onSelect={() => launch('reference')}><span>Reference style<span class="block text-[11px] opacity-65">Give your edit the feel of another video</span></span></DropdownMenuItem>
        <DropdownMenuItem class="h-auto py-2" onSelect={() => launch('reframe')}><span>Reframe<span class="block text-[11px] opacity-65">Create vertical, square and landscape edits</span></span></DropdownMenuItem>
        <DropdownMenuItem class="h-auto py-2" onSelect={() => launch('transcript')}><span>Edit transcript<span class="block text-[11px] opacity-65">Cut and reorder the timeline by words</span></span></DropdownMenuItem>
        <DropdownMenuItem class="h-auto py-2" onSelect={() => launch('audio')}><span>Audio finish<span class="block text-[11px] opacity-65">Measure, level dialogue and duck music</span></span></DropdownMenuItem>
        <DropdownMenuItem class="h-auto py-2" onSelect={() => launch('review')}><span>Review<span class="block text-[11px] opacity-65">Check rendered frames and audio</span></span></DropdownMenuItem>
      </DropdownMenuContent></DropdownMenuPortal>
    </DropdownMenu>
    <ReferenceStyleDialog triggerRef={(show) => { launchers.reference = show; }} onCloseAutoFocus={restoreFocus} />
    <ReframeDialog triggerRef={(show) => { launchers.reframe = show; }} onCloseAutoFocus={restoreFocus} />
    <TranscriptEditor triggerRef={(show) => { launchers.transcript = show; }} onCloseAutoFocus={restoreFocus} />
    <AudioFinishingDialog triggerRef={(show) => { launchers.audio = show; }} onCloseAutoFocus={restoreFocus} />
    <QualityReviewDialog triggerRef={(show) => { launchers.review = show; }} onCloseAutoFocus={restoreFocus} />
  </>;
}
