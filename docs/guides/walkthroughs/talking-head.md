# Example: long-form talking head

Tighten an explainer, interview answer, or lesson while preserving the speaker's meaning and delivery. Use the requested duration and tone. A request to clean up an interview is not permission to change its argument or remove every pause.

## Understand the current cut

Read the project and brief, then probe relevant source recordings. Reuse transcripts or run local `transcribe` for the speech needed by the edit. The engine returns estimated source-relative word times; it does not choose takes or identify speakers. Inputs longer than two hours need local excerpts with recorded original-source offsets.

Use `waveform` around repeated passages and pauses, and `grab` to inspect relevant frames. A silent interval may be intentional pacing. A transcript gap may contain a reaction or meaningful non-speech audio. Compare takes for accuracy, delivery, picture, and continuity rather than always retaining the last take or the sharpest single frame.

Write the retained source ranges and reasons for substantial changes. Keep context and qualifications. For a simple tightening pass, preserve chronology unless the request supports restructuring. See [story selection](../../skills/uve-story-selection/SKILL.md) when a new narrative is requested.

## Lay out the A-roll

This rate-one example demonstrates timing only; replace its ranges and dimensions with verified values. A source range selects content, while `start` places that content on the sequence's timeline. The next start is the sum of earlier retained durations.

```tsx
import { For } from "solid-js";

const raw = "a-roll/take.mp4";
const takes = [
  { sourceIn: 48.2, sourceOut: 53.9 },
  { sourceIn: 61.7, sourceOut: 69.4 },
  { sourceIn: 74.0, sourceOut: 78.1 },
  { sourceIn: 95.2, sourceOut: 102.8 },
];
let cursor = 0;
const clips = takes.map((take) => {
  const start = cursor;
  cursor += take.sourceOut - take.sourceIn;
  return { ...take, start };
});

export default function TalkingHead() {
  return (
    <stage>
      <scene id="talking-head" name="Talking head" width={1920} height={1080} active>
        <sequence name="A-roll">
          <For each={clips}>
            {(clip) => (
              <video src={raw} width={1920} height={1080}
                start={clip.start} sourceIn={clip.sourceIn} sourceOut={clip.sourceOut} />
            )}
          </For>
        </sequence>
      </scene>
    </stage>
  );
}
```

Keep a retained pause inside the source footage or cover it intentionally. Do not create an accidental timeline gap and assume the sequence will hold the right frame. If playback rate differs from one, divide each retained source duration by its rate before calculating starts. Preserve IDs and unrelated composition elements when adapting an existing project.

## Tune the joins

Use [dialogue pacing](../../skills/uve-dialogue-pacing/SKILL.md). Leave enough source handles for consonants, tails, and the chosen rhythm; a fixed pause length is not appropriate for every sentence. Do not tighten a reflective answer to the same cadence as a fast tutorial. Keep a breath or reaction when it carries the performance.

Review each changed join in the surrounding sentence, including available audio playback. Frames reveal picture discontinuities but cannot prove a word was not clipped. Where audio review is unavailable, preserve conservative handles and report that limit. Add B-roll only when it supports the point or intentionally covers a visual discontinuity.

## Finish titles, sound, and captions

Follow the creator's approved style and the brief. A title is optional; choose its copy, duration, and location for the footage rather than force a template onto it. Keep text away from faces and important scene information. Use [motion graphics](../../skills/uve-motion-graphics/SKILL.md) for editable animation and [audio finishing](../../skills/uve-audio-finishing/SKILL.md) for gain and music balance.

After the timing is stable, run `captions` with `{ "id": "talking-head" }` for the edited mix. Review its text and alignment, then apply a supported preset. Source-file captions cannot follow a multi-cut timeline unless explicitly remapped. Existing reviewed transcripts or custom timed caption layers need reconciliation before regeneration; read the [caption tool reference](../../reference/tools/captions.md).

## Verify

Run `check`, then capture both sides of affected cuts, title transitions, representative caption lines, and the ending. Account for the workarea start when choosing capture times. Review the result against the brief and inspect actual images. Follow [final review](../../skills/uve-final-review/SKILL.md) and state material verification limits. Export only when requested.
