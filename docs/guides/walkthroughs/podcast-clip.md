# Example: podcast clipping

Turn a long conversation into one or more self-contained shorts using local transcripts, waveform structure and sampled picture. Follow the requested number of clips, duration and format. Work in the existing project, and give each clip its own scene so an approved one stays available while you work on the next.

## 1. Brief

Write down the source, the number of clips and the length of each, the delivery format (usually 1080×1920), the audience and any steer, such as a topic to lean into, a guest to spotlight or a stretch to leave out. A viewer meets the clip without the rest of the episode, so it has to make sense on its own; put that in the brief as a requirement and test every candidate against it.

## 2. Get the source

Prefer the user's local file when there is one. For a page URL, `web_media_download` saves a direct media link, or the media a page declares, into the project. For a YouTube, Vimeo or other platform episode, `media_download` saves the upload into the project: audio alone by default, which is all the search below needs and a fraction of the size, or `kind: "video"` into `assets/footage/` once the picture is needed. A downloaded excerpt can start at a different offset than the episode's own timestamps; probe its duration and match identifiable words before mapping published times onto it. A probe alone cannot tell you the original offset.

## 3. Split the episode into windows

`transcribe` takes at most two hours per call and does not identify speakers. Work in windows by passing `start` and `end`: a windowed transcript already reports episode seconds (a word 4 s into a window from 1:30 is at 94 s), so use its times as they are and add nothing. The offset matters only for a separate excerpt file that starts at zero, such as a downloaded section of the episode: there a word at `t` in an unretimed excerpt cut from `B` sits at `B + t`. Choose the boundaries in this order:

1. **Chapter markers.** When the user gives chapters or show notes with timestamps, use them. They split the episode at topic changes, which is where clips start and end.
2. **Silences.** A `waveform` of the whole track shows the long pauses between exchanges; cut windows there so no sentence is split.
3. **Fixed windows.** Otherwise, 15 to 30 minutes each, overlapping by a minute so a moment that straddles a boundary survives.

Reuse an existing transcript when it covers the window.

## 4. Find candidates

Read each window for complete exchanges: a strong first line, one idea, and a payoff that lands without the minutes before it. Use [story selection](../../skills/uve-story-selection/SKILL.md) to compare them and to keep needed context; a great sentence may depend on the question before it. Keep one candidate table for the whole episode, in source seconds:

| # | Source in–out | Speaker | Self-contained | Opener (1–5) | Payoff line |
| --- | --- | --- | --- | --- | --- |
| 1 | 1291.6–1318.9 | Speaker B | yes | 4: opens on a number the audience won't expect | "So we shut the office for a month." |
| 2 | 2207.0–2241.3 | Speaker A | no, needs the earlier question | 3: clear claim, slow first words | "That's the part nobody budgets for." |
| 3 | 3902.4–3929.8 | Speaker B | yes | 5: a direct challenge to the viewer | "Try it for one week and count." |

Speaker labels are neutral (Speaker A, Speaker B) and come from the picture; local transcripts and `listen` do not identify voices, so never write a name the tools did not establish. Opener scores are editorial judgment with a reason, not predicted views. For N clips, pick the N strongest that don't overlap, preferring self-contained ones, and say why the others lost.

## 5. Lock the cut points

Transcribe a minute or so around each chosen moment, find the first word of the opener and the last word of the payoff, and confirm both edges with `listen` on a short window and a `waveform` of a few seconds with `silence: { "minSeconds": 0.12 }`. `grab` frames at important words, speaker changes and the ending, and read the adjacent exchange for qualifications or context the clip would lose.

## 6. Assemble the clip

The values are illustrative; use the probed dimensions and the locked range. The node keeps the source's aspect ratio and fills the vertical scene, so the scene crops it; sample the subject before choosing the horizontal position.

```tsx
const raw = "footage/episode-118.mp4";
const IN = 1291.6;  // first word of the opener
const OUT = 1318.9; // after the payoff's last word
const SOURCE_W = 1920;
const SOURCE_H = 1080;
const SCENE_W = 1080;
const SCENE_H = 1920;
const SCALE = Math.max(SCENE_W / SOURCE_W, SCENE_H / SOURCE_H);
const VIDEO_W = SOURCE_W * SCALE;
const VIDEO_H = SOURCE_H * SCALE;

export default function OfficeClip() {
  return (
    <stage>
      <scene id="clip-office" name="Clip: office month" width={SCENE_W} height={SCENE_H} active>
        <video src={raw} start={0} sourceIn={IN} sourceOut={OUT}
          width={VIDEO_W} height={VIDEO_H} x={(SCENE_W - VIDEO_W) / 2} y={(SCENE_H - VIDEO_H) / 2} />
      </scene>
    </stage>
  );
}
```

For internal cuts, follow [clean edit](../../skills/uve-clean-edit/SKILL.md). A conversation clip defaults to the `natural` profile, which keeps the rhythm between speakers; use `tight` when the clip is one speaker's answer and the brief wants it punchy. Inspect the scene with `transcript_edit_inspect` (`retakes: true` catches a guest restarting a sentence), cut with `transcript_edit_apply`, and keep a laugh, a meaningful breath or a reaction when it helps the exchange. Synchronize dependent tracks afterwards.

## 7. Frame the conversation

Use [social reframing](../../skills/uve-social-reframing/SKILL.md). Check each speaker turn against the picture. For a stable subject choose a stable crop; for a moving one, use deliberate sampled keyframes and inspect between them. For automated visible-speaker framing, use `reframe` with `mode: "speakers"`, then review its evidence coverage and wide fallback. Manually sampled crops alone do not establish active-speaker tracking.

Keyframes use source-local time. For the trimmed clip above, a crop change eight seconds into its visible portion belongs at `IN + 8` when the playback rate is one. Read [keyframes](../../reference/jsx/keyframes.md) before authoring the change. If a vertical crop loses a second speaker or an important object, use a wider or split layout rather than distort the footage.

## 8. Caption the edited result

Run `captions` with `{ "id": "clip-office" }` after the cut is stable. It transcribes the edited scene mix and saves scene-aligned words. Read the [captions tool reference](../../reference/tools/captions.md) before replacing an existing caption layout. The episode's own transcript cannot be mounted at timeline zero without aligning its source time to the retained range.

Review names and uncertain words, then use the preset from `editing_style`, or `classic` for a vertical clip (clean edit's caption default, which replaces the house style's `stark` for speech clips), placed clear of the speakers' faces. Capture representative phrases and the longest line to check placement over faces and other graphics. Follow [caption finishing](../../skills/uve-caption-finishing/SKILL.md) for timing and readability.

## 9. Review

Run `check` and inspect composed captures at the start, both sides of changed cuts, important caption lines and the last visible frame. Capture positions are relative to the workarea start, not the original recording. Use available audio review to judge joins and caption sync; state if audio was not reviewed. For several clips, repeat the review per scene and report the candidate table with the chosen rows marked. Export only when requested.
