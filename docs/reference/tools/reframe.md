# Create social format versions

`reframe` copies a scene into vertical (1080×1920), square (1080×1080), or landscape (1920×1080) compositions. The original scene, linked footage, audio, trims, playback speeds and caption timestamps remain intact. New scenes appear beside the originals, and all requested versions form one Undo step.

```json
{ "id": "index.tsx:interview", "formats": ["vertical", "square"], "mode": "speakers" }
```

Use **Reframe** in the editor for the same workflow. The first new scene opens for review. Crop motion is authored as ordinary `x`, `y`, and (for speaker framing) `scale` keyframe tracks, using the clip's source-time clock; you can adjust these in the timeline and inspector.

`speakers` uses the bundled local audio/video model to follow a supported visible speaker. It requires sustained evidence before switching, smooths movement, and holds briefly or fits the full source image when uncertain. Wide fallback can add letterboxing. It does not assign real identities or diarize off-camera voices. Existing full-frame x/y/scale crop tracks can be replaced in the new copy. Review the returned coverage, fallback seconds, warnings and actual playback. See [speaker framing](speaker-framing.md).

### Correct the framing

In **Speaker framing**, choose a default of Automatic, Follow left person, Follow right person, or Stay wide. Expand **Correct a time range** to set a different choice for part of the scene. **Hold previous framing** freezes the camera entering that range; a new shot resets it to the complete picture. After creation, **Adjust framing** keeps the settings so you can create a revised copy.

The same controls are available to the editing agent:

```json
{
  "id": "index.tsx:interview",
  "formats": ["vertical"],
  "mode": "speakers",
  "speakerFraming": {
    "preference": "auto",
    "overrides": [
      { "start": 2, "end": 4, "preference": "left" },
      { "start": 12, "end": 15, "preference": "wide" },
      { "start": 15, "end": 17, "preference": "hold" }
    ]
  }
}
```

Correction times use the edited scene's timeline, including leading gaps, trims, playback rates and sequence placement. Starts are inclusive and ends exclusive; ranges may touch but cannot overlap or extend past the scene. Up to 100 corrections are supported. Boundaries take effect on the first output frame at or after the entered time. Time-range corrections currently reject scenes containing transitions, whose overlap can show clips beyond their nominal timeline windows; use a whole-scene preference or remove transitions in a copy first. The engine maps each range to the relevant clip's source clock before writing camera keys. Left/right selects an anonymous face track by screen position within a shot and follows that track if people move; if the target disappears, it shows the full picture. These choices express editorial intent, not detected speech.

`speakerSummary` keeps model evidence separate from camera choices. `coverage` and `evidenceSeconds` count supported visible-speaker evidence. `heldSeconds` counts automatic close framing maintained through uncertain scores; `wideSeconds` counts full-picture decisions; `manualSeconds` counts explicit left/right/wide/hold choices. Manual wide time appears in both `wideSeconds` and `manualSeconds`, so those fields are not additive categories. `fallbackSeconds` is held plus wide time. Durations use edited scene seconds and are summed per clip, once across requested formats; simultaneous video clips can overlap in those totals.

### Other framing modes

`follow` analyzes sampled video frames on this Mac with the system face detector. It requires no uploaded footage or model download. It chooses a prominent face and favors continuity with nearby detections, smooths motion, briefly holds through missed detections, and resets at sampled shot changes. This is face following, not speaker recognition or general object tracking. Multiple people, occlusion, small faces and fast shot changes need review. No detected face produces a center crop and an explicit warning. Returned `faceCoverage` reports the average fraction of samples with a usable face, not a quality guarantee.

`center` performs a deterministic centered fill without analysis. Face and center modes uniformly scale the source to cover the new canvas; it never stretches the footage. Speaker and face modes support up to two source hours per clip and 100 clips. Analysis runs in bounded sections and saves completed sections locally for reuse after cancellation or restart. Source content, source clock, model and settings changes invalidate cached results. A repeated identical source range is analyzed once per request.

Caption presets and timestamps are preserved. Their boxes are scaled when necessary and placed inside conservative margins (8% on the sides, 18% below). These are composition guides, not permanent platform interface rules. Review long words and custom typography in the rendered result. Static titles and graphics fit uniformly into an inset representation of the original canvas and are flagged for review.

Supported scenes contain full-frame video clips (including aspect-fit clips and video-painted rectangles), sequences, audio, captions and static graphics. Custom crops, rotation, non-uniform transforms, other spatial animation, nested video layouts, and `syncTo` links require manual preparation. Speaker mode can replace supported full-frame position/scale tracks in the new scene; face and center modes retain the stricter original-transform requirements. Failures before insertion leave the document untouched. If the final save fails, the error explicitly says that complete versions exist and asks you to retry saving instead of creating duplicates.

The result lists each new scene ID, name and dimensions, with warnings to inspect. Use `capture` and playback to review those versions before exporting. This tool does not export or publish.
