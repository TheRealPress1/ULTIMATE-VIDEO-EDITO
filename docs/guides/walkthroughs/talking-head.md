# Example: talking head

Clean up one speaker to camera: a vertical tip, an explainer, a lesson, an interview answer. The raw recording has restarts, flubbed lines and dead air; the edit keeps the best take of each idea, in complete words, at a deliberate pace. Pace and editorial rules come from [clean edit](../../skills/uve-clean-edit/SKILL.md). This page walks through the tools in order.

## 1. Brief and pace

Read the project's `brief.md` and the request. If neither sets a length or an editorial steer, cut nothing for content: every good passage stays, in its original order, and only retakes, false starts, fillers and dead air go. A cleanup is not permission to change the argument.

Choose the pace profile. A 9:16 talking head of up to about three minutes gets `tight` unless the brief or `editing_style` says otherwise; a long landscape interview or lesson usually gets `natural`; emotional material gets `reflective` and [dialogue pacing](../../skills/uve-dialogue-pacing/SKILL.md). Write it under `## Edit plan` as `pace: tight` so the next pass uses the same one.

## 2. Read the current cut

`probe` the source recordings. If the scene already holds the raw A-roll, inspect it with the profile's settings and retake suggestions:

```json
{ "id": "index.tsx:tip", "pauses": { "minSeconds": 0.12, "keepSeconds": 0, "frameQuantize": true }, "retakes": true }
```

`transcript_edit_inspect` returns scene-time words, passages and suggestions: fillers, quiet spans measured on the scene mix, and retakes, each with the attempt it would keep and a similarity score. Read the whole transcript before choosing. Retake suggestions group attempts that share wording; attempts that mean the same thing in different words are yours to spot. Compare each group for accuracy, delivery and picture, and keep the earlier take when it is better.

`pauseDetection` reports the noise floor and speech level of the mix. If pauses you can see in a `waveform` are missing from the suggestions, inspect again with `thresholdDb` about 8 dB above `noiseFloorDb`. A transcript gap can hold a laugh or a reaction worth keeping; the waveform shows signal there, a quiet span does not.

For raw sources that are not on a timeline yet, index them with `footage_index`, find each idea with `footage_search`, and assemble the chosen passages with `footage_cut`. Then inspect the new scene the same way.

## 3. Cut by transcript

Start from the passages, subtract the suggestions you agree with and any words you chose to drop, and pass what remains, in order, to `transcript_edit_apply` with the inspected revision:

```json
{
  "id": "index.tsx:tip",
  "revision": "<revision from the inspection above>",
  "ranges": [{ "start": 3.44, "end": 9.07 }, { "start": 11.9, "end": 18.26 }, { "start": 18.71, "end": 24.33 }]
}
```

Every supported track is cut together, captions are remapped, a recovery version is saved first, and the whole change is one undo step. The revision covers the inspection settings too: inspect again with other settings and the old revision is refused, so apply the ranges you built from the latest inspection.

## 4. Or lay out the A-roll by hand

When the edit needs JSX instead, for example to mix takes from several files, chain the kept source ranges back to back. The values below are illustrative; use verified word edges.

```tsx
import { For } from "solid-js";

const raw = "footage/tip-take-2.mov";
// Kept source ranges, in order.
const kept = [
  { sourceIn: 12.36, sourceOut: 17.08 }, // opener, third attempt
  { sourceIn: 21.5, sourceOut: 26.94 },  // point one
  { sourceIn: 31.12, sourceOut: 33.4 },  // pickup replacing a flubbed clause
  { sourceIn: 40.77, sourceOut: 47.3 },  // close, ending on the last word
];
let cursor = 0;
const clips = kept.map((range) => {
  const start = cursor;
  cursor += range.sourceOut - range.sourceIn;
  return { ...range, start };
});

export default function Tip() {
  return (
    <stage>
      <scene id="tip" name="Tip" width={1080} height={1920} active>
        <sequence name="Kept takes">
          <For each={clips}>
            {(clip) => (
              <video src={raw} start={clip.start} sourceIn={clip.sourceIn}
                sourceOut={clip.sourceOut} width={1080} height={1920} />
            )}
          </For>
        </sequence>
      </scene>
    </stage>
  );
}
```

