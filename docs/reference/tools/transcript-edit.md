# Edit the current timeline by transcript

Choose **Edit transcript** in the editor header. The dialog works on the active scene. Existing scene-aligned caption words retain your manual corrections; choose **Transcribe current audio** if the edit changed after captioning. Without a caption layer, the app transcribes the edited audio locally into a temporary review, without adding a layer until you apply.

Click words to select them, then choose **Remove selected words**. Click a crossed-out word to keep it again. Passage cards can move up/down, be removed, or be restored from the removed list. Passage boundaries preserve the original leading footage, pauses and ending unless you explicitly remove them. Suggestions cover conservative filler tokens and measured quiet pauses outside recognized word intervals. **Listen** plays the original moment with surrounding audio; suggestions are never applied automatically.

The duration summary previews how much timeline remains. **Apply timeline edit** changes the current scene, rather than creating a second scene: every supported picture/audio/graphic layer is sliced across the same retained spans, and captions receive remapped timestamps. Existing source trims, playback speeds, volumes and source-time keyframes are retained. The export workarea resets to the edited scene. Original media and old transcript assets remain intact.

Before replacing layers, the app saves a named **Before transcript edit** project version. The complete composition change is one Undo step. Failed preparation, a stale scene/source, or canceled analysis leaves the composition untouched. If a final save fails after the edit exists, the error tells you to retry saving instead of applying again. A rare partial mutation failure names Undo and the saved recovery version explicitly.

## Agent tools

`transcript_edit_inspect` returns scene-time words, ordered passages, optional suggestions, and a revision tied to the exact inspected scene, media and suggestion settings. It paginates long transcripts with `wordOffset`, `wordLimit` (default 2,000; max 5,000), and `nextWordOffset`. Unchanged inspections reuse the local review; refresh transcription explicitly to replace caption-derived words.

```json
{ "id": "index.tsx:interview", "refreshTranscript": false, "wordOffset": 0, "wordLimit": 2000 }
```

### Suggestion settings

Inspection can tune what it proposes. Every setting is optional; the defaults are the ones the **Edit transcript** dialog uses.

| Field | Default | Meaning |
| --- | --- | --- |
| `pauses.minSeconds` | `0.5` | Shortest quiet stretch to look for (0.08–3 s). No suggestion removes less than this, or less than 0.35 s when this is longer (see below). |
| `pauses.keepSeconds` | `0.12` | Pause left beside the speech on each side of a removal (0–0.3 s). `0` cuts to the measured speech edge. |
| `pauses.thresholdDb` | measured | A fixed quiet level in dBFS (−70 to −20), as RMS over 10 ms windows after an 80 Hz high-pass. Omit it to let the mix set its own threshold. Sound opens above the level; a stretch counts as quiet once it falls 4 dB below. |
| `pauses.frameQuantize` | `true` | Shrink each removal to whole project frames, moving its start later and its end earlier, so only complete quiet frames are proposed. |
| `fillers` | `um, uh, erm, hmm, uhm` | Single words suggested as fillers, matched ignoring case and punctuation. A list replaces the defaults; `[]` turns filler suggestions off. At most 30. |
| `retakes` | `false` | Also propose earlier or abandoned attempts at a sentence. |

A tight talking-head pass looks like this:

```json
{ "id": "index.tsx:reel", "pauses": { "minSeconds": 0.12, "keepSeconds": 0, "frameQuantize": true }, "retakes": true }
```

Kept breath comes out of the pause, so a removal is shorter than the pause it sits in by up to twice `keepSeconds`. A removal also has to reach `minSeconds`, or 0.35 s when `minSeconds` is longer: a cut of a frame or two saves almost nothing and still shows as a jump. With the defaults, a pause needs about 0.6 s of quiet between words before 0.35 s of it is offered. With `keepSeconds: 0`, `minSeconds` is the shortest cut. Frame rounding comes after this check and can shorten a removal by up to a frame at each end.

The settings are folded into the returned `revision`. Inspecting again with different settings replaces the stored review, so an apply that still carries the earlier revision fails as expired. Changing only `fillers` or `retakes` reuses the transcript and the measured mix; a new pause setting measures the mix again but keeps the words.

`pauseDetection` reports what the pause search used: `mode` (`adaptive` or `fixed`), the settings, `appliedThresholdDb`, and the mix's `noiseFloorDb` (the level its quietest tenth stays under) and `speechDb` (the level all but its loudest twentieth stays under). To calibrate a fixed threshold, start a few dB above the noise floor and stay well under the speech level. `appliedThresholdDb` is null when the mix had too little contrast for a measured threshold; set one explicitly in that case. `pauseDetection` is null when the mix could not be analyzed, and `warnings` says why.

### Retake suggestions

With `retakes: true`, words are grouped into spoken sentences, split at sentence punctuation, at a dash or ellipsis that trails off, at pauses of 0.6 s or more, and where a sentence's first two words come round again without a pause ("I think, I think we should…"). Two attempts are linked when they fall within 30 s of each other and either share four words in a row and half their vocabulary, or the first trails off and the very next sentence starts on its first two words (either may open with a word or two more, such as "and so"). An attempt that trails off after the take it repeats is linked back to that take.

Linked attempts form a group. The last complete sentence of the group is proposed as the take to keep; when none is complete, the last attempt is. Every other attempt becomes a suggestion:

```json
{
  "id": "retake-word-212", "kind": "retake", "start": 84.31, "end": 86.02,
  "text": "So the reason we moved the office",
  "alternative": { "start": 87.4, "end": 91.86, "text": "So the reason we moved the studio was the light." },
  "similarity": 0.92,
  "note": "Earlier attempt; the later take is proposed. Compare both, since the earlier one can be the better read."
}
```

`similarity` (0–1) averages the attempts' word overlap with how much of the removed attempt reappears in the kept one. An attempt that trails off and is restarted scores high. The score is halved, which usually drops it below the 0.5 a link needs, when the two read as different lines rather than two tries at one:

- The removed attempt doesn't trail off, and after the words both open on it says nothing the kept one goes on to say. This covers parallel lines with new endings ("We will fight on the beaches. And we will fight on the landing grounds.", where a leading "and" or "so" is read past) and sentences that repeat their own opening ("It is what it is.").
- The removed attempt has three or more words in a row that the kept one never says, as when a pickup repeats only the end of a longer sentence. The opening the pickup leaves out stays, rather than the whole sentence being proposed for removal.

These checks look at wording only. A refrain, a list or a reworded claim can still be offered, and a real retake can be missed, so read both sides of every suggestion. The range covers the attempt's words only; the pauses around it are reported as separate silence suggestions.

These are candidates, not decisions. Nothing is removed unless you leave its time out of the ranges you pass to `transcript_edit_apply`. Read both attempts, listen where the choice is close, and keep the earlier one when it is the better read. Deliberate repetition, a corrected fact or a setup the later take drops can make a flagged attempt worth keeping.

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
