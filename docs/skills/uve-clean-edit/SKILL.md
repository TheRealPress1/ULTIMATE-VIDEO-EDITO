---
name: uve-clean-edit
description: Cut talking-head, interview or podcast footage down to its best takes, removing retakes, false starts, fillers and dead air at a chosen pace (tight by default for short vertical talking heads), then caption it and verify every join. Use for a cleanup, a tight cut, retake removal or a captioned talking head; for a small fix, apply only the part that matters.
metadata:
  version: "1.0.0"
---

# Clean talking-head edit

The goal is the shortest version that still says everything the speaker meant, in complete words, at a deliberate pace. Everything here is a default: the brief and the user's request win over it. Technical authoring lives in the [editor guide](../editor.md). For a narrow correction, fix that part and verify it; don't recut the video, restyle captions or add media because this skill was loaded.

## Pick the pace first

Take the pace from the brief (`pace:` under `## Edit plan` in `brief.md`), then from `editing_style`, then from this default:

| Profile | Default for | Timing |
| --- | --- | --- |
| `tight` | Short vertical talking heads: 9:16, up to about three minutes | Cut to the audible start and end of speech. Add no lead-in, tail or breathing room; a pause stays only when it does work (a beat before a punchline, a reaction, a hard-won breath). |
| `natural` | Long interviews, podcasts, landscape explainers | Keep a breath at sentence ends, up to about 0.25 s, and close pauses inside sentences. |
| `reflective` | Emotional, personal or slow material, by request | Follow [dialogue pacing](../uve-dialogue-pacing/SKILL.md): handles and silences are part of the performance. |

Write the profile you chose into `## Edit plan` (`pace: tight`) so later passes and other agents use the same one. Never tighten by speeding speech up.

## Understand the material

`probe` the sources. For the current scene, read it with `transcript_edit_inspect`; for raw sources, `footage_index` then `footage_search`. Read the whole argument before cutting anything, and list the attempts at each idea: where each starts, how it ends, what it adds. When the brief has a script, compare the read against it (`script_read_compare` where available) instead of guessing which take is which line.

## Decide what is said

- Group attempts by meaning, not wording. Three phrasings of one point are three takes of one point.
- Keep the most complete, accurate and natural attempt. That is often the last one, but not always; an earlier take can have the better delivery or the fact the later one dropped.
- A pickup can replace the abandoned end of an earlier take only when grammar, meaning and sound all join cleanly. Never keep both the broken ending and its replacement.
- Repetition that builds (a list, a refrain, emphasis) stays; a restatement made while the speaker searches for words goes. If you can't tell, listen around it before cutting.
- Keep setup, qualifications, negations and transitions. Never splice words into a claim the speaker didn't make.

`transcript_edit_inspect` proposes candidates: `fillers`, quiet `silence` spans and, with `retakes: true`, `retake` attempts with the take it would keep and a `similarity` score. They are suggestions only. You decide by leaving time out of the ranges you pass to apply; read both sides of every retake before following it.

## Tight timing

Inspect with the profile's pause settings:

- `tight`: `pauses: { "minSeconds": 0.12, "keepSeconds": 0, "frameQuantize": true }`
- `natural`: `pauses: { "minSeconds": 0.2, "keepSeconds": 0.12 }`
- `reflective`: the defaults

With breath kept, a removal is the pause minus both kept sides, and no suggestion removes less than `minSeconds` (or 0.35 s, when `minSeconds` is longer). So `natural` brings pauses of about 0.45 s and up down to 0.24 s and leaves shorter ones alone: a cut of a few frames saves almost nothing and still shows as a jump. Check `pauseDetection`. If pauses you can see in the waveform are missing, set `thresholdDb` about 8 dB above `noiseFloorDb` and at least 15 dB under `speechDb`, then inspect again. Word times are estimates: confirm the edges of every changed word with `listen` on a short window, and read a `waveform` window about a second either side of each join with `silence: { "minSeconds": 0.12 }`. Frame-rounded removals only take whole quiet frames, so they protect the start and end of words without padding.

## Apply

For the current scene, `transcript_edit_apply` with the ranges to keep: one undo step, with a recovery version saved first. It takes up to 500 ranges; if a long recording needs more, keep the shortest pauses (each one kept joins two ranges) or split the recording into scenes first. For a new assembly from raw sources, `footage_cut`, then tighten that scene the same way. Rerun `transcript_edit_inspect` with the same settings afterwards and list every remaining pause longer than the profile allows; remove it or say why it stays.

## Captions

Run `captions` once the cut is final, so the words are read from the edited mix. Use the preset in `editing_style`; otherwise `classic` for 9:16 and `whisper` for 16:9. For talking-head, interview and podcast edits this overrides the [house style's caption rule](../../brand/design.md#captions) (`stark` for 9:16, `cascade` otherwise); the rest of the house style still applies. Set `verticalAlign="bottom"` so captions sit low, in the caption reserve below the face (see the [9:16 safe area](../../brand/design.md#916-text-safe-area)), and add no `offsetY` unless they still collide with something. Keep the speaker's casing. See [caption finishing](../uve-caption-finishing/SKILL.md).

## Extra media

- Add B-roll, music or sound effects only when they were provided for this edit or requested. Media in the library is not a request.
- Add no accents: no punch-ins, ornamental zoom moves, showy transitions or gags where the music drops out. A crop the delivery format needs is fine.
- Whatever fills the picture stays there for 0.4 s or more. Reading the layers from the top, every inserted shot is one stretch and so is every piece of the talking head between inserts; an insert edge that lands just after a cut leaves a flash of the speaker. Move that edge onto the cut itself, or 0.4 s or more away from it. A tight pass can leave the same flash with no insert at all: a short word kept between two removed pauses is a sliver of the head between two jumps. Keep the pause on one side so the word joins its neighbour, drop the word if it can go, or cover both cuts with one insert. `check` reports both as `short-visible-stretch`; run it after every timing change.

## Verify

1. `check` the scene: no `black-frames`, no `short-visible-stretch`, and a look at any layers listed as skipped.
2. Residual pauses: the rerun inspection from Apply, then `quality_review` with `audio: { "pauseThresholdDb": <about 8 dB above noiseFloorDb>, "minPauseSeconds": 0.25 }` for leftover gaps, clipping and clicks at joins (`audio-join`). Each pause is its own `audio-silence` finding. The review reads levels without the inspection's 80 Hz high-pass, so low rumble (air conditioning, traffic) reads louder there; if pauses the inspection found are missing, raise the threshold 5 dB at a time, staying well under `speechDb`.
3. `capture` each clip's opening frame and both sides of each changed join. A blink or motion blur on an opening frame means moving that cut one to three frames later.
4. Spot-check captions: the first line, the longest line and a line after each big cut.
5. You cannot hear the audio. Say so, and name the joins worth a listen.

## Report

List what changed (takes chosen, retakes and pickups, the pace profile and seconds removed), what remains ambiguous, and which joins were checked only by waveform and transcript.