Keep the sequence gapless. A rate other than one divides each source duration by the rate before the next start is computed. Preserve IDs and unrelated elements when adapting an existing project.

## 5. Tune the joins

In the `tight` profile, open on the audible start of the first word and end on the last word's tail, with no lead-in, trailing air or pause between sentences that isn't doing work. Frame-rounded removals take only whole quiet frames, which protects consonants without padding. Never speed speech up to make it shorter.

In `natural` and `reflective`, follow dialogue pacing: keep a short breath at sentence ends and the handles the delivery needs.

Either way, confirm word edges with `listen` on a short window around each changed join, and read a `waveform` of about a second either side with `silence: { "minSeconds": 0.12 }`.

## 6. Residual pauses

After applying, run `transcript_edit_inspect` again with the same settings. Every silence suggestion left is a pause the cut kept; remove it, or note why it stays. Then run `quality_review` with tighter audio thresholds to catch gaps, clipping and clicks at joins:

```json
{ "id": "index.tsx:tip", "audio": { "pauseThresholdDb": -48, "minPauseSeconds": 0.25 } }
```

Start the threshold about 8 dB above the inspection's `noiseFloorDb`; every residual pause comes back as its own `audio-silence` finding. The review measures levels without the inspection's 80 Hz high-pass, so low rumble from air conditioning or traffic reads louder here. If pauses the inspection found are missing, raise the threshold 5 dB at a time while it stays well under `speechDb`. An `audio-join` finding is a sample jump at a cut; listen there, and add a short fade only where it clicks.

## 7. A title for the thumbnail (optional)

When the first frame should work as a cover, add one native `<text>` line: no plate, band or box behind it. Place it beside or below the head, inside the 9:16 text safe area (x 64–900, y 200–1520 at 1080×1920, see the [house style](../../brand/design.md#916-text-safe-area)), and take its font and size from `editing_style`.

```tsx
<text start={0} end={1.8} x={80} y={1240} width={800}
  fontFamily="Inter" fontSize={84} fontWeight="bold" color="#FFFFFF">
  Stop practising for an hour
</text>
```

Start the captions where the title ends by giving the caption layer the same `start` and `sourceIn` (see [trimming captions](../../reference/jsx/captions.md#trimming)), here `start={1.8} sourceIn={1.8}`. Do this last: `transcript_edit_inspect` and `captions` both refuse a scene whose caption layer is trimmed, so remove the trim before cutting or captioning again.

## 8. Captions and sound

Once the cut is final, run `captions` with `{ "id": "index.tsx:tip" }` so the words come from the edited mix. Use the preset in `editing_style`; otherwise `classic` for 9:16 and `whisper` for 16:9, which for a talking head takes the place of the house style's `stark`/`cascade` default. Set `verticalAlign="bottom"` to keep it clear of the face, and add `offsetY` only where it still collides. Keep the speaker's casing. Review names and uncertain words with [caption finishing](../../skills/uve-caption-finishing/SKILL.md). Add music or sound only when provided or requested; see [audio finishing](../../skills/uve-audio-finishing/SKILL.md).

## 9. Verify

Run `check` on the scene. On a cut of many pieces it names gaps that no sampled frame would land on (`black-frames`), and flashes shorter than 0.4 s between two shots (`short-visible-stretch`), such as a B-roll edge just after a cut. With no B-roll, a tight pass can still leave one: a short word such as "So," kept between two removed pauses shows the head for a few frames between two jumps. Keep the pause on one side so the word joins its neighbour, cut the word if it adds nothing, or cover both cuts with one insert.

`capture` each clip's opening frame at its `start`, and both sides of each changed join. A blink or motion blur on an opening frame means moving that cut one to three frames later. Capture the title, a few caption lines and the last frame. Follow [final review](../../skills/uve-final-review/SKILL.md), say plainly that you did not hear the audio, and name the joins worth a listen. Export only when asked.
