# Example: podcast clipping

Turn a longer conversation into a self-contained short using local transcripts, waveform structure, and sampled picture. Follow the user's requested duration and format. Work in the existing project; create a new scene variant when an approved edit should remain available.

## Find the moment

Record the source, audience, desired length, and topic in a short brief. Probe the recording and reuse an existing transcript when it is suitable. Otherwise use local `transcribe`. It accepts at most two hours per source and does not identify speakers. For a longer recording, prepare local excerpts within the limit, retain the original source offset for each, and overlap boundaries enough to avoid losing a sentence. A word at excerpt time `t` from an unretimed excerpt beginning at `B` belongs to original-source time `B + t`; do not add that offset twice.

Search for complete exchanges with a clear opening and payoff. Use the [story-selection skill](../../skills/uve-story-selection/SKILL.md) to compare candidates and preserve context. A compelling isolated sentence may still depend on the question that preceded it. Record source in/out points and the reason for selection; ratings are editorial judgment, not predicted views.

Use `waveform` near the candidate's boundaries and `grab` at important words, speaker changes, and the ending. Check the adjacent exchange for qualifications or context. Do not infer who spoke from a local transcript or claim to hear delivery from a frame. `listen` can return local speech evidence for a short source window; it does not diarize speakers or identify an active speaker.

For a page URL, use a user-provided local file or an available, authorized downloader. A downloaded excerpt can start at a different source offset than requested. Probe its duration and match identifiable content before mapping original timestamps into it; a probe alone cannot identify the original source offset.

## Assemble the selected range

The following values are illustrative. Replace them with the actual source dimensions and verified in/out points. The video keeps its aspect ratio and fills a vertical scene; sample the actual subject before deciding its horizontal position.

```tsx
const raw = "a-roll/podcast.mp4";
const IN = 66.4;
const OUT = 96.1;
const SOURCE_W = 1920;
const SOURCE_H = 1080;
const SCENE_W = 1080;
const SCENE_H = 1920;
const SCALE = Math.max(SCENE_W / SOURCE_W, SCENE_H / SOURCE_H);
const VIDEO_W = SOURCE_W * SCALE;
const VIDEO_H = SOURCE_H * SCALE;

export default function PodcastClip() {
  return (
    <stage camera={[0.25, 0, 0, 0.25, 235, 70]}>
      <scene id="podcast-clip" name="Podcast short" width={SCENE_W} height={SCENE_H} active>
        <sequence name="A-roll">
          <video src={raw} width={VIDEO_W} height={VIDEO_H}
            x={(SCENE_W - VIDEO_W) / 2} y={(SCENE_H - VIDEO_H) / 2}
            start={0} sourceIn={IN} sourceOut={OUT} />
        </sequence>
      </scene>
    </stage>
  );
}
```

Preserve full word attacks and tails with context-sensitive handles. A transcript timestamp is a starting estimate. Retain a laugh, meaningful breath, or reaction when it helps the exchange. Use [dialogue pacing](../../skills/uve-dialogue-pacing/SKILL.md) for internal cuts and synchronize all dependent tracks afterward.

## Frame the conversation

Use [social reframing](../../skills/uve-social-reframing/SKILL.md). Check each speaker turn against the picture. For a shot with a stable subject, choose a stable crop; for a moving subject, use deliberate sampled keyframes and inspect between them. For automated visible-speaker framing, use `reframe` with `mode: "speakers"`, then review its evidence coverage and wide fallback. Manually sampled crops alone do not establish active-speaker tracking.

Keyframes use source-local time. For the trimmed clip above, a crop change eight seconds into its visible portion belongs at `IN + 8` when playback rate is one. Read [keyframes](../../reference/jsx/keyframes.md) before authoring the change. If a vertical crop loses a second speaker or important object, use a wider or split layout rather than distort the footage.

## Caption the edited result

Run `captions` with `{ "id": "podcast-clip" }` after the cut is stable. It transcribes the edited scene mix and saves scene-aligned words. Read the [captions tool reference](../../reference/tools/captions.md) before replacing an existing caption layout. The original episode's transcript cannot be mounted at timeline zero without aligning its source time to the retained range.

Review names and uncertain words, then use a supported preset consistent with the creator's style. Capture representative phrases and the longest line to check placement over faces and other graphics. Follow [caption finishing](../../skills/uve-caption-finishing/SKILL.md) for timing and readability.

## Review

Run `check` and inspect composed captures at the start, both sides of changed cuts, important caption lines, and the last visible frame. Capture positions are relative to the workarea start, not the original recording. Use available audio review to judge joins and caption sync; state if audio was not reviewed. Export only when requested.
