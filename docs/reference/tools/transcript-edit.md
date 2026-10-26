# Edit the current timeline by transcript

Choose **Edit transcript** in the editor header. The dialog works on the active scene. Existing scene-aligned caption words retain your manual corrections; choose **Transcribe current audio** if the edit changed after captioning. Without a caption layer, the app transcribes the edited audio locally into a temporary review, without adding a layer until you apply.

Click words to select them, then choose **Remove selected words**. Click a crossed-out word to keep it again. Passage cards can move up/down, be removed, or be restored from the removed list. Passage boundaries preserve the original leading footage, pauses and ending unless you explicitly remove them. Suggestions cover conservative filler tokens and measured quiet pauses outside recognized word intervals. **Listen** plays the original moment with surrounding audio; suggestions are never applied automatically.

The duration summary previews how much timeline remains. **Apply timeline edit** changes the current scene, rather than creating a second scene: every supported picture/audio/graphic layer is sliced across the same retained spans, and captions receive remapped timestamps. Existing source trims, playback speeds, volumes and source-time keyframes are retained. The export workarea resets to the edited scene. Original media and old transcript assets remain intact.

Before replacing layers, the app saves a named **Before transcript edit** project version. The complete composition change is one Undo step. Failed preparation, a stale scene/source, or canceled analysis leaves the composition untouched. If a final save fails after the edit exists, the error tells you to retry saving instead of applying again. A rare partial mutation failure names Undo and the saved recovery version explicitly.

## Agent tools

`transcript_edit_inspect` returns scene-time words, ordered passages, optional suggestions, and a revision tied to the exact inspected scene/media. It paginates long transcripts with `wordOffset`, `wordLimit` (default 2,000; max 5,000), and `nextWordOffset`. Unchanged inspections reuse the local review; refresh transcription explicitly to replace caption-derived words.

```json
{ "id": "index.tsx:interview", "refreshTranscript": false, "wordOffset": 0, "wordLimit": 2000 }
```

`transcript_edit_apply` takes the exact revision and the scene-time ranges to **keep**, in the requested output order. Omitted time disappears from all supported tracks. Ranges cannot overlap or repeat; inspect and listen before cutting around overlapping speech.

```json
{
  "id": "index.tsx:interview",
  "revision": "<64-character revision returned by inspection>",
  "ranges": [{ "start": 12, "end": 20 }, { "start": 0, "end": 8 }]
}
```

The result identifies the unchanged scene ID, previous/new duration, caption asset and recovery checkpoint. Neither tool exports or publishes.

## Supported scenes and limits

- Local scenes up to one hour and 100,000 transcript words.
- Direct video/audio/image/static graphic layers, video-painted rectangles, and simple sequences. Multiple tracks are cut together.
- One optional scene-aligned caption layer. Reconcile timed/multiple captions first.
- Source-time keyframes remain aligned; preset clip animations, transitions, audio sync links, custom rendering, groups and sequences with their own trim/speed/mix settings require manual preparation.
- Up to 500 kept ranges and 2,000 resulting clip pieces. Selections snap to the project frame grid.
- Quiet-pause analysis uses the actual rendered scene mix. If that analysis fails while existing captions are usable, the UI reports the failure and offers no fabricated silence suggestions.

Current captions do not contain proof that they match the latest audio edits. Their reuse is explicitly identified in the dialog; transcribe again after manual timing changes. Speech recognition, word boundaries and quiet-audio classification require listening and review.
