---
name: uve-social-reframing
description: Adapt an existing edit to vertical, square, or landscape delivery with intentional crops, subject continuity, and readable captions.
metadata:
  version: "1.2.0"
---

# Social reframing

Use the requested output dimensions and destination. Preserve the existing version when producing another format: make a named scene variant and reuse the media. Do not stretch footage to fill a new aspect ratio or assume every source is 1920×1080.

For supported full-frame scenes, use [`reframe`](../../reference/tools/reframe.md) to create editable vertical, square or landscape scenes in one undoable operation. `mode: "speakers"` uses local audio/video evidence for visible-speaker framing, with editable position/scale tracks and a brief hold or full-image fit when uncertain. It does not assign real identities or diarize off-camera voices. `mode: "follow"` analyzes faces locally and writes crop keyframes; `mode: "center"` makes a steady center crop. Inspect returned warnings and sample coverage. A prominent face is not necessarily the speaker, and sampled cut hints do not locate every cut exactly. Keep the original scene available for comparison and manual reframing of unsupported layouts.

When automatic framing misses a turn, use `speakerFraming` in speakers mode to set a default `auto`, `left`, `right` or `wide`, plus non-overlapping scene-time `overrides` with `start`, `end` and `preference` (`hold` is also available per range). These are edited scene seconds, after trims, speed changes and sequence placement; the engine maps them to source keyframes. Prefer a narrowly scoped correction over forcing a person for the whole scene. Left/right selects an anonymous track by screen position within a shot, then follows it; a missing target falls back wide. Hold freezes the previous camera and resets wide at cuts. Explicit choices are editorial intent and must not be described as higher model confidence. Review the corrected interval, its entry/exit, caption visibility and any cuts.

Probe source dimensions, then sample frames at shot changes, speaker changes, gestures, and motion extremes. A center crop is only a candidate. Preserve the subject, eyeline, meaningful objects, and any existing on-screen text. If a crop cannot retain the story, choose a wider composition, split layout, or deliberate padding instead of hiding the missing content.

For fill, use uniform scale `max(outputWidth / sourceWidth, outputHeight / sourceHeight)`; the scaled source may extend beyond the scene. Position it from observed subject coordinates. For fit, use `min(...)` and design the remaining space intentionally. Read [video properties](../../reference/jsx/video.md) and [keyframes](../../reference/jsx/keyframes.md) before animating a crop.

Use shot-based positions or a few deliberate keyframes. Sample-based framing does not imply automatic face, speaker, or object tracking. Only claim tracking when a working tracking tool has actually produced a usable result. Reframe on visual evidence; a transcript alone cannot identify who is on screen.

Reposition captions and titles for the new canvas, respecting supplied safe-area guidance. Platform interfaces and placements change; do not present one universal margin as a permanent platform rule. Keep important text comfortably inside the canvas and verify against any supplied destination preview.

Capture the first and last visible frame of each affected shot, motion extremes, and key text moments. Check both fit and attention at delivery size. Keep export separate unless requested, and list the variants created with their dimensions.
